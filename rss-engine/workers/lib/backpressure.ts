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
import type { QueueConfig, QueueName, SupabaseLike } from './types';

export interface BackpressureSnapshot {
  active: boolean;
  depth: number;
  ratio: number;
  concurrency: number;
  pollIntervalMs: number;
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

export function createBackpressureController(
  supabase: SupabaseLike,
  configs: ReadonlyMap<QueueName, QueueConfig>,
  log: LogFn,
  opts: BackpressureOptions = {},
): BackpressureController {
  const sampleIntervalMs = Math.max(opts.sampleIntervalMs ?? 5_000, 1_000);
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

    // Fallback: cheap server-side count of queued jobs only. Leased/running
    // are intentionally excluded — backpressure cares about backlog, not
    // work in progress.
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
      // `maybeSingle` only returns 0 or 1 — without an explicit head:true /
      // count:'exact' option we cannot get a true count from the minimal
      // QueryBuilder surface, so we treat the presence of any queued row as
      // "depth=1" and rely on the RPC for accurate numbers in production.
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
    const { active, ratio, concurrency, pollIntervalMs } = deriveBackpressure(cfg, depth);
    const snap: InternalSnapshot = {
      active,
      depth,
      ratio,
      concurrency,
      pollIntervalMs,
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
