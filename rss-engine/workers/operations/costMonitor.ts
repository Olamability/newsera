/**
 * Phase E — Cost monitor.
 *
 * Tracks the *unitless cost* of running NewsEra on the current Postgres-only
 * stack. The goal is not to invoice operators in cents — it is to give the
 * dashboard a single ratio per signal so the team can detect runaway growth
 * before it becomes a bill problem.
 *
 * Tracked dimensions:
 *
 *   - queueCost                — accumulated per-job weight (CPU minutes per
 *                                queue × job count over the observation
 *                                window).
 *   - notificationVolume       — pushes + inbox writes per minute.
 *   - ingestionBandwidth       — bytes pulled from upstream feeds per minute.
 *   - rankingRefreshFrequency  — refresh jobs per minute.
 *   - storageGrowthRate        — bytes added to bounded tables per hour.
 *   - cachePressure            — `cache_size / cache_size_budget`.
 *
 * For each dimension the operator may register `AlertThreshold`s. When a
 * dimension crosses a threshold the monitor emits a `cost_alert` log line
 * and returns the breach so a downstream dispatcher (Phase F) can route it.
 *
 * Design constraints:
 *   - PURE COMPUTE. No I/O. The runner injects sampled values; this module
 *     just rolls them up and compares to thresholds.
 *   - BOUNDED MEMORY. Windowed counters truncate to `windowMs`.
 *   - DETERMINISTIC. Same sequence of `record*()` calls always yields the
 *     same `summary()`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CostDimension =
  | 'queue_cost'
  | 'notification_volume'
  | 'ingestion_bandwidth'
  | 'ranking_refresh_frequency'
  | 'storage_growth_rate'
  | 'cache_pressure';

export interface AlertThreshold {
  dimension: CostDimension;
  /** Alert when value > threshold (warning) and > criticalThreshold (critical). */
  warnAt: number;
  criticalAt: number;
  unit: string;
}

export type AlertSeverity = 'warn' | 'critical';

export interface CostBreach {
  dimension: CostDimension;
  value: number;
  severity: AlertSeverity;
  threshold: AlertThreshold;
  observedAt: Date;
}

export interface CostSummary {
  /** Per-dimension current value (after windowing). */
  values: Record<CostDimension, number>;
  /** Per-dimension running totals (lifetime of the monitor). */
  lifetime: Record<CostDimension, number>;
  /** Active breaches detected at summary time. */
  breaches: CostBreach[];
  observedAt: Date;
}

export interface CostMonitorOptions {
  /** Window over which "per-minute" / "per-hour" values are computed. Default 5 min. */
  windowMs?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
  /** Initial thresholds. */
  thresholds?: ReadonlyArray<AlertThreshold>;
  /** Optional log sink for alert emission. */
  onAlert?: (breach: CostBreach) => void;
}

export interface CostMonitor {
  setThreshold(threshold: AlertThreshold): void;
  recordQueueCost(queue: string, jobs: number, avgLatencyMs: number): void;
  recordNotification(count: number): void;
  recordIngestionBytes(bytes: number): void;
  recordRankingRefresh(count: number): void;
  recordStorageGrowthBytes(bytes: number): void;
  recordCachePressure(usedBytes: number, budgetBytes: number): void;
  summary(): CostSummary;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 5 * 60_000;

interface Sample {
  ts: number;
  value: number;
}

interface Ring {
  samples: Sample[];
  lifetime: number;
}

function newRing(): Ring {
  return { samples: [], lifetime: 0 };
}

function pushSample(ring: Ring, value: number, ts: number, windowMs: number): void {
  ring.samples.push({ ts, value });
  ring.lifetime += value;
  // Drop expired samples.
  const cutoff = ts - windowMs;
  while (ring.samples.length > 0 && ring.samples[0].ts < cutoff) {
    ring.samples.shift();
  }
}

function ringSum(ring: Ring, ts: number, windowMs: number): number {
  const cutoff = ts - windowMs;
  let sum = 0;
  for (const s of ring.samples) {
    if (s.ts >= cutoff) sum += s.value;
  }
  return sum;
}

function ringLatest(ring: Ring): number {
  return ring.samples.length > 0 ? ring.samples[ring.samples.length - 1].value : 0;
}

function ratePerMinute(ring: Ring, ts: number, windowMs: number): number {
  const sum = ringSum(ring, ts, windowMs);
  const minutes = windowMs / 60_000;
  return minutes > 0 ? sum / minutes : 0;
}

function ratePerHour(ring: Ring, ts: number, windowMs: number): number {
  const sum = ringSum(ring, ts, windowMs);
  const hours = windowMs / 3_600_000;
  return hours > 0 ? sum / hours : 0;
}

export function createCostMonitor(opts: CostMonitorOptions = {}): CostMonitor {
  const windowMs = Math.max(opts.windowMs ?? DEFAULT_WINDOW_MS, 30_000);
  const now = opts.now ?? (() => Date.now());
  const onAlert = opts.onAlert;
  const thresholds = new Map<CostDimension, AlertThreshold>();
  for (const t of opts.thresholds ?? []) thresholds.set(t.dimension, t);

  // Per-dimension rings. `queue_cost` is stored as accumulated weight units.
  const rings: Record<CostDimension, Ring> = {
    queue_cost: newRing(),
    notification_volume: newRing(),
    ingestion_bandwidth: newRing(),
    ranking_refresh_frequency: newRing(),
    storage_growth_rate: newRing(),
    cache_pressure: newRing(),
  };

  function setThreshold(threshold: AlertThreshold): void {
    thresholds.set(threshold.dimension, threshold);
  }

  function recordQueueCost(_queue: string, jobs: number, avgLatencyMs: number): void {
    // Cost unit = jobs × (latency / 1000s). Cheap proxy for CPU-minutes.
    const cost = Math.max(0, jobs) * Math.max(0, avgLatencyMs) / 1000;
    pushSample(rings.queue_cost, cost, now(), windowMs);
  }
  function recordNotification(count: number): void {
    pushSample(rings.notification_volume, Math.max(0, count), now(), windowMs);
  }
  function recordIngestionBytes(bytes: number): void {
    pushSample(rings.ingestion_bandwidth, Math.max(0, bytes), now(), windowMs);
  }
  function recordRankingRefresh(count: number): void {
    pushSample(rings.ranking_refresh_frequency, Math.max(0, count), now(), windowMs);
  }
  function recordStorageGrowthBytes(bytes: number): void {
    pushSample(rings.storage_growth_rate, Math.max(0, bytes), now(), windowMs);
  }
  function recordCachePressure(usedBytes: number, budgetBytes: number): void {
    const pressure = budgetBytes > 0 ? Math.max(0, usedBytes) / budgetBytes : 0;
    pushSample(rings.cache_pressure, pressure, now(), windowMs);
  }

  function evaluateBreaches(values: Record<CostDimension, number>, ts: number): CostBreach[] {
    const breaches: CostBreach[] = [];
    for (const [dimension, threshold] of thresholds) {
      const v = values[dimension];
      let severity: AlertSeverity | null = null;
      if (v >= threshold.criticalAt) severity = 'critical';
      else if (v >= threshold.warnAt) severity = 'warn';
      if (severity) {
        const breach: CostBreach = {
          dimension,
          value: v,
          severity,
          threshold,
          observedAt: new Date(ts),
        };
        breaches.push(breach);
        if (onAlert) {
          try {
            onAlert(breach);
          } catch {
            // never let an alert handler crash the monitor
          }
        }
      }
    }
    return breaches;
  }

  function summary(): CostSummary {
    const ts = now();
    const values: Record<CostDimension, number> = {
      queue_cost: ringSum(rings.queue_cost, ts, windowMs),
      notification_volume: ratePerMinute(rings.notification_volume, ts, windowMs),
      ingestion_bandwidth: ratePerMinute(rings.ingestion_bandwidth, ts, windowMs),
      ranking_refresh_frequency: ratePerMinute(rings.ranking_refresh_frequency, ts, windowMs),
      storage_growth_rate: ratePerHour(rings.storage_growth_rate, ts, windowMs),
      cache_pressure: ringLatest(rings.cache_pressure),
    };
    const lifetime: Record<CostDimension, number> = {
      queue_cost: rings.queue_cost.lifetime,
      notification_volume: rings.notification_volume.lifetime,
      ingestion_bandwidth: rings.ingestion_bandwidth.lifetime,
      ranking_refresh_frequency: rings.ranking_refresh_frequency.lifetime,
      storage_growth_rate: rings.storage_growth_rate.lifetime,
      cache_pressure: rings.cache_pressure.lifetime,
    };
    const breaches = evaluateBreaches(values, ts);
    return {
      values,
      lifetime,
      breaches,
      observedAt: new Date(ts),
    };
  }

  function reset(): void {
    for (const k of Object.keys(rings) as CostDimension[]) {
      rings[k] = newRing();
    }
  }

  return {
    setThreshold,
    recordQueueCost,
    recordNotification,
    recordIngestionBytes,
    recordRankingRefresh,
    recordStorageGrowthBytes,
    recordCachePressure,
    summary,
    reset,
  };
}
