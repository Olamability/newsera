/**
 * Phase F — Production telemetry validator.
 *
 * The observability surface has grown across phases. Before traffic is
 * cut over to live users we need a single check that confirms the
 * telemetry pipeline itself is healthy — that the dashboard isn't
 * silently broken, that counters aren't drifting, and that heartbeats
 * aren't dangling from workers that no longer exist.
 *
 * Checks (1:1 with the problem statement):
 *
 *   1. missing_metrics        — any required metric is absent
 *   2. stale_metrics          — a metric's `lastObservedAt` is older than its allowed age
 *   3. inconsistent_counters  — a counter went DOWN (counters are monotonic)
 *   4. broken_heartbeat_chain — heartbeat gaps exceed `maxHeartbeatGapMs`
 *   5. queue_drift            — reported depth disagrees with sampled depth
 *   6. dead_worker_references — a metric references a worker the coordinator marked dead
 *   7. malformed_profiler_windows — profiler bucket has count > capacity or invalid percentiles
 *
 * Outputs:
 *
 *   - `operational integrity score` in [0..1] where 1 = telemetry pipeline healthy
 *   - per-check finding with severity
 *
 * HARD RULES:
 *   - PURE COMPUTE. The host injects every input.
 *   - DETERMINISTIC. Same input → same output.
 *   - NEVER throws on malformed input — it surfaces a `malformed_*` finding.
 */

import type { QueueName } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MetricReading {
  name: string;
  /** Numeric value (or null if metric is missing). */
  value: number | null;
  lastObservedAt: Date | null;
  /** Max age before the metric is considered stale, in ms. */
  maxAgeMs: number;
  /** Whether this is a monotonic counter (so going down is a problem). */
  monotonic?: boolean;
  /** Previous value, for monotonic counter checks. */
  previousValue?: number;
}

export interface HeartbeatChain {
  workerId: string;
  observations: Array<{ at: Date }>;
  /** Largest tolerable gap between consecutive heartbeats. */
  maxGapMs: number;
}

export interface QueueDriftSample {
  queue: QueueName;
  reportedDepth: number;
  sampledDepth: number;
  /** Allowed absolute drift before flagging. */
  toleranceAbs: number;
  /** Allowed relative drift (0.1 = 10%). */
  toleranceRel: number;
}

export interface ProfilerWindow {
  name: string;
  count: number;
  capacity: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TelemetryValidatorInput {
  metrics: MetricReading[];
  heartbeats: HeartbeatChain[];
  queueDrift: QueueDriftSample[];
  /** Worker IDs the coordinator currently considers dead. */
  deadWorkerIds: string[];
  /** Metric → worker ID mapping for the dead-worker reference check. */
  workerReferencedMetrics: Array<{ metric: string; workerId: string }>;
  profilerWindows: ProfilerWindow[];
  /** Required metric names that MUST be present (will fire `missing_metric`). */
  requiredMetrics: string[];
  /** Wall clock to compare `lastObservedAt` against. */
  now: Date;
}

export type IntegrityCheck =
  | 'missing_metric'
  | 'stale_metric'
  | 'inconsistent_counter'
  | 'broken_heartbeat_chain'
  | 'queue_drift'
  | 'dead_worker_reference'
  | 'malformed_profiler_window';

export type IntegritySeverity = 'info' | 'warning' | 'critical';

export interface IntegrityFinding {
  check: IntegrityCheck;
  severity: IntegritySeverity;
  subject: string;
  detail: Record<string, unknown>;
}

export interface TelemetryValidationResult {
  /** Score in [0..1]; 1 = pipeline healthy, 0 = pipeline unusable. */
  integrityScore: number;
  findings: IntegrityFinding[];
  counts: Record<IntegrityCheck, number>;
  summary: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS: Record<IntegritySeverity, number> = {
  info: 0.02,
  warning: 0.10,
  critical: 0.25,
};

function emptyCounts(): Record<IntegrityCheck, number> {
  return {
    missing_metric: 0,
    stale_metric: 0,
    inconsistent_counter: 0,
    broken_heartbeat_chain: 0,
    queue_drift: 0,
    dead_worker_reference: 0,
    malformed_profiler_window: 0,
  };
}

export function validateTelemetry(input: TelemetryValidatorInput): TelemetryValidationResult {
  const findings: IntegrityFinding[] = [];
  const counts = emptyCounts();
  const nowMs = input.now.getTime();
  const metricByName = new Map<string, MetricReading>();
  for (const m of input.metrics) metricByName.set(m.name, m);

  // 1 / 2 / 3. metrics
  for (const required of input.requiredMetrics) {
    const m = metricByName.get(required);
    if (!m || m.value === null || m.value === undefined) {
      findings.push({
        check: 'missing_metric',
        severity: 'critical',
        subject: required,
        detail: { reason: 'absent_or_null' },
      });
      counts.missing_metric += 1;
    }
  }
  for (const m of input.metrics) {
    if (m.lastObservedAt && nowMs - m.lastObservedAt.getTime() > m.maxAgeMs) {
      findings.push({
        check: 'stale_metric',
        severity: 'warning',
        subject: m.name,
        detail: {
          age_ms: nowMs - m.lastObservedAt.getTime(),
          max_age_ms: m.maxAgeMs,
        },
      });
      counts.stale_metric += 1;
    }
    if (
      m.monotonic &&
      typeof m.value === 'number' &&
      typeof m.previousValue === 'number' &&
      m.value < m.previousValue
    ) {
      findings.push({
        check: 'inconsistent_counter',
        severity: 'critical',
        subject: m.name,
        detail: { value: m.value, previous_value: m.previousValue },
      });
      counts.inconsistent_counter += 1;
    }
  }

  // 4. broken_heartbeat_chain
  for (const chain of input.heartbeats) {
    if (chain.observations.length === 0) {
      findings.push({
        check: 'broken_heartbeat_chain',
        severity: 'warning',
        subject: chain.workerId,
        detail: { reason: 'no_observations' },
      });
      counts.broken_heartbeat_chain += 1;
      continue;
    }
    const sorted = chain.observations.slice().sort((a, b) => a.at.getTime() - b.at.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].at.getTime() - sorted[i - 1].at.getTime();
      if (gap > chain.maxGapMs) {
        findings.push({
          check: 'broken_heartbeat_chain',
          severity: 'warning',
          subject: chain.workerId,
          detail: { gap_ms: gap, max_gap_ms: chain.maxGapMs, position: i },
        });
        counts.broken_heartbeat_chain += 1;
        break;
      }
    }
    // Final gap to "now".
    const last = sorted[sorted.length - 1];
    const tail = nowMs - last.at.getTime();
    if (tail > chain.maxGapMs) {
      findings.push({
        check: 'broken_heartbeat_chain',
        severity: 'critical',
        subject: chain.workerId,
        detail: { tail_ms: tail, max_gap_ms: chain.maxGapMs },
      });
      counts.broken_heartbeat_chain += 1;
    }
  }

  // 5. queue_drift
  for (const s of input.queueDrift) {
    const diff = Math.abs(s.reportedDepth - s.sampledDepth);
    const denom = Math.max(1, s.sampledDepth);
    const rel = diff / denom;
    if (diff > s.toleranceAbs && rel > s.toleranceRel) {
      const severity: IntegritySeverity = rel > s.toleranceRel * 2 ? 'critical' : 'warning';
      findings.push({
        check: 'queue_drift',
        severity,
        subject: s.queue,
        detail: {
          reported: s.reportedDepth,
          sampled: s.sampledDepth,
          abs_diff: diff,
          rel_diff: rel,
          tolerance_abs: s.toleranceAbs,
          tolerance_rel: s.toleranceRel,
        },
      });
      counts.queue_drift += 1;
    }
  }

  // 6. dead_worker_reference
  const dead = new Set(input.deadWorkerIds);
  for (const ref of input.workerReferencedMetrics) {
    if (dead.has(ref.workerId)) {
      findings.push({
        check: 'dead_worker_reference',
        severity: 'warning',
        subject: ref.metric,
        detail: { worker_id: ref.workerId },
      });
      counts.dead_worker_reference += 1;
    }
  }

  // 7. malformed_profiler_window
  for (const w of input.profilerWindows) {
    if (w.count > w.capacity) {
      findings.push({
        check: 'malformed_profiler_window',
        severity: 'critical',
        subject: w.name,
        detail: { count: w.count, capacity: w.capacity },
      });
      counts.malformed_profiler_window += 1;
      continue;
    }
    if (!(w.p50 <= w.p95 && w.p95 <= w.p99)) {
      findings.push({
        check: 'malformed_profiler_window',
        severity: 'warning',
        subject: w.name,
        detail: { p50: w.p50, p95: w.p95, p99: w.p99 },
      });
      counts.malformed_profiler_window += 1;
    }
  }

  // Integrity score: start at 1, subtract per finding by severity weight, clamp.
  let score = 1;
  for (const f of findings) score -= SEVERITY_WEIGHTS[f.severity];
  score = Math.max(0, Math.min(1, score));

  const totalCritical = findings.filter((f) => f.severity === 'critical').length;
  const totalWarnings = findings.filter((f) => f.severity === 'warning').length;
  const summary = `score=${score.toFixed(2)} critical=${totalCritical} warnings=${totalWarnings} findings=${findings.length}`;

  return {
    integrityScore: score,
    findings,
    counts,
    summary,
  };
}
