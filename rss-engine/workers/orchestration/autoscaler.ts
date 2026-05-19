/**
 * Phase E — Autoscaler (recommendation-only).
 *
 * The autoscaler is the *thinking* half of the orchestration layer: it does
 * not provision anything. It reads the same observability signals the
 * runner already produces and recommends a desired worker count per worker
 * type. The operator (or, later, a Phase F controller) applies those
 * recommendations.
 *
 * Inputs (all optional — missing inputs default to "no opinion"):
 *
 *   - queue depth per queue            (from `queue_depth_for` RPC)
 *   - queue velocity per queue         (from `queueVelocity` tracker)
 *   - worker latency snapshot          (p95 from the profiler)
 *   - job failure rate per queue       (from cycle metrics)
 *   - CPU / memory snapshot            (mockable — host injects)
 *
 * Decision table (per worker type):
 *
 *   Load   | Action
 *   -------|------------
 *   Low    | scale down (one fewer worker, never below `minWorkers`)
 *   Medium | steady
 *   High   | scale out  (add up to `maxStepUp` workers, never above `maxWorkers`)
 *
 * "Load" is a composite of:
 *
 *   - effectiveBacklog   = depth × queue.weight
 *   - backlogGrowth      = velocity.growthDeltaPerMin
 *   - utilization        = (cpuPct + memoryPct) / 2
 *   - latencyPressure    = clamp(p95LatencyMs / p95SloMs, 0, 2)
 *   - failurePressure    = failureRate × 5
 *
 * Composite score (in arbitrary units; thresholds are tuned together):
 *
 *   load = log10(1 + effectiveBacklog) + max(0, backlogGrowth) / 50
 *        + 1.5 * latencyPressure + 2.0 * failurePressure
 *        + (utilization > 0.85 ? 1.0 : 0)
 *
 * Thresholds (configurable):
 *   load < 1.5   → scale down recommendation
 *   load < 4.0   → steady
 *   else         → scale out
 *
 * HARD RULES:
 *   - Recommendation-only. No cloud SDKs, no shelling out to `kubectl`.
 *   - Bounded outputs: never returns values outside [minWorkers, maxWorkers].
 *   - Stable: emits hysteresis-aware recommendations (a scale-down only
 *     fires after `cooldownMs` of "low" classifications).
 */

import type { LogFn } from '../lib/logger';
import type { QueueName } from '../lib/types';
import type { WorkerType } from './workerCoordinator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueueLoadInput {
  depth: number;
  /** From queueVelocity tracker. Positive = backlog growing. */
  growthDeltaPerMin?: number;
  /** Recent failure rate as a fraction [0..1]. */
  failureRate?: number;
}

export interface ResourceSnapshot {
  /** CPU utilization as a fraction [0..1]. */
  cpuPct?: number;
  /** Memory utilization as a fraction [0..1]. */
  memoryPct?: number;
}

export interface AutoscalerInputs {
  queues: Partial<Record<QueueName, QueueLoadInput>>;
  /** p95 latency per queue, in ms. */
  p95LatencyMs?: Partial<Record<QueueName, number>>;
  /** Currently registered worker counts per type. */
  currentWorkers: Record<WorkerType, number>;
  resources?: ResourceSnapshot;
}

export type LoadBand = 'low' | 'medium' | 'high';

export interface ScalingRecommendation {
  workerType: WorkerType;
  band: LoadBand;
  loadScore: number;
  currentWorkers: number;
  recommendedWorkers: number;
  reason: string;
}

export interface AutoscalerOptions {
  /** Per-queue weight when computing effective backlog. Defaults to 1. */
  queueWeights?: Partial<Record<QueueName, number>>;
  /** Per-worker-type bounds. Sensible defaults provided. */
  bounds?: Partial<Record<WorkerType, { min: number; max: number; stepUp: number; stepDown: number }>>;
  /** p95 SLO per queue in ms. Default 1000. */
  p95SloMs?: Partial<Record<QueueName, number>>;
  /** "Low" band cooldown before recommending scale-down. Default 5 min. */
  scaleDownCooldownMs?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
  /** Low/high band thresholds. */
  lowThreshold?: number;
  highThreshold?: number;
}

export interface Autoscaler {
  recommend(inputs: AutoscalerInputs): ScalingRecommendation[];
}

// ---------------------------------------------------------------------------
// Worker-type → queue mapping
// ---------------------------------------------------------------------------

const WORKER_QUEUES: Record<WorkerType, ReadonlyArray<QueueName>> = {
  rss_ingestion: ['ingestion'],
  queue_runner: ['ingestion', 'ranking', 'analytics'],
  notification_dispatch: ['notification'],
  ranking_refresh: ['ranking'],
};

const DEFAULT_BOUNDS: Record<WorkerType, { min: number; max: number; stepUp: number; stepDown: number }> = {
  rss_ingestion: { min: 1, max: 8, stepUp: 2, stepDown: 1 },
  queue_runner: { min: 1, max: 12, stepUp: 2, stepDown: 1 },
  notification_dispatch: { min: 1, max: 6, stepUp: 1, stepDown: 1 },
  ranking_refresh: { min: 1, max: 4, stepUp: 1, stepDown: 1 },
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_LOW = 1.5;
const DEFAULT_HIGH = 4.0;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function computeLoadScore(
  queues: ReadonlyArray<QueueLoadInput>,
  p95LatencyMs: number | undefined,
  p95SloMs: number,
  resources: ResourceSnapshot | undefined,
): { score: number; effectiveBacklog: number; growth: number; latencyPressure: number; failurePressure: number; utilization: number } {
  let effectiveBacklog = 0;
  let growth = 0;
  let failurePressure = 0;
  for (const q of queues) {
    effectiveBacklog += Math.max(0, q.depth);
    growth += Math.max(0, q.growthDeltaPerMin ?? 0);
    failurePressure += Math.max(0, q.failureRate ?? 0);
  }
  failurePressure = clamp(failurePressure * 5, 0, 10);
  const latencyPressure = p95LatencyMs && p95SloMs > 0 ? clamp(p95LatencyMs / p95SloMs, 0, 5) : 0;
  const cpu = clamp(resources?.cpuPct ?? 0, 0, 1);
  const mem = clamp(resources?.memoryPct ?? 0, 0, 1);
  const utilization = (cpu + mem) / 2;
  const score =
    Math.log10(1 + effectiveBacklog) +
    growth / 50 +
    1.5 * latencyPressure +
    2.0 * failurePressure +
    (utilization > 0.85 ? 1.0 : 0);
  return { score, effectiveBacklog, growth, latencyPressure, failurePressure, utilization };
}

export function createAutoscaler(
  log: LogFn,
  opts: AutoscalerOptions = {},
): Autoscaler {
  const lowThreshold = opts.lowThreshold ?? DEFAULT_LOW;
  const highThreshold = opts.highThreshold ?? DEFAULT_HIGH;
  const cooldownMs = Math.max(opts.scaleDownCooldownMs ?? DEFAULT_COOLDOWN_MS, 30_000);
  const now = opts.now ?? (() => Date.now());
  const lastLowAt = new Map<WorkerType, number>();
  const lastBand = new Map<WorkerType, LoadBand>();

  function boundsFor(type: WorkerType) {
    return { ...DEFAULT_BOUNDS[type], ...(opts.bounds?.[type] ?? {}) };
  }

  function recommend(inputs: AutoscalerInputs): ScalingRecommendation[] {
    const out: ScalingRecommendation[] = [];
    const tNow = now();
    for (const wt of Object.keys(WORKER_QUEUES) as WorkerType[]) {
      const queueNames = WORKER_QUEUES[wt];
      const queueLoads: QueueLoadInput[] = [];
      let p95Acc = 0;
      let p95Count = 0;
      let p95SloAcc = 0;
      for (const q of queueNames) {
        const load = inputs.queues[q];
        if (load) {
          const weight = opts.queueWeights?.[q] ?? 1.0;
          queueLoads.push({
            depth: load.depth * weight,
            growthDeltaPerMin: (load.growthDeltaPerMin ?? 0) * weight,
            failureRate: load.failureRate,
          });
        }
        const p = inputs.p95LatencyMs?.[q];
        if (typeof p === 'number') {
          p95Acc += p;
          p95Count += 1;
        }
        p95SloAcc += opts.p95SloMs?.[q] ?? 1000;
      }
      const p95 = p95Count > 0 ? p95Acc / p95Count : undefined;
      const slo = queueNames.length > 0 ? p95SloAcc / queueNames.length : 1000;
      const decomposition = computeLoadScore(queueLoads, p95, slo, inputs.resources);
      const bounds = boundsFor(wt);
      const current = clamp(inputs.currentWorkers[wt] ?? bounds.min, 0, bounds.max);

      let band: LoadBand;
      if (decomposition.score < lowThreshold) band = 'low';
      else if (decomposition.score < highThreshold) band = 'medium';
      else band = 'high';

      let recommended = current;
      let reason = `score=${decomposition.score.toFixed(2)} band=${band}`;

      if (band === 'high') {
        recommended = clamp(current + bounds.stepUp, bounds.min, bounds.max);
        lastLowAt.delete(wt);
        reason += ` step_up=${bounds.stepUp}`;
      } else if (band === 'low') {
        const since = lastLowAt.get(wt);
        if (since === undefined) {
          lastLowAt.set(wt, tNow);
          reason += ' cooldown_started';
        } else if (tNow - since >= cooldownMs) {
          recommended = clamp(current - bounds.stepDown, bounds.min, bounds.max);
          reason += ` step_down=${bounds.stepDown}`;
          // Reset cooldown so we don't immediately drop again next cycle.
          lastLowAt.set(wt, tNow);
        } else {
          reason += ` cooldown_remaining_ms=${cooldownMs - (tNow - since)}`;
        }
      } else {
        lastLowAt.delete(wt);
        reason += ' steady';
      }

      if (recommended !== current || band !== lastBand.get(wt)) {
        log('info', 'autoscaler_recommendation', {
          worker_type: wt,
          band,
          load_score: Number(decomposition.score.toFixed(2)),
          current_workers: current,
          recommended_workers: recommended,
          effective_backlog: Number(decomposition.effectiveBacklog.toFixed(0)),
          growth_delta_per_min: Number(decomposition.growth.toFixed(2)),
          latency_pressure: Number(decomposition.latencyPressure.toFixed(2)),
          failure_pressure: Number(decomposition.failurePressure.toFixed(2)),
          utilization: Number(decomposition.utilization.toFixed(2)),
        });
        lastBand.set(wt, band);
      }

      out.push({
        workerType: wt,
        band,
        loadScore: decomposition.score,
        currentWorkers: current,
        recommendedWorkers: recommended,
        reason,
      });
    }
    return out;
  }

  return { recommend };
}
