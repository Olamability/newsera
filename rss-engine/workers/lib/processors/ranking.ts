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
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createRankingProcessor(deps: RankingProcessorDeps): Processor {
  const { supabase, log, normalizer } = deps;

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

      default:
        return {
          status: 'failed',
          error: `unknown ranking job_type: ${job.job_type}`,
        };
    }
  };
}
