/**
 * Phase F — Real-time incident detector.
 *
 * Folds the live observability signals into a single incident stream.
 * Each detector takes a signal value, compares to threshold bands, and
 * if breached emits an `Incident` with severity INFO / WARNING / SEVERE
 * / CRITICAL.
 *
 * Integrations (the detector does NOT call them — the host wires the
 * actions):
 *
 *   - trafficGuard            (SEVERE+ engages emergency_throttle)
 *   - canaryController        (CRITICAL triggers rollback)
 *   - rolloutManager          (CRITICAL pauses the active rollout)
 *
 * Detectors (1:1 with the spec):
 *
 *   - queue_explosion             — depth × growth
 *   - worker_death_storm          — crash count in window
 *   - ingestion_stall             — ingestion throughput dropped to zero
 *   - notification_delivery_collapse — delivery success below threshold
 *   - ranking_freshness_degradation — last refresh too old
 *   - personalization_drift       — recompute lag too high
 *   - db_saturation_risk          — DB latency near saturation
 *
 * HARD RULES:
 *   - PURE COMPUTE. The host injects every signal.
 *   - BOUNDED MEMORY. Open incidents capped at `maxOpenIncidents`.
 *   - DEDUP. The same detector cannot emit a new incident more often
 *     than `dedupWindowMs` (default 60s) at the same severity.
 */

import type { QueueName } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Severity = 'INFO' | 'WARNING' | 'SEVERE' | 'CRITICAL';

export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  SEVERE: 2,
  CRITICAL: 3,
};

export type IncidentType =
  | 'queue_explosion'
  | 'worker_death_storm'
  | 'ingestion_stall'
  | 'notification_delivery_collapse'
  | 'ranking_freshness_degradation'
  | 'personalization_drift'
  | 'db_saturation_risk';

export interface Incident {
  id: string;
  type: IncidentType;
  severity: Severity;
  subsystem: string;
  reason: string;
  detail: Record<string, unknown>;
  detectedAt: Date;
  acknowledged: boolean;
  /** Recommended mitigation action (free-form, for the dashboard). */
  recommendedAction: string;
}

export interface DetectorSignals {
  queues?: Partial<Record<QueueName, { depth: number; growthDeltaPerMin: number }>>;
  workerCrashesInWindow?: number;
  workerCrashWindowMs?: number;
  ingestionItemsPerMin?: number;
  /** Notification delivery success in [0..1]. */
  notificationDeliverySuccess?: number;
  /** Age (ms) of the most recent ranking refresh. */
  rankingFreshnessAgeMs?: number;
  /** Time (ms) since the personalization batch last completed. */
  personalizationDriftMs?: number;
  /** DB p95 latency, ms. */
  dbLatencyMs?: number;
}

export interface IncidentDetectorOptions {
  /** Queue depth at which an explosion is suspected. Default 50_000. */
  queueExplosionDepth?: number;
  /** Queue growth/min at which an explosion is suspected. Default 1_000. */
  queueExplosionGrowth?: number;
  /** Worker crash threshold per window (window provided via signal). Default 3. */
  workerCrashThreshold?: number;
  /** Below this items/min ingestion is considered stalled. Default 1. */
  ingestionStallThreshold?: number;
  /** Notification delivery success below this is collapse. Default 0.6. */
  notificationCollapseThreshold?: number;
  /** Ranking freshness age above this is degraded. Default 30 min. */
  rankingFreshnessMaxMs?: number;
  /** Personalization drift above this triggers WARNING. Default 60 min. */
  personalizationDriftWarnMs?: number;
  /** DB latency at which we flag risk. Default 250. */
  dbLatencyWarnMs?: number;
  /** Max open incidents retained in memory. Default 200. */
  maxOpenIncidents?: number;
  /** Dedup window in ms. Default 60_000. */
  dedupWindowMs?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

export interface IncidentSnapshot {
  generatedAt: Date;
  open: Incident[];
  closed: Incident[];
  worstSeverity: Severity | null;
  counts: Record<Severity, number>;
}

export interface IncidentDetector {
  /** Run detection on a single signals snapshot. Returns newly emitted incidents. */
  evaluate(signals: DetectorSignals): Incident[];
  /** Acknowledge an open incident. */
  acknowledge(id: string): boolean;
  /** Mark an incident as closed (mitigated). */
  close(id: string): boolean;
  /** Snapshot for the operator dashboard. */
  snapshot(): IncidentSnapshot;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULTS: Required<Omit<IncidentDetectorOptions, 'now'>> & { now: () => number } = {
  queueExplosionDepth: 50_000,
  queueExplosionGrowth: 1_000,
  workerCrashThreshold: 3,
  ingestionStallThreshold: 1,
  notificationCollapseThreshold: 0.6,
  rankingFreshnessMaxMs: 30 * 60_000,
  personalizationDriftWarnMs: 60 * 60_000,
  dbLatencyWarnMs: 250,
  maxOpenIncidents: 200,
  dedupWindowMs: 60_000,
  now: () => Date.now(),
};

interface DedupKey {
  type: IncidentType;
  subsystem: string;
}

function dedupKeyOf(k: DedupKey): string {
  return `${k.type}:${k.subsystem}`;
}

export function createIncidentDetector(opts: IncidentDetectorOptions = {}): IncidentDetector {
  const cfg = { ...DEFAULTS, ...opts };
  const open: Incident[] = [];
  const closed: Incident[] = [];
  const lastEmitAt = new Map<string, { at: number; severity: Severity }>();
  let counter = 0;

  function nextId(): string {
    counter += 1;
    return `inc_${cfg.now().toString(36)}_${counter.toString(36)}`;
  }

  function shouldDedup(type: IncidentType, subsystem: string, severity: Severity): boolean {
    const key = dedupKeyOf({ type, subsystem });
    const prev = lastEmitAt.get(key);
    if (!prev) return false;
    const within = cfg.now() - prev.at < cfg.dedupWindowMs;
    return within && SEVERITY_RANK[prev.severity] >= SEVERITY_RANK[severity];
  }

  function emit(
    type: IncidentType,
    subsystem: string,
    severity: Severity,
    reason: string,
    detail: Record<string, unknown>,
    recommendedAction: string,
  ): Incident | null {
    if (shouldDedup(type, subsystem, severity)) return null;
    const inc: Incident = {
      id: nextId(),
      type,
      severity,
      subsystem,
      reason,
      detail,
      detectedAt: new Date(cfg.now()),
      acknowledged: false,
      recommendedAction,
    };
    open.unshift(inc);
    if (open.length > cfg.maxOpenIncidents) {
      const dropped = open.pop();
      if (dropped) closed.unshift({ ...dropped });
    }
    lastEmitAt.set(dedupKeyOf({ type, subsystem }), { at: cfg.now(), severity });
    return inc;
  }

  function evaluate(signals: DetectorSignals): Incident[] {
    const fired: Incident[] = [];

    // 1. queue_explosion
    if (signals.queues) {
      for (const [name, q] of Object.entries(signals.queues) as Array<[QueueName, { depth: number; growthDeltaPerMin: number }]>) {
        const depthBreached = q.depth >= cfg.queueExplosionDepth;
        const growthBreached = q.growthDeltaPerMin >= cfg.queueExplosionGrowth;
        if (depthBreached || growthBreached) {
          const severity: Severity =
            depthBreached && growthBreached
              ? 'CRITICAL'
              : depthBreached
                ? 'SEVERE'
                : 'WARNING';
          const inc = emit(
            'queue_explosion',
            `queue:${name}`,
            severity,
            depthBreached && growthBreached ? 'depth_and_growth_breach' : depthBreached ? 'depth_breach' : 'growth_breach',
            { depth: q.depth, growth_per_min: q.growthDeltaPerMin },
            'engage traffic_guard.emergency_throttle and review autoscaler recommendations',
          );
          if (inc) fired.push(inc);
        }
      }
    }

    // 2. worker_death_storm
    if (typeof signals.workerCrashesInWindow === 'number' && signals.workerCrashesInWindow >= cfg.workerCrashThreshold) {
      const severity: Severity = signals.workerCrashesInWindow >= cfg.workerCrashThreshold * 2 ? 'CRITICAL' : 'SEVERE';
      const inc = emit(
        'worker_death_storm',
        'workers',
        severity,
        'crash_threshold_exceeded',
        { crashes: signals.workerCrashesInWindow, window_ms: signals.workerCrashWindowMs ?? null },
        'invoke recoveryManager.workerStateRestore for each dead worker; pause active rollout',
      );
      if (inc) fired.push(inc);
    }

    // 3. ingestion_stall
    if (typeof signals.ingestionItemsPerMin === 'number' && signals.ingestionItemsPerMin < cfg.ingestionStallThreshold) {
      const inc = emit(
        'ingestion_stall',
        'ingestion',
        'SEVERE',
        'throughput_near_zero',
        { items_per_min: signals.ingestionItemsPerMin },
        'check rss-worker leases and feed source availability',
      );
      if (inc) fired.push(inc);
    }

    // 4. notification_delivery_collapse
    if (
      typeof signals.notificationDeliverySuccess === 'number' &&
      signals.notificationDeliverySuccess < cfg.notificationCollapseThreshold
    ) {
      const severity: Severity = signals.notificationDeliverySuccess < cfg.notificationCollapseThreshold / 2 ? 'CRITICAL' : 'SEVERE';
      const inc = emit(
        'notification_delivery_collapse',
        'notifications',
        severity,
        'delivery_success_below_threshold',
        {
          success: signals.notificationDeliverySuccess,
          threshold: cfg.notificationCollapseThreshold,
        },
        'flip traffic_guard.notification_kill_switch and rollback backend_notification_dispatch',
      );
      if (inc) fired.push(inc);
    }

    // 5. ranking_freshness_degradation
    if (typeof signals.rankingFreshnessAgeMs === 'number' && signals.rankingFreshnessAgeMs > cfg.rankingFreshnessMaxMs) {
      const severity: Severity = signals.rankingFreshnessAgeMs > cfg.rankingFreshnessMaxMs * 3 ? 'SEVERE' : 'WARNING';
      const inc = emit(
        'ranking_freshness_degradation',
        'ranking',
        severity,
        'ranking_freshness_age_high',
        { age_ms: signals.rankingFreshnessAgeMs, max_ms: cfg.rankingFreshnessMaxMs },
        'invoke recoveryManager.rankingRebuild for top categories',
      );
      if (inc) fired.push(inc);
    }

    // 6. personalization_drift
    if (typeof signals.personalizationDriftMs === 'number' && signals.personalizationDriftMs > cfg.personalizationDriftWarnMs) {
      const severity: Severity = signals.personalizationDriftMs > cfg.personalizationDriftWarnMs * 3 ? 'SEVERE' : 'WARNING';
      const inc = emit(
        'personalization_drift',
        'personalization',
        severity,
        'recompute_lag_high',
        { drift_ms: signals.personalizationDriftMs, threshold_ms: cfg.personalizationDriftWarnMs },
        'engage traffic_guard.ranking_degradation_mode and re-enqueue affinity recompute jobs',
      );
      if (inc) fired.push(inc);
    }

    // 7. db_saturation_risk
    if (typeof signals.dbLatencyMs === 'number' && signals.dbLatencyMs > cfg.dbLatencyWarnMs) {
      let severity: Severity = 'WARNING';
      if (signals.dbLatencyMs > cfg.dbLatencyWarnMs * 2) severity = 'SEVERE';
      if (signals.dbLatencyMs > cfg.dbLatencyWarnMs * 4) severity = 'CRITICAL';
      const inc = emit(
        'db_saturation_risk',
        'database',
        severity,
        'db_latency_high',
        { latency_ms: signals.dbLatencyMs, warn_ms: cfg.dbLatencyWarnMs },
        'reduce concurrency via traffic_guard.queue_freeze; investigate hot query plans',
      );
      if (inc) fired.push(inc);
    }

    return fired;
  }

  function acknowledge(id: string): boolean {
    const inc = open.find((x) => x.id === id);
    if (!inc) return false;
    inc.acknowledged = true;
    return true;
  }

  function close(id: string): boolean {
    const idx = open.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const [inc] = open.splice(idx, 1);
    closed.unshift(inc);
    if (closed.length > cfg.maxOpenIncidents) closed.pop();
    return true;
  }

  function snapshot(): IncidentSnapshot {
    const counts: Record<Severity, number> = { INFO: 0, WARNING: 0, SEVERE: 0, CRITICAL: 0 };
    let worst: Severity | null = null;
    for (const inc of open) {
      counts[inc.severity] += 1;
      if (worst === null || SEVERITY_RANK[inc.severity] > SEVERITY_RANK[worst]) {
        worst = inc.severity;
      }
    }
    return {
      generatedAt: new Date(cfg.now()),
      open: open.map((i) => ({ ...i, detail: { ...i.detail } })),
      closed: closed.slice(0, 100).map((i) => ({ ...i, detail: { ...i.detail } })),
      worstSeverity: worst,
      counts,
    };
  }

  return { evaluate, acknowledge, close, snapshot };
}
