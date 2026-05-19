/**
 * Phase F — Stabilization policy.
 *
 * Pure-compute governance layer that decides whether a rollout stage may
 * advance based on:
 *
 *   1. The minimum stabilization window for the feature (24h / 48h / 72h).
 *   2. Live operational signals — queue health, worker crash rate, DB
 *      pressure, notification delivery success, personalization freshness.
 *
 * The host (typically a runner driving `rolloutManager`) calls
 * `evaluate()` with a fresh `StabilizationSignals` snapshot. The result
 * tells the operator dashboard:
 *
 *   - whether the window has elapsed
 *   - whether any signals are blocking advancement
 *   - the remaining time before advancement may be requested
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O. The host injects every signal.
 *   - DETERMINISTIC. Same inputs → same output.
 *   - CONSERVATIVE. Missing signals are treated as "not enough evidence"
 *     and BLOCK advancement, rather than allow it by default.
 */

import type { RolloutFlag } from './rolloutManager';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StabilizationWindow {
  feature: RolloutFlag;
  /** Required stable duration before advancement is allowed. */
  windowMs: number;
}

export const DEFAULT_STABILIZATION_WINDOWS: ReadonlyArray<StabilizationWindow> = [
  { feature: 'queue_based_ingestion',         windowMs: 24 * 3_600_000 },
  { feature: 'ranking_v1',                    windowMs: 48 * 3_600_000 },
  { feature: 'personalization_v1',            windowMs: 72 * 3_600_000 },
  { feature: 'backend_notification_dispatch', windowMs: 72 * 3_600_000 },
];

export interface StabilizationSignals {
  /** Queue p95 latency in ms (across all queues). */
  queueLatencyMs?: number;
  /** Largest queue depth observed in the window. */
  queueDepthPeak?: number;
  /** Workers that crashed in the window. */
  workerCrashCount?: number;
  /** DB p95 latency in ms. */
  dbLatencyMs?: number;
  /** Notification delivery success rate as a fraction [0..1]. */
  notificationDeliverySuccess?: number;
  /** Age of personalization cache in ms (lower = fresher). */
  personalizationFreshnessMs?: number;
}

export interface StabilizationThresholds {
  maxQueueLatencyMs?: number;
  maxQueueDepthPeak?: number;
  maxWorkerCrashCount?: number;
  maxDbLatencyMs?: number;
  minNotificationDeliverySuccess?: number;
  maxPersonalizationFreshnessMs?: number;
}

export const DEFAULT_THRESHOLDS: Required<StabilizationThresholds> = {
  maxQueueLatencyMs: 2_000,
  maxQueueDepthPeak: 50_000,
  maxWorkerCrashCount: 3,
  maxDbLatencyMs: 300,
  minNotificationDeliverySuccess: 0.95,
  maxPersonalizationFreshnessMs: 30 * 60_000,
};

export interface StabilizationBlocker {
  signal: keyof StabilizationSignals;
  value: number | undefined;
  threshold: number;
  comparison: 'gt' | 'lt';
  reason: string;
}

export interface StabilizationEvaluation {
  feature: RolloutFlag;
  windowMs: number;
  /** ms since the feature entered STABILIZING (or null if it hasn't). */
  elapsedMs: number | null;
  /** ms remaining before the window is satisfied. 0 = window met. */
  remainingMs: number;
  windowSatisfied: boolean;
  signalsHealthy: boolean;
  blockers: StabilizationBlocker[];
  /** Final verdict: may the rollout manager call `markStable()`? */
  advancementAllowed: boolean;
  reason: string;
}

export interface StabilizationPolicy {
  windowFor(feature: RolloutFlag): number;
  evaluate(input: {
    feature: RolloutFlag;
    enteredStabilizationAt: Date | null;
    now: Date;
    signals: StabilizationSignals;
  }): StabilizationEvaluation;
  thresholds(): Required<StabilizationThresholds>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createStabilizationPolicy(opts: {
  windows?: ReadonlyArray<StabilizationWindow>;
  thresholds?: Partial<StabilizationThresholds>;
} = {}): StabilizationPolicy {
  const windowMap = new Map<RolloutFlag, number>();
  for (const w of opts.windows ?? DEFAULT_STABILIZATION_WINDOWS) {
    windowMap.set(w.feature, w.windowMs);
  }
  const thresholds: Required<StabilizationThresholds> = {
    ...DEFAULT_THRESHOLDS,
    ...(opts.thresholds ?? {}),
  };

  function windowFor(feature: RolloutFlag): number {
    return windowMap.get(feature) ?? DEFAULT_STABILIZATION_WINDOWS[0].windowMs;
  }

  function checkBlockers(signals: StabilizationSignals): StabilizationBlocker[] {
    const blockers: StabilizationBlocker[] = [];
    const requiredSignals: Array<keyof StabilizationSignals> = [
      'queueLatencyMs',
      'workerCrashCount',
      'dbLatencyMs',
      'notificationDeliverySuccess',
      'personalizationFreshnessMs',
    ];
    for (const sig of requiredSignals) {
      if (signals[sig] === undefined || !Number.isFinite(signals[sig] as number)) {
        blockers.push({
          signal: sig,
          value: undefined,
          threshold: NaN,
          comparison: 'gt',
          reason: 'missing_signal',
        });
      }
    }
    if (
      typeof signals.queueLatencyMs === 'number' &&
      signals.queueLatencyMs > thresholds.maxQueueLatencyMs
    ) {
      blockers.push({
        signal: 'queueLatencyMs',
        value: signals.queueLatencyMs,
        threshold: thresholds.maxQueueLatencyMs,
        comparison: 'gt',
        reason: 'queue_latency_high',
      });
    }
    if (
      typeof signals.queueDepthPeak === 'number' &&
      signals.queueDepthPeak > thresholds.maxQueueDepthPeak
    ) {
      blockers.push({
        signal: 'queueDepthPeak',
        value: signals.queueDepthPeak,
        threshold: thresholds.maxQueueDepthPeak,
        comparison: 'gt',
        reason: 'queue_depth_peak_high',
      });
    }
    if (
      typeof signals.workerCrashCount === 'number' &&
      signals.workerCrashCount > thresholds.maxWorkerCrashCount
    ) {
      blockers.push({
        signal: 'workerCrashCount',
        value: signals.workerCrashCount,
        threshold: thresholds.maxWorkerCrashCount,
        comparison: 'gt',
        reason: 'worker_crashes_above_threshold',
      });
    }
    if (typeof signals.dbLatencyMs === 'number' && signals.dbLatencyMs > thresholds.maxDbLatencyMs) {
      blockers.push({
        signal: 'dbLatencyMs',
        value: signals.dbLatencyMs,
        threshold: thresholds.maxDbLatencyMs,
        comparison: 'gt',
        reason: 'db_latency_high',
      });
    }
    if (
      typeof signals.notificationDeliverySuccess === 'number' &&
      signals.notificationDeliverySuccess < thresholds.minNotificationDeliverySuccess
    ) {
      blockers.push({
        signal: 'notificationDeliverySuccess',
        value: signals.notificationDeliverySuccess,
        threshold: thresholds.minNotificationDeliverySuccess,
        comparison: 'lt',
        reason: 'notification_delivery_below_threshold',
      });
    }
    if (
      typeof signals.personalizationFreshnessMs === 'number' &&
      signals.personalizationFreshnessMs > thresholds.maxPersonalizationFreshnessMs
    ) {
      blockers.push({
        signal: 'personalizationFreshnessMs',
        value: signals.personalizationFreshnessMs,
        threshold: thresholds.maxPersonalizationFreshnessMs,
        comparison: 'gt',
        reason: 'personalization_stale',
      });
    }
    return blockers;
  }

  function evaluate(input: {
    feature: RolloutFlag;
    enteredStabilizationAt: Date | null;
    now: Date;
    signals: StabilizationSignals;
  }): StabilizationEvaluation {
    const win = windowFor(input.feature);
    const elapsed = input.enteredStabilizationAt
      ? Math.max(0, input.now.getTime() - input.enteredStabilizationAt.getTime())
      : null;
    const remaining = elapsed === null ? win : Math.max(0, win - elapsed);
    const windowSatisfied = elapsed !== null && elapsed >= win;
    const blockers = checkBlockers(input.signals);
    const signalsHealthy = blockers.length === 0;
    const advancementAllowed = windowSatisfied && signalsHealthy;
    let reason = 'ok';
    if (!windowSatisfied) {
      reason = elapsed === null ? 'not_yet_stabilizing' : 'stabilization_window_pending';
    } else if (!signalsHealthy) {
      reason = `blocked_by:${blockers.map((b) => b.reason).join(',')}`;
    }
    return {
      feature: input.feature,
      windowMs: win,
      elapsedMs: elapsed,
      remainingMs: remaining,
      windowSatisfied,
      signalsHealthy,
      blockers,
      advancementAllowed,
      reason,
    };
  }

  return {
    windowFor,
    evaluate,
    thresholds: () => ({ ...thresholds }),
  };
}
