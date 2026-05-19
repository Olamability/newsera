/**
 * Phase F — Canary health evaluator (Phase E debt #3).
 *
 * The existing `canaryController` uses a binary degradation threshold —
 * either the probe says `degraded` or it doesn't. That is too coarse to
 * trust for the live rollout in Phase F: a small notification failure
 * blip would either roll back unnecessarily or be hidden behind a healthy
 * latency reading.
 *
 * `canaryHealthEvaluator` is a pure-compute scoring function that takes
 * the six required input signals, applies weighted normalisation, and
 * returns:
 *
 *   - a numeric health score in [0..1] (1 = perfectly healthy)
 *   - one of HEALTHY / DEGRADED / CRITICAL
 *   - a rollback confidence score in [0..1]
 *   - a per-signal breakdown so the dashboard can show which signal
 *     dragged the rollout down
 *
 * Callers wire the result into the existing `HealthProbe` contract used
 * by `canaryController` so rollout governance becomes weighted without
 * any change to the controller itself.
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O. Tests drive it with literal inputs.
 *   - BOUNDED. All inputs are clamped to safe ranges; missing inputs are
 *     treated as neutral (score 1.0 contribution, 0 weight).
 *   - DETERMINISTIC. Same input → same output. No clocks, no randomness.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CanaryHealthInputs {
  /** Queue p95 latency in ms (any/aggregate). */
  queueLatencyMs?: number;
  /** Worker crash rate as a fraction of registered workers per minute. */
  workerCrashRate?: number;
  /**
   * Ratio of recent error rate to baseline. 1.0 = baseline, 2.0 = double.
   */
  errorSpikeRatio?: number;
  /** Notification failure as a fraction [0..1]. */
  notificationFailurePct?: number;
  /** DB p95 latency in ms. */
  dbLatencyMs?: number;
  /** Age (in ms) of personalization cache. Higher = staler. */
  personalizationFreshnessMs?: number;
}

export type CanaryClassification = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export interface CanaryHealthBreakdown {
  signal: keyof CanaryHealthInputs;
  /** Per-signal score in [0..1]. 1 = healthy. */
  score: number;
  /** Weight contributed to the composite score. */
  weight: number;
  raw: number | undefined;
  contribution: number;
}

export interface CanaryHealthResult {
  /** Composite health score, [0..1]. */
  score: number;
  classification: CanaryClassification;
  /**
   * Confidence that a rollback is the correct action, in [0..1]. 0 means
   * "absolutely do not roll back", 1 means "roll back to internal stage
   * immediately". Computed from the gap between the score and the
   * thresholds plus the number of signals contributing to the drop.
   */
  rollbackConfidence: number;
  /** Per-signal contributions for the dashboard. */
  breakdown: CanaryHealthBreakdown[];
  /** Short reason string for logs. */
  reason: string;
  /** Number of signals that contributed scoring (i.e., were provided). */
  presentSignalCount: number;
}

export interface CanaryHealthThresholds {
  /** score >= healthyAt → HEALTHY. Default 0.85. */
  healthyAt?: number;
  /** score < criticalAt → CRITICAL. Default 0.45. */
  criticalAt?: number;
}

export interface SignalConfig {
  /**
   * Healthy threshold below which `score` = 1. Above this the signal degrades
   * linearly until it hits the breakpoint.
   */
  healthy: number;
  /** At/above this value the signal contributes a score of 0. */
  breakpoint: number;
  /** Weight in the composite score. */
  weight: number;
  /**
   * If true the signal is "higher is worse" (e.g., latency). Default true.
   * For "higher is better" signals (none currently used), the inversion is
   * handled at the caller's normalisation step.
   */
  higherIsWorse?: boolean;
}

export interface CanaryHealthEvaluatorOptions {
  thresholds?: CanaryHealthThresholds;
  signals?: Partial<Record<keyof CanaryHealthInputs, Partial<SignalConfig>>>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SIGNALS: Record<keyof CanaryHealthInputs, SignalConfig> = {
  queueLatencyMs:           { healthy: 500,     breakpoint: 3_000,   weight: 2.0, higherIsWorse: true },
  workerCrashRate:          { healthy: 0,       breakpoint: 0.10,    weight: 2.0, higherIsWorse: true },
  errorSpikeRatio:          { healthy: 1.0,     breakpoint: 4.0,     weight: 2.0, higherIsWorse: true },
  notificationFailurePct:   { healthy: 0.02,    breakpoint: 0.25,    weight: 1.5, higherIsWorse: true },
  dbLatencyMs:              { healthy: 50,      breakpoint: 500,     weight: 1.5, higherIsWorse: true },
  personalizationFreshnessMs:{ healthy: 5 * 60_000, breakpoint: 60 * 60_000, weight: 1.0, higherIsWorse: true },
};

const DEFAULT_HEALTHY_AT = 0.85;
const DEFAULT_CRITICAL_AT = 0.45;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function scoreSignal(value: number, cfg: SignalConfig): number {
  // higherIsWorse: at <= healthy → 1; at >= breakpoint → 0; linear in-between.
  if (cfg.breakpoint <= cfg.healthy) return value <= cfg.healthy ? 1 : 0;
  if (value <= cfg.healthy) return 1;
  if (value >= cfg.breakpoint) return 0;
  const range = cfg.breakpoint - cfg.healthy;
  return clamp(1 - (value - cfg.healthy) / range, 0, 1);
}

export function evaluateCanaryHealth(
  inputs: CanaryHealthInputs,
  opts: CanaryHealthEvaluatorOptions = {},
): CanaryHealthResult {
  const healthyAt = opts.thresholds?.healthyAt ?? DEFAULT_HEALTHY_AT;
  const criticalAt = opts.thresholds?.criticalAt ?? DEFAULT_CRITICAL_AT;

  const breakdown: CanaryHealthBreakdown[] = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let present = 0;
  const degradedSignals: string[] = [];

  (Object.keys(DEFAULT_SIGNALS) as Array<keyof CanaryHealthInputs>).forEach((key) => {
    const baseCfg = DEFAULT_SIGNALS[key];
    const cfg: SignalConfig = { ...baseCfg, ...(opts.signals?.[key] ?? {}) };
    const raw = inputs[key];
    if (raw === undefined || raw === null || !Number.isFinite(raw)) {
      breakdown.push({ signal: key, score: 1, weight: 0, raw: undefined, contribution: 0 });
      return;
    }
    const score = scoreSignal(raw as number, cfg);
    const contribution = score * cfg.weight;
    weightedSum += contribution;
    totalWeight += cfg.weight;
    present += 1;
    if (score < 0.7) degradedSignals.push(key);
    breakdown.push({ signal: key, score, weight: cfg.weight, raw, contribution });
  });

  // If no signals are present, default to healthy with low confidence.
  const composite = totalWeight > 0 ? weightedSum / totalWeight : 1;

  let classification: CanaryClassification;
  if (composite >= healthyAt) classification = 'HEALTHY';
  else if (composite < criticalAt) classification = 'CRITICAL';
  else classification = 'DEGRADED';

  // Rollback confidence: 0 when healthy; ramps with how far below criticalAt
  // we are, and how many signals are bad. CRITICAL > 1 signal → max confidence.
  let confidence = 0;
  if (classification === 'CRITICAL') {
    const distance = Math.max(0, criticalAt - composite) / Math.max(criticalAt, 1e-6);
    const breadth = clamp(degradedSignals.length / 3, 0, 1);
    confidence = clamp(0.6 + 0.3 * distance + 0.1 * breadth, 0.6, 1);
  } else if (classification === 'DEGRADED') {
    const window = Math.max(healthyAt - criticalAt, 1e-6);
    const distance = clamp((healthyAt - composite) / window, 0, 1);
    confidence = 0.25 * distance + (degradedSignals.length >= 2 ? 0.15 : 0);
  } else {
    confidence = 0;
  }

  const reason = classification === 'HEALTHY'
    ? 'composite_healthy'
    : `degraded_signals=${degradedSignals.join(',') || 'composite'}`;

  return {
    score: composite,
    classification,
    rollbackConfidence: clamp(confidence, 0, 1),
    breakdown,
    reason,
    presentSignalCount: present,
  };
}

/**
 * Convenience: map a `CanaryHealthResult` to the `HealthSnapshot` shape
 * the existing `canaryController` consumes.
 *
 * Mapping:
 *   HEALTHY  → status: 'healthy'
 *   DEGRADED → status: 'watching'   (controller holds at current stage)
 *   CRITICAL → status: 'degraded'   (controller increments rollback counter;
 *                                    two consecutive CRITICAL probes roll back)
 */
export function asCanaryProbeSnapshot(result: CanaryHealthResult): {
  status: 'healthy' | 'watching' | 'degraded';
  reason?: string;
  metrics?: Record<string, number>;
} {
  const metrics: Record<string, number> = {
    composite_score: Number(result.score.toFixed(3)),
    rollback_confidence: Number(result.rollbackConfidence.toFixed(3)),
    present_signal_count: result.presentSignalCount,
  };
  for (const b of result.breakdown) {
    if (b.raw !== undefined) metrics[`signal_${b.signal}`] = b.raw;
  }
  if (result.classification === 'HEALTHY') {
    return { status: 'healthy', reason: result.reason, metrics };
  }
  if (result.classification === 'DEGRADED') {
    return { status: 'watching', reason: result.reason, metrics };
  }
  return { status: 'degraded', reason: result.reason, metrics };
}
