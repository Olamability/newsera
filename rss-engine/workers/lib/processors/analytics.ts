/**
 * Phase B — `process_analytics_job` (stub).
 *
 * Analytics rollups are still owned by pg_cron schedules registered in
 * migration 044. The queue path is reserved for ad-hoc / on-demand rollups
 * that the cron pipeline does not cover (e.g. backfill requests).
 *
 * For Phase B this processor acknowledges jobs as `skipped` so that any
 * upstream subsystem testing the analytics route does not accumulate retry
 * pressure on the queue. When the real analytics handlers land, this file
 * is the single integration point.
 */

import type { LogFn } from '../logger';
import type { LeasedJob, Processor, ProcessorResult } from '../types';

export interface AnalyticsProcessorDeps {
  log: LogFn;
}

export function createAnalyticsProcessor(deps: AnalyticsProcessorDeps): Processor {
  const { log } = deps;
  return async function processAnalyticsJob(
    job: LeasedJob,
  ): Promise<ProcessorResult> {
    log('info', 'analytics_job_skipped_stub', {
      job_id: job.id,
      job_type: job.job_type,
    });
    return {
      status: 'skipped',
      reason: 'analytics processor stub (Phase B)',
      detail: { job_type: job.job_type },
    };
  };
}
