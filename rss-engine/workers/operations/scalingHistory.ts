/**
 * Phase F — Scaling history (Phase E debt #1).
 *
 * The autoscaler (`orchestration/autoscaler.ts`) only produces transient
 * recommendations — they live for the duration of a single decision and are
 * then dropped. Operators have no way to see whether the same queue is
 * repeatedly saturating, how fast the backlog is growing across cycles, or
 * how often the autoscaler is recommending step-ups.
 *
 * `scalingHistory` is a bounded, in-memory rolling store that:
 *
 *   - persists every `ScalingRecommendation` produced by the autoscaler
 *   - keeps a per-queue depth/velocity sample stream
 *   - identifies recurring overload periods (sustained high-band spans)
 *   - exposes trend metrics for the operator dashboard
 *
 * Design constraints (matches Phase F rules):
 *
 *   - ADDITIVE: the autoscaler does not need to know this exists. The runner
 *     wires it up explicitly via `record()`.
 *   - BOUNDED: ring-buffered per worker type and per queue. Total memory
 *     footprint is fixed regardless of uptime.
 *   - PURE COMPUTE: no I/O. The host is responsible for emitting whatever
 *     snapshot it wants on the dashboard.
 *   - DETERMINISTIC: given the same sequence of `record()` calls, snapshots
 *     are byte-for-byte identical (modulo the injected clock).
 */

import type { LogFn } from '../lib/logger';
import type { QueueName } from '../lib/types';
import type {
  LoadBand,
  ScalingRecommendation,
} from '../orchestration/autoscaler';
import type { WorkerType } from '../orchestration/workerCoordinator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueuePressureSample {
  queue: QueueName;
  depth: number;
  growthDeltaPerMin?: number;
  failureRate?: number;
  observedAt: Date;
}

export interface ScalingHistoryOptions {
  /** Maximum recommendations retained per worker type. Default 200. */
  maxRecommendationsPerType?: number;
  /** Maximum pressure samples retained per queue. Default 720 (~12h @ 1/min). */
  maxPressureSamplesPerQueue?: number;
  /** Window for "recurring overload" detection, in ms. Default 6h. */
  recurringOverloadWindowMs?: number;
  /** Minimum sustained-high spans within window to flag a "recurring" pattern. Default 3. */
  recurringOverloadSpanThreshold?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

export interface OverloadSpan {
  workerType: WorkerType;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number;
  peakLoadScore: number;
  recommendationsIssued: number;
}

export interface SaturationTrend {
  queue: QueueName;
  samples: number;
  /** Linear regression slope of depth over time, depth-units / minute. */
  depthSlopePerMin: number;
  /** Mean of the last `growthDeltaPerMin` values (or 0). */
  avgGrowthDeltaPerMin: number;
  /** Mean queue depth across the window. */
  avgDepth: number;
  /** Highest observed depth in the window. */
  peakDepth: number;
  /** Fraction of samples whose depth ≥ 80th-percentile of historical peak. Approx. */
  saturationFraction: number;
}

export interface ScalingFrequency {
  workerType: WorkerType;
  total: number;
  byBand: Record<LoadBand, number>;
  stepUps: number;
  stepDowns: number;
  /** Last observed band. */
  lastBand: LoadBand | null;
}

export interface OverloadWarning {
  workerType: WorkerType;
  severity: 'info' | 'warning' | 'severe';
  reason: string;
  sustainedMs: number;
  spansInWindow: number;
}

export interface ScalingHistorySnapshot {
  generatedAt: Date;
  recommendations: ScalingFrequency[];
  saturation: SaturationTrend[];
  recurringOverload: OverloadSpan[];
  warnings: OverloadWarning[];
  /** Average queue growth velocity across all recorded queues, depth/min. */
  avgQueueGrowthVelocity: number;
  /** Total scaling recommendations observed over the lifetime of the store. */
  totalRecommendations: number;
}

export interface ScalingHistory {
  /** Record a single autoscaler recommendation. */
  record(rec: ScalingRecommendation, observedAt?: Date): void;
  /** Record a queue pressure sample. */
  recordPressure(sample: QueuePressureSample): void;
  /** Snapshot of trends, suitable for an operator dashboard. */
  snapshot(): ScalingHistorySnapshot;
  /** Predicted overload warnings derived from the current history. */
  predictOverload(): OverloadWarning[];
  /** Clear all history (operator action — emits an audit log). */
  reset(initiator: string): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RecEntry {
  rec: ScalingRecommendation;
  at: number;
}

interface PressureEntry {
  depth: number;
  growthDeltaPerMin: number;
  failureRate: number;
  at: number;
}

const DEFAULTS = {
  maxRecommendationsPerType: 200,
  maxPressureSamplesPerQueue: 720,
  recurringOverloadWindowMs: 6 * 3_600_000,
  recurringOverloadSpanThreshold: 3,
  now: () => Date.now(),
};

const BANDS: ReadonlyArray<LoadBand> = ['low', 'medium', 'high'];

function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

function linearSlopePerMin(samples: PressureEntry[]): number {
  if (samples.length < 2) return 0;
  // Convert ms timestamps to minutes relative to first sample for stability.
  const t0 = samples[0].at;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const s of samples) {
    const x = (s.at - t0) / 60_000;
    const y = s.depth;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const n = samples.length;
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export function createScalingHistory(
  log: LogFn,
  opts: ScalingHistoryOptions = {},
): ScalingHistory {
  const cfg = { ...DEFAULTS, ...opts };
  const recs = new Map<WorkerType, RecEntry[]>();
  const pressure = new Map<QueueName, PressureEntry[]>();
  let total = 0;

  function record(rec: ScalingRecommendation, observedAt?: Date): void {
    total += 1;
    const at = observedAt ? observedAt.getTime() : cfg.now();
    const bucket = recs.get(rec.workerType) ?? [];
    pushBounded(bucket, { rec, at }, cfg.maxRecommendationsPerType);
    recs.set(rec.workerType, bucket);
  }

  function recordPressure(sample: QueuePressureSample): void {
    const at = sample.observedAt.getTime();
    const bucket = pressure.get(sample.queue) ?? [];
    pushBounded(
      bucket,
      {
        depth: Math.max(0, sample.depth),
        growthDeltaPerMin: sample.growthDeltaPerMin ?? 0,
        failureRate: sample.failureRate ?? 0,
        at,
      },
      cfg.maxPressureSamplesPerQueue,
    );
    pressure.set(sample.queue, bucket);
  }

  function computeFrequency(): ScalingFrequency[] {
    const out: ScalingFrequency[] = [];
    for (const [wt, entries] of recs) {
      const byBand: Record<LoadBand, number> = { low: 0, medium: 0, high: 0 };
      let stepUps = 0;
      let stepDowns = 0;
      let lastBand: LoadBand | null = null;
      for (const e of entries) {
        byBand[e.rec.band] += 1;
        if (e.rec.recommendedWorkers > e.rec.currentWorkers) stepUps += 1;
        if (e.rec.recommendedWorkers < e.rec.currentWorkers) stepDowns += 1;
        lastBand = e.rec.band;
      }
      out.push({
        workerType: wt,
        total: entries.length,
        byBand,
        stepUps,
        stepDowns,
        lastBand,
      });
    }
    return out.sort((a, b) => a.workerType.localeCompare(b.workerType));
  }

  function computeOverloadSpans(): OverloadSpan[] {
    const tNow = cfg.now();
    const cutoff = tNow - cfg.recurringOverloadWindowMs;
    const spans: OverloadSpan[] = [];
    for (const [wt, entries] of recs) {
      let openStart: number | null = null;
      let peakScore = 0;
      let issued = 0;
      for (const e of entries) {
        if (e.at < cutoff) continue;
        if (e.rec.band === 'high') {
          if (openStart === null) {
            openStart = e.at;
            peakScore = e.rec.loadScore;
            issued = 1;
          } else {
            peakScore = Math.max(peakScore, e.rec.loadScore);
            issued += 1;
          }
        } else if (openStart !== null) {
          spans.push({
            workerType: wt,
            startedAt: new Date(openStart),
            endedAt: new Date(e.at),
            durationMs: e.at - openStart,
            peakLoadScore: peakScore,
            recommendationsIssued: issued,
          });
          openStart = null;
          peakScore = 0;
          issued = 0;
        }
      }
      if (openStart !== null) {
        spans.push({
          workerType: wt,
          startedAt: new Date(openStart),
          endedAt: null,
          durationMs: tNow - openStart,
          peakLoadScore: peakScore,
          recommendationsIssued: issued,
        });
      }
    }
    return spans.sort((a, b) => b.durationMs - a.durationMs);
  }

  function computeSaturation(): SaturationTrend[] {
    const out: SaturationTrend[] = [];
    for (const [queue, entries] of pressure) {
      if (entries.length === 0) continue;
      const slope = linearSlopePerMin(entries);
      const avgGrowth =
        entries.reduce((acc, e) => acc + e.growthDeltaPerMin, 0) / entries.length;
      const avgDepth = entries.reduce((acc, e) => acc + e.depth, 0) / entries.length;
      const peakDepth = entries.reduce((acc, e) => Math.max(acc, e.depth), 0);
      // Saturation fraction: how often we were at ≥ 80% of peak.
      const threshold = peakDepth * 0.8;
      const satCount = entries.filter((e) => e.depth >= threshold && peakDepth > 0).length;
      const saturationFraction = entries.length > 0 ? satCount / entries.length : 0;
      out.push({
        queue,
        samples: entries.length,
        depthSlopePerMin: slope,
        avgGrowthDeltaPerMin: avgGrowth,
        avgDepth,
        peakDepth,
        saturationFraction,
      });
    }
    return out.sort((a, b) => b.avgDepth - a.avgDepth);
  }

  function predictOverload(): OverloadWarning[] {
    const spans = computeOverloadSpans();
    const grouped = new Map<WorkerType, OverloadSpan[]>();
    for (const s of spans) {
      const arr = grouped.get(s.workerType) ?? [];
      arr.push(s);
      grouped.set(s.workerType, arr);
    }
    const warnings: OverloadWarning[] = [];
    for (const [wt, arr] of grouped) {
      const sustained = arr.reduce((acc, s) => acc + s.durationMs, 0);
      const spansInWindow = arr.length;
      let severity: OverloadWarning['severity'] = 'info';
      let reason = 'recurring_high_band';
      if (spansInWindow >= cfg.recurringOverloadSpanThreshold) {
        severity = 'warning';
        reason = 'recurring_overload_pattern';
      }
      // 30 minutes of sustained high is severe; arbitrary but conservative.
      if (sustained > 30 * 60_000) {
        severity = 'severe';
        reason = 'prolonged_sustained_overload';
      }
      if (spansInWindow > 0) {
        warnings.push({
          workerType: wt,
          severity,
          reason,
          sustainedMs: sustained,
          spansInWindow,
        });
      }
    }
    return warnings;
  }

  function snapshot(): ScalingHistorySnapshot {
    const saturation = computeSaturation();
    const recurringOverload = computeOverloadSpans();
    const warnings = predictOverload();
    const allGrowth = saturation.map((s) => s.avgGrowthDeltaPerMin);
    const avgQueueGrowthVelocity =
      allGrowth.length > 0 ? allGrowth.reduce((a, b) => a + b, 0) / allGrowth.length : 0;
    return {
      generatedAt: new Date(cfg.now()),
      recommendations: computeFrequency(),
      saturation,
      recurringOverload,
      warnings,
      avgQueueGrowthVelocity,
      totalRecommendations: total,
    };
  }

  function reset(initiator: string): void {
    log('warn', 'scaling_history_reset', {
      initiator,
      cleared_worker_types: recs.size,
      cleared_queues: pressure.size,
      cleared_recommendations: total,
    });
    recs.clear();
    pressure.clear();
    total = 0;
  }

  // Reference BANDS so eslint/ts know it's intentionally exported-but-internal.
  void BANDS;

  return { record, recordPressure, snapshot, predictOverload, reset };
}
