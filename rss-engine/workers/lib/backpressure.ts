/**
 * Phase B — Queue backpressure controller.
 *
 * The runner asks this module two things at the start of each polling cycle:
 *   - "How many jobs can I lease right now?"  → effectiveConcurrency()
 *   - "How long should I wait before the next cycle?" → nextPollDelayMs()
 *
 * Both answers shift based on the observed queue depth for that queue_name.
 * Depth is sampled via a lightweight COUNT query (no schema changes — uses the
 * existing `idx_job_queue_dispatch` index) and cached briefly so high-frequency
 * cycles do not hammer the planner.
 *
 * Algorithm (deliberately simple, no PID controllers, no external state):
 *
 *   ratio = depth / threshold
 *   ratio ≤ 1   → no backpressure
 *   1 < ratio ≤ 2 → concurrency × 0.5, idle interval × 2
 *   2 < ratio ≤ 4 → concurrency × 0.25, idle interval × 4
 *   ratio > 4     → concurrency = 1, idle interval × 8 (drain mode)
 *
 * When backpressure first engages — and only on the transition — we emit
 * `queue_backpressure_active` so dashboards/alerts can latch on a single event
 * rather than a spam stream.
 */

import type { LogFn } from './logger';
import type { QueueVelocityTracker } from './queueVelocity';
import type { QueueConfig, QueueName, SupabaseLike } from './types';

export interface BackpressureSnapshot {
  active: boolean;
  depth: number;
  ratio: number;
  concurrency: number;
  pollIntervalMs: number;
  /**
   * Phase C — set when throttling was engaged *predictively* because the
   * velocity tracker reported sustained queue growth, BEFORE the depth
   * actually crossed `backpressureThreshold`. Always false on the legacy
   * depth-only path so existing dashboards keep their meaning.
   */
  predictive: boolean;
}

export interface BackpressureController {
  /** Refresh the cached depth sample for `queue`. Safe to call every cycle. */
  sample(queue: QueueName): Promise<BackpressureSnapshot>;
  /** Cached snapshot; cheap, no I/O. */
  snapshot(queue: QueueName): BackpressureSnapshot;
}

export interface BackpressureOptions {
  /** Minimum gap between depth samples per queue. Default 5s. */
  sampleIntervalMs?: number;
  /**
   * Phase C — predictive throttle. When provided, the controller consults
   * the velocity tracker each cycle and engages backpressure early if the
   * EMA-smoothed growth delta exceeds `predictiveGrowthPerMin` for at least
   * `predictiveMinSamples` cycles, even when current depth is still below
   * the configured threshold.
   */
  velocity?: QueueVelocityTracker;
  predictiveGrowthPerMin?: number;
  predictiveMinSamples?: number;
}

interface InternalSnapshot extends BackpressureSnapshot {
  lastSampledAt: number;
  wasActive: boolean;
}

function emptySnapshot(cfg: QueueConfig): InternalSnapshot {
  return {
    active: false,
    depth: 0,
    ratio: 0,
    concurrency: cfg.baseConcurrency,
    pollIntervalMs: cfg.idlePollMs,
    predictive: false,
    lastSampledAt: 0,
    wasActive: false,
  };
}

/**
 * Tier the concurrency / interval multipliers. Exported separately so tests
 * can assert the policy without spinning up a Supabase mock.
 */
export function deriveBackpressure(
  cfg: QueueConfig,
  depth: number,
): { active: boolean; ratio: number; concurrency: number; pollIntervalMs: number } {
  const threshold = Math.max(cfg.backpressureThreshold, 1);
  const ratio = depth / threshold;
  if (ratio <= 1) {
    return {
      active: false,
      ratio,
      concurrency: cfg.baseConcurrency,
      pollIntervalMs: cfg.activePollMs,
    };
  }
  if (ratio <= 2) {
    return {
      active: true,
      ratio,
      concurrency: Math.max(Math.floor(cfg.baseConcurrency * 0.5), 1),
      pollIntervalMs: cfg.idlePollMs * 2,
    };
  }
  if (ratio <= 4) {
    return {
      active: true,
      ratio,
      concurrency: Math.max(Math.floor(cfg.baseConcurrency * 0.25), 1),
      pollIntervalMs: cfg.idlePollMs * 4,
    };
  }
  return {
    active: true,
    ratio,
    concurrency: 1,
    pollIntervalMs: cfg.idlePollMs * 8,
  };
}

/**
 * Phase C — predictive policy. When velocity reports sustained backlog
 * growth we soften concurrency *before* depth crosses the threshold. The
 * policy is intentionally less aggressive than depth-driven drain mode: we
 * halve concurrency and double the idle interval (matching the "ratio ≤ 2"
 * tier of the depth-driven policy) but we do NOT collapse to concurrency=1.
 * That keeps throughput high enough to actually exercise the backlog while
 * still slowing the arrival/processing imbalance.
 */
export function derivePredictiveBackpressure(
  cfg: QueueConfig,
): { active: boolean; concurrency: number; pollIntervalMs: number } {
  return {
    active: true,
    concurrency: Math.max(Math.floor(cfg.baseConcurrency * 0.5), 1),
    pollIntervalMs: Math.max(cfg.idlePollMs * 2, cfg.activePollMs * 4),
  };
}

export function createBackpressureController(
  supabase: SupabaseLike,
  configs: ReadonlyMap<QueueName, QueueConfig>,
  log: LogFn,
  opts: BackpressureOptions = {},
): BackpressureController {
  const sampleIntervalMs = Math.max(opts.sampleIntervalMs ?? 5_000, 1_000);
  const velocity = opts.velocity;
  const predictiveGrowthPerMin = Math.max(opts.predictiveGrowthPerMin ?? 50, 1);
  const predictiveMinSamples = Math.max(opts.predictiveMinSamples ?? 3, 1);
  const snapshots = new Map<QueueName, InternalSnapshot>();

  for (const [name, cfg] of configs) {
    snapshots.set(name, emptySnapshot(cfg));
  }

  async function queryDepth(queue: QueueName): Promise<number> {
    // Uses the `queue_depth_for` RPC if available, else falls back to a
    // bounded COUNT against `job_queue` (no schema changes — read-only).
    // We try the RPC first because Phase 047 ships several admin/observability
    // helpers, and going via an RPC is preferable to a raw table query.
    try {
      const { data, error } = await supabase.rpc<number>('queue_depth_for', {
        p_queue_name: queue,
      });
      if (!error && typeof data === 'number') return data;
    } catch {
      // fall through to direct count
    }

    // Fallback path: the minimal SupabaseLike `QueryBuilder` surface does not
    // expose `count: 'exact'` (would force pulling in @supabase/supabase-js
    // types into the test harness), so this fallback only tells us whether at
    // least one row is queued — i.e. it returns 0 or 1.
    //
    // OPERATIONAL IMPLICATION: when the `queue_depth_for` RPC is unavailable
    // backpressure will engage on the very first queued job (because depth=1
    // can still exceed a tuned-low threshold) but it will NOT correctly tier
    // into drain mode no matter how large the backlog gets. The RPC is the
    // production-correct path; this fallback only exists to prevent the
    // runner from crashing if the RPC is missing during a partial deploy.
    try {
      const builder = supabase.from<{ id: string }>('job_queue');
      const { data, error } = await builder
        .select('id')
        .eq('queue_name', queue)
        .eq('status', 'queued')
        .maybeSingle();
      if (error) {
        log('warn', 'backpressure_depth_query_failed', {
          queue_name: queue,
          error: error.message,
        });
        return 0;
      }
      return data ? 1 : 0;
    } catch (err) {
      log('warn', 'backpressure_depth_query_threw', {
        queue_name: queue,
        error: (err as Error)?.message ?? String(err),
      });
      return 0;
    }
  }

  function makeSnapshot(cfg: QueueConfig, depth: number, prev: InternalSnapshot): InternalSnapshot {
    const depthPolicy = deriveBackpressure(cfg, depth);
    let { active, ratio, concurrency, pollIntervalMs } = depthPolicy;
    let predictive = false;

    // Phase C — if depth has NOT yet engaged backpressure but the velocity
    // tracker says the backlog is growing fast, throttle pre-emptively.
    if (!active && velocity) {
      const v = velocity.snapshot(cfg.name);
      if (
        v.samples >= predictiveMinSamples &&
        v.growthDeltaPerMin >= predictiveGrowthPerMin
      ) {
        const p = derivePredictiveBackpressure(cfg);
        active = true;
        predictive = true;
        concurrency = p.concurrency;
        pollIntervalMs = p.pollIntervalMs;
      }
    }

    const snap: InternalSnapshot = {
      active,
      depth,
      ratio,
      concurrency,
      pollIntervalMs,
      predictive,
      lastSampledAt: Date.now(),
      wasActive: prev.wasActive,
    };
    // Emit on rising edge only — keeps the alert pipeline quiet.
    if (active && !prev.wasActive) {
      log('warn', 'queue_backpressure_active', {
        queue_name: cfg.name,
        depth,
        ratio: Number(ratio.toFixed(2)),
        new_concurrency: concurrency,
        new_poll_interval_ms: pollIntervalMs,
        threshold: cfg.backpressureThreshold,
        predictive,
        ...(predictive && velocity
          ? {
              growth_delta_per_min: Number(
                velocity.snapshot(cfg.name).growthDeltaPerMin.toFixed(2),
              ),
              predictive_growth_threshold: predictiveGrowthPerMin,
            }
          : {}),
      });
    } else if (!active && prev.wasActive) {
      log('info', 'queue_backpressure_cleared', {
        queue_name: cfg.name,
        depth,
        threshold: cfg.backpressureThreshold,
      });
    }
    snap.wasActive = active;
    return snap;
  }

  return {
    async sample(queue) {
      const cfg = configs.get(queue);
      if (!cfg) {
        throw new Error(`backpressure: unknown queue '${queue}'`);
      }
      const prev = snapshots.get(queue) ?? emptySnapshot(cfg);
      const now = Date.now();
      if (now - prev.lastSampledAt < sampleIntervalMs) {
        return prev;
      }
      const depth = await queryDepth(queue);
      const next = makeSnapshot(cfg, depth, prev);
      snapshots.set(queue, next);
      return next;
    },
    snapshot(queue) {
      const cfg = configs.get(queue);
      if (!cfg) {
        throw new Error(`backpressure: unknown queue '${queue}'`);
      }
      return snapshots.get(queue) ?? emptySnapshot(cfg);
    },
  };
}
