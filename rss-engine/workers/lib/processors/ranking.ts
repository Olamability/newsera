/**
 * Phase B — `process_ranking_job`.
 *
 * The only ranking work the queue currently carries is
 * `refresh_ranked_feeds`, which fans out from each successful ingestion batch
 * (see `rss-worker.ts → enqueueRankingRefresh`).
 *
 * Implementation rule: we never `REFRESH MATERIALIZED VIEW` from the worker
 * directly. The Phase 043 migration provides `refresh_ranked_feeds()` as a
 * `SECURITY DEFINER` RPC that owns the privilege boundary; the worker calls
 * the RPC and lets the database do the work.
 *
 * Idempotency: the underlying RPC is idempotent — calling it twice is
 * indistinguishable from calling it once aside from a slightly higher DB
 * cost, which the dedup_key on the enqueue side already collapses.
 */

import type { LogFn } from '../logger';
import type { CategoryNormalizer } from '../normalizeCategory';
import type { LeasedJob, Processor, ProcessorResult, SupabaseLike } from '../types';

export interface RankingProcessorDeps {
  supabase: SupabaseLike;
  log: LogFn;
  normalizer: CategoryNormalizer;
  /**
   * Phase D — flag probes. The runner injects closures that call
   * `is_feature_enabled('personalization_v1' | 'ranking_v1')` so flag
   * flips are observed without a process restart. Both default to a
   * permanent FALSE so callers that haven't been upgraded keep the
   * legacy behaviour (only the global refresh / rescore paths run).
   */
  isPersonalizationEnabled?: () => Promise<boolean>;
  isRankingEnabled?: () => Promise<boolean>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createRankingProcessor(deps: RankingProcessorDeps): Processor {
  const { supabase, log, normalizer } = deps;
  const isPersonalizationEnabled =
    deps.isPersonalizationEnabled ?? (async () => false);
  const isRankingEnabled = deps.isRankingEnabled ?? (async () => false);

  return async function processRankingJob(job: LeasedJob): Promise<ProcessorResult> {
    const payload = job.payload ?? {};
    const baseLog = {
      job_id: job.id,
      job_type: job.job_type,
      attempts: job.attempts,
      trace_id: asString(payload.trace_id),
    };

    switch (job.job_type) {
      case 'refresh_ranked_feeds': {
        const { error } = await supabase.rpc('refresh_ranked_feeds');
        if (error) {
          return {
            status: 'failed',
            error: `refresh_ranked_feeds rpc failed: ${error.message}`,
          };
        }
        log('info', 'ranking_job_refresh_complete', baseLog);
        return { status: 'success' };
      }

      case 'rescore_category': {
        // Category-scoped rescoring jobs always run against a *normalized*
        // category_id — never a raw payload value. This is the critical Phase A
        // schema-debt fix: ranking buckets stay consistent because every
        // downstream code path sees a normalized id.
        const raw = asString(payload.category_id);
        const normalized = await normalizer.normalize(raw);
        if (!normalized.resolved) {
          return {
            status: 'failed',
            error: 'rescore_category: category fallback unavailable',
          };
        }
        const { error } = await supabase.rpc('refresh_ranked_feed_for_category', {
          p_category_id: normalized.categoryId,
        });
        if (error) {
          return {
            status: 'failed',
            error: `refresh_ranked_feed_for_category rpc failed: ${error.message}`,
          };
        }
        log('info', 'ranking_job_rescore_category_complete', {
          ...baseLog,
          category_id: normalized.categoryId,
          used_fallback: normalized.usedFallback,
        });
        return {
          status: 'success',
          detail: {
            category_id: normalized.categoryId,
            used_fallback: normalized.usedFallback,
          },
        };
      }

      // -- Phase D ----------------------------------------------------------
      case 'recompute_user_affinity': {
        // Selective per-user affinity recompute. Gated by `personalization_v1`.
        // Flag OFF → structured skip so observers can distinguish
        // "feature off" from "unknown job".
        const enabled = await isPersonalizationEnabled();
        if (!enabled) {
          return {
            status: 'skipped',
            reason: 'personalization_v1_disabled',
            detail: {
              status: 'skipped_feature_flag',
              flag: 'personalization_v1',
              job_type: job.job_type,
            },
          };
        }
        const userId = asString(payload.user_id);
        if (!userId) {
          return { status: 'failed', error: 'recompute_user_affinity: missing user_id' };
        }
        const lookback = typeof payload.lookback_days === 'number'
          ? Math.max(1, Math.floor(payload.lookback_days as number))
          : 60;

        const { error: rpcErr } = await supabase.rpc('recompute_user_affinity', {
          p_user_id: userId,
          p_lookback_days: lookback,
        });
        if (rpcErr) {
          return {
            status: 'failed',
            error: `recompute_user_affinity rpc failed: ${rpcErr.message}`,
          };
        }
        // Apply negative-signal penalties on top (idempotent).
        const { error: negErr } = await supabase.rpc(
          'apply_negative_signals_to_affinity',
          { p_user_id: userId, p_lookback_days: lookback },
        );
        if (negErr) {
          // Not fatal — log and continue. The positive recompute is the
          // source of truth; negative-signal application is an overlay.
          log('warn', 'apply_negative_signals_to_affinity_failed', {
            ...baseLog,
            user_id: userId,
            error: negErr.message,
          });
        }
        log('info', 'ranking_job_recompute_affinity_complete', {
          ...baseLog,
          user_id: userId,
          lookback_days: lookback,
        });
        return {
          status: 'success',
          detail: { user_id: userId, lookback_days: lookback },
        };
      }

      case 'refresh_personalized_feed': {
        // Per-user selective personalized-feed refresh. Gated by
        // `ranking_v1` so the rollout can be reversed instantly.
        const enabled = await isRankingEnabled();
        if (!enabled) {
          return {
            status: 'skipped',
            reason: 'ranking_v1_disabled',
            detail: {
              status: 'skipped_feature_flag',
              flag: 'ranking_v1',
              job_type: job.job_type,
            },
          };
        }
        const userId = asString(payload.user_id);
        if (!userId) {
          return {
            status: 'failed',
            error: 'refresh_personalized_feed: missing user_id',
          };
        }
        const limit = typeof payload.limit === 'number'
          ? Math.max(10, Math.min(500, Math.floor(payload.limit as number)))
          : 200;
        const { data, error: rpcErr } = await supabase.rpc<number>(
          'refresh_personalized_feed_v2',
          { p_user_id: userId, p_limit: limit },
        );
        if (rpcErr) {
          return {
            status: 'failed',
            error: `refresh_personalized_feed_v2 rpc failed: ${rpcErr.message}`,
          };
        }
        const inserted = typeof data === 'number' ? data : 0;
        log('info', 'ranking_job_refresh_personalized_feed_complete', {
          ...baseLog,
          user_id: userId,
          inserted,
        });
        return {
          status: 'success',
          detail: { user_id: userId, inserted, limit },
        };
      }

      default:
        return {
          status: 'failed',
          error: `unknown ranking job_type: ${job.job_type}`,
        };
    }
  };
}
