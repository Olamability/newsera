/**
 * Phase B/D — `process_analytics_job`.
 *
 * Phase B: analytics rollups are still owned by pg_cron schedules
 * (migration 044). The queue path was reserved for on-demand rollups
 * (backfill etc); other job types were acknowledged as `skipped`.
 *
 * Phase D: the queue now also carries two new analytics jobs:
 *
 *   ranking_feedback_analysis — summarize ranking_feedback_metrics over
 *                               the last `lookback_minutes` and log the
 *                               suggestion for the admin dashboard.
 *
 *   engagement_quality_pass   — wraps the existing on-demand engagement
 *                               rollup behind a flag-gated job so the
 *                               ranking team can trigger it from the
 *                               admin panel without touching cron.
 *
 * Both jobs are *additive* and have NO direct dependencies on the
 * `personalization_v1` flag — they only *report* on quality, never
 * mutate ranking constants. Unknown job types fall through to the
 * Phase B skipped-stub behaviour.
 */

import type { LogFn } from '../logger';
import type { LeasedJob, Processor, ProcessorResult, SupabaseLike } from '../types';

export interface AnalyticsProcessorDeps {
  log: LogFn;
  /**
   * Optional Supabase handle — required only when the runner wants the
   * Phase D analytics job types active. Without it, all jobs degrade
   * to the Phase B `skipped` stub.
   */
  supabase?: SupabaseLike;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createAnalyticsProcessor(deps: AnalyticsProcessorDeps): Processor {
  const { log } = deps;
  const supabase = deps.supabase;

  return async function processAnalyticsJob(
    job: LeasedJob,
  ): Promise<ProcessorResult> {
    const payload = job.payload ?? {};

    // Phase D — ranking feedback analysis.
    if (job.job_type === 'ranking_feedback_analysis') {
      if (!supabase) {
        log('info', 'analytics_job_skipped_no_supabase', {
          job_id: job.id,
          job_type: job.job_type,
        });
        return {
          status: 'skipped',
          reason: 'analytics processor has no supabase handle',
          detail: { job_type: job.job_type },
        };
      }
      const lookback =
        typeof payload.lookback_minutes === 'number'
          ? Math.max(1, Math.floor(payload.lookback_minutes as number))
          : 60;
      const { data, error } = await supabase.rpc<unknown>(
        'ranking_feedback_summary',
        { p_lookback_minutes: lookback },
      );
      if (error) {
        return {
          status: 'failed',
          error: `ranking_feedback_summary failed: ${error.message}`,
        };
      }
      log('info', 'analytics_job_ranking_feedback_analysis_complete', {
        job_id: job.id,
        lookback_minutes: lookback,
        summary: data,
        trace_id: asString(payload.trace_id),
      });
      return { status: 'success', detail: { lookback_minutes: lookback } };
    }

    // Phase D — engagement-quality on-demand pass.
    if (job.job_type === 'engagement_quality_pass') {
      if (!supabase) {
        return {
          status: 'skipped',
          reason: 'analytics processor has no supabase handle',
          detail: { job_type: job.job_type },
        };
      }
      const { data, error } = await supabase.rpc<unknown>(
        'delivery_health_snapshot',
        { p_lookback_minutes: 60 },
      );
      if (error) {
        return {
          status: 'failed',
          error: `delivery_health_snapshot failed: ${error.message}`,
        };
      }
      log('info', 'analytics_job_engagement_quality_pass_complete', {
        job_id: job.id,
        snapshot: data,
        trace_id: asString(payload.trace_id),
      });
      return { status: 'success', detail: { snapshot_taken: true } };
    }

    // Phase B fall-through — acknowledge unknown jobs so they do not
    // accumulate retry pressure.
    log('info', 'analytics_job_skipped_stub', {
      job_id: job.id,
      job_type: job.job_type,
    });
    return {
      status: 'skipped',
      reason: 'analytics processor stub (Phase B fallthrough)',
      detail: { job_type: job.job_type },
    };
  };
}
