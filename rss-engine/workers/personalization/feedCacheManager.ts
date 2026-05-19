/**
 * Phase E — Personalized feed cache manager (closes Phase D storage-growth debt).
 *
 * `ranked_feed_personalized_v2` is the per-user slice the API serves. Phase D
 * shipped the writer but never shipped the *evictor*: the table grows
 * indefinitely, one row per (user_id, rank_position) per refresh, plus stale
 * "tail" slices from users who have been inactive for weeks.
 *
 * This module provides three pure planning primitives plus one queue-job
 * scheduler so the operator can:
 *
 *   1. Bound retention by age (`maxAgeMs`)        — rolling TTL eviction.
 *   2. Bound retention by window size              — `maxFeedWindowPerUser`
 *      keeps only the most recent N slices per user.
 *   3. Drop "stale slices" — rows whose `personalized_score` has been
 *      superseded by a newer slice for the same `(user_id, article_id)`.
 *
 * Hard rules (Phase E):
 *   - NO destructive migrations: we never DROP/TRUNCATE.
 *   - NO direct deletes from this module: every mutation goes through the
 *     `cleanup_personalized_feed_cache` RPC the operator already controls.
 *     This file plans the work and enqueues the job; the SQL side decides
 *     batch limits.
 *   - QUEUE-SAFE: the cleanup job runs on the `analytics` queue (low
 *     priority, large batch tolerance) so it never starves ingestion or
 *     ranking.
 *   - SCHEMA-SAFE: no new columns. We use `(user_id, refreshed_at,
 *     article_id, personalized_score)` columns that already exist on
 *     `ranked_feed_personalized_v2`.
 *
 * Observability:
 *   - `cache_size`         — total rows in the table (sampled).
 *   - `stale_slice_count`  — rows superseded by a newer slice.
 *   - `avg_feed_age_ms`    — mean age across all rows.
 *
 * All three are returned by `summarizeCache()` so the existing dashboard
 * can plot them without a schema change.
 */

import type { LogFn } from '../lib/logger';
import type { SupabaseLike } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FeedCacheRetentionConfig {
  /** Max age of a slice before it is eligible for eviction. Default 72h. */
  maxAgeMs: number;
  /** Max number of slices to retain per user. Default 500. */
  maxFeedWindowPerUser: number;
  /** Max rows the RPC may touch in one invocation. Default 10_000. */
  maxRowsPerSweep: number;
  /** Minimum interval between two cleanup jobs for the same user cohort. */
  minSweepIntervalMs: number;
}

export const DEFAULT_FEED_CACHE_RETENTION: FeedCacheRetentionConfig = {
  maxAgeMs: 72 * 3_600_000,
  maxFeedWindowPerUser: 500,
  maxRowsPerSweep: 10_000,
  minSweepIntervalMs: 5 * 60_000,
};

export interface FeedCacheSummary {
  /** Total row count (NULL when the RPC is unavailable; the caller logs and skips). */
  cacheSize: number | null;
  /** Rows that have been superseded by a newer slice for the same (user, article). */
  staleSliceCount: number | null;
  /** Mean age of rows in ms. */
  avgFeedAgeMs: number | null;
  sampledAt: Date;
}

export interface CleanupPlan {
  /** Cut-off below which rows are TTL-evicted. */
  ttlCutoff: Date;
  /** Per-user cap to enforce. */
  maxFeedWindowPerUser: number;
  /** RPC-side batch ceiling. */
  maxRowsPerSweep: number;
  /** Whether the planner believes a sweep is currently warranted. */
  recommended: boolean;
  /** Free-form reason string for the log line. */
  reason: string;
}

export interface FeedCacheManager {
  /** Pull the three observability metrics in one round-trip. */
  summarize(): Promise<FeedCacheSummary>;
  /** Decide whether the cache needs a cleanup pass right now. */
  plan(summary: FeedCacheSummary, now?: Date): CleanupPlan;
  /**
   * Enqueue a `cleanup_personalized_feed_cache` analytics job for the next
   * runner cycle. Idempotent: the job carries a `dedup_key` that collapses
   * with any in-flight cleanup.
   */
  enqueueCleanup(plan: CleanupPlan, opts?: { reason?: string }): Promise<{ enqueued: boolean; dedupKey: string }>;
}

// ---------------------------------------------------------------------------
// Pure planning logic (no I/O — safe to unit-test)
// ---------------------------------------------------------------------------

/**
 * Decide whether a cleanup sweep is warranted given the current observability
 * snapshot. We intentionally err on the side of NOT running a sweep when the
 * cache is small — the cleanup itself is bounded but its dedup window prevents
 * accidental double-runs from operator scripts.
 */
export function planCleanup(
  summary: FeedCacheSummary,
  cfg: FeedCacheRetentionConfig,
  now: Date = new Date(),
): CleanupPlan {
  const ttlCutoff = new Date(now.getTime() - Math.max(cfg.maxAgeMs, 60_000));

  const reasons: string[] = [];
  let recommended = false;

  if (summary.staleSliceCount !== null && summary.staleSliceCount >= cfg.maxRowsPerSweep / 4) {
    reasons.push(`stale_slices=${summary.staleSliceCount}`);
    recommended = true;
  }
  if (summary.avgFeedAgeMs !== null && summary.avgFeedAgeMs > cfg.maxAgeMs * 0.75) {
    reasons.push(`avg_age_ms=${Math.round(summary.avgFeedAgeMs)}`);
    recommended = true;
  }
  if (summary.cacheSize !== null && summary.cacheSize > cfg.maxRowsPerSweep * 10) {
    reasons.push(`cache_size=${summary.cacheSize}`);
    recommended = true;
  }
  if (!recommended) {
    reasons.push('within_thresholds');
  }

  return {
    ttlCutoff,
    maxFeedWindowPerUser: cfg.maxFeedWindowPerUser,
    maxRowsPerSweep: cfg.maxRowsPerSweep,
    recommended,
    reason: reasons.join(','),
  };
}

// ---------------------------------------------------------------------------
// Manager factory
// ---------------------------------------------------------------------------

export interface FeedCacheManagerOptions {
  config?: Partial<FeedCacheRetentionConfig>;
  /** Override for the dedup bucket size when enqueuing cleanup jobs. */
  dedupBucketMs?: number;
}

export function createFeedCacheManager(
  supabase: SupabaseLike,
  log: LogFn,
  opts: FeedCacheManagerOptions = {},
): FeedCacheManager {
  const cfg: FeedCacheRetentionConfig = {
    ...DEFAULT_FEED_CACHE_RETENTION,
    ...opts.config,
  };
  const dedupBucketMs = Math.max(opts.dedupBucketMs ?? cfg.minSweepIntervalMs, 60_000);

  async function summarize(): Promise<FeedCacheSummary> {
    const sampledAt = new Date();
    try {
      const { data, error } = await supabase.rpc<{
        cache_size: number;
        stale_slice_count: number;
        avg_feed_age_ms: number;
      }>('personalized_feed_cache_summary');
      if (error || !data) {
        log('warn', 'feed_cache_summary_unavailable', {
          error: error?.message ?? 'no_data',
        });
        return {
          cacheSize: null,
          staleSliceCount: null,
          avgFeedAgeMs: null,
          sampledAt,
        };
      }
      return {
        cacheSize: Number(data.cache_size ?? 0),
        staleSliceCount: Number(data.stale_slice_count ?? 0),
        avgFeedAgeMs: Number(data.avg_feed_age_ms ?? 0),
        sampledAt,
      };
    } catch (err) {
      log('warn', 'feed_cache_summary_threw', {
        error: (err as Error)?.message ?? String(err),
      });
      return {
        cacheSize: null,
        staleSliceCount: null,
        avgFeedAgeMs: null,
        sampledAt,
      };
    }
  }

  function plan(summary: FeedCacheSummary, now?: Date): CleanupPlan {
    return planCleanup(summary, cfg, now);
  }

  async function enqueueCleanup(
    plan: CleanupPlan,
    enqueueOpts: { reason?: string } = {},
  ): Promise<{ enqueued: boolean; dedupKey: string }> {
    // Bucket time so concurrent callers collapse onto the same dedup key.
    const bucket = Math.floor(Date.now() / dedupBucketMs);
    const dedupKey = `feed_cache_cleanup:${bucket}`;
    try {
      const { error } = await supabase.rpc('enqueue_job', {
        p_queue_name: 'analytics',
        p_job_type: 'cleanup_personalized_feed_cache',
        p_payload: {
          ttl_cutoff: plan.ttlCutoff.toISOString(),
          max_feed_window_per_user: plan.maxFeedWindowPerUser,
          max_rows_per_sweep: plan.maxRowsPerSweep,
          reason: enqueueOpts.reason ?? plan.reason,
        },
        p_dedup_key: dedupKey,
        p_priority: 90,
      });
      if (error) {
        log('warn', 'feed_cache_cleanup_enqueue_failed', {
          dedup_key: dedupKey,
          error: error.message,
        });
        return { enqueued: false, dedupKey };
      }
      log('info', 'feed_cache_cleanup_enqueued', {
        dedup_key: dedupKey,
        ttl_cutoff: plan.ttlCutoff.toISOString(),
        max_feed_window_per_user: plan.maxFeedWindowPerUser,
        reason: enqueueOpts.reason ?? plan.reason,
      });
      return { enqueued: true, dedupKey };
    } catch (err) {
      log('warn', 'feed_cache_cleanup_enqueue_threw', {
        dedup_key: dedupKey,
        error: (err as Error)?.message ?? String(err),
      });
      return { enqueued: false, dedupKey };
    }
  }

  return { summarize, plan, enqueueCleanup };
}
