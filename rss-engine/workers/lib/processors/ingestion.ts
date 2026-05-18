/**
 * Phase B — `process_ingestion_job`.
 *
 * The ingestion *worker* (`rss-worker.ts`) remains the canonical owner of
 * feed leasing; this processor handles *downstream* ingestion jobs that fan
 * out from there — for example, a `recategorize_article` request emitted
 * after the ranking layer detects a misclassified piece.
 *
 * Phase B intentionally ships with a small, conservative set of known
 * job_types:
 *   - `recategorize_article` — payload `{ article_id, suggested_category_id }`
 *   - `reingest_feed`        — payload `{ feed_id }` (re-enqueues a lease via
 *                              the existing `enqueue_job` RPC; never touches
 *                              `sources`/`articles` directly)
 *
 * Unknown job_types are returned as failures so they accumulate in the DLQ
 * for human inspection rather than silently disappearing.
 *
 * Idempotency: every action ultimately goes through a server-side RPC, all
 * of which are dedup-safe on `(queue_name, job_type, dedup_key)` via
 * `enqueue_job`'s active-status unique index.
 */

import type { LogFn } from '../logger';
import type { CategoryNormalizer } from '../normalizeCategory';
import type { LeasedJob, Processor, ProcessorResult, SupabaseLike } from '../types';

export interface IngestionProcessorDeps {
  supabase: SupabaseLike;
  log: LogFn;
  normalizer: CategoryNormalizer;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createIngestionProcessor(deps: IngestionProcessorDeps): Processor {
  const { supabase, log, normalizer } = deps;

  return async function processIngestionJob(job: LeasedJob): Promise<ProcessorResult> {
    const payload = job.payload ?? {};
    const baseLog = {
      job_id: job.id,
      job_type: job.job_type,
      attempts: job.attempts,
    };

    switch (job.job_type) {
      case 'recategorize_article': {
        const articleId = asString(payload.article_id);
        if (!articleId) {
          return { status: 'failed', error: 'recategorize_article: missing article_id' };
        }
        const normalized = await normalizer.normalize(
          asString(payload.suggested_category_id),
        );
        if (!normalized.resolved) {
          return {
            status: 'failed',
            error: 'recategorize_article: category fallback unavailable',
          };
        }
        // All DB mutations go through a service-layer RPC. We never UPDATE
        // `articles` directly from the queue runner.
        const { error } = await supabase.rpc('apply_article_categorization', {
          p_article_id: articleId,
          p_category_id: normalized.categoryId,
        });
        if (error) {
          return {
            status: 'failed',
            error: `recategorize_article rpc failed: ${error.message}`,
          };
        }
        log('info', 'ingestion_job_recategorize_complete', {
          ...baseLog,
          article_id: articleId,
          category_id: normalized.categoryId,
          used_fallback: normalized.usedFallback,
        });
        return {
          status: 'success',
          detail: {
            article_id: articleId,
            category_id: normalized.categoryId,
            used_fallback: normalized.usedFallback,
          },
        };
      }

      case 'reingest_feed': {
        const feedId = asString(payload.feed_id);
        if (!feedId) {
          return { status: 'failed', error: 'reingest_feed: missing feed_id' };
        }
        // Re-enqueue is itself an RPC call; the existing dedup-active index
        // collapses bursts. We do NOT touch the `sources` table directly.
        const { error } = await supabase.rpc('reset_feed_for_reingest', {
          p_feed_id: feedId,
        });
        if (error) {
          return {
            status: 'failed',
            error: `reingest_feed rpc failed: ${error.message}`,
          };
        }
        log('info', 'ingestion_job_reingest_complete', { ...baseLog, feed_id: feedId });
        return { status: 'success', detail: { feed_id: feedId } };
      }

      default:
        // Surface to DLQ — never silently succeed on unknown work.
        return {
          status: 'failed',
          error: `unknown ingestion job_type: ${job.job_type}`,
        };
    }
  };
}
