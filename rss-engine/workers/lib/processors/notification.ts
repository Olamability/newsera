/**
 * Phase B — `process_notification_job` (stub, feature-flagged OFF).
 *
 * The notification dispatch pipeline (migration 041) is intentionally not yet
 * activated. This processor exists so the queue runner can route notification
 * jobs *today* — they will be skipped (not failed) while the
 * `backend_notification_dispatch` flag is off, so payloads enqueued by other
 * subsystems do not pile up in the DLQ before the dispatcher is turned on.
 *
 * When the flag flips on, the stub becomes the integration point:
 *   - resolve the user/category via the normalizer
 *   - call `materialize_notification_event` (Phase 041 RPC)
 *
 * For Phase B we ship the routing + skip path only. The stubbed branch is
 * kept inert so any accidental flag-on event in non-prod does not silently
 * send notifications.
 */

import type { LogFn } from '../logger';
import type { CategoryNormalizer } from '../normalizeCategory';
import type { LeasedJob, Processor, ProcessorResult, SupabaseLike } from '../types';

export interface NotificationProcessorDeps {
  supabase: SupabaseLike;
  log: LogFn;
  normalizer: CategoryNormalizer;
  /**
   * Live feature-flag probe. The runner injects a closure that calls
   * `is_feature_enabled('backend_notification_dispatch')` so flag flips are
   * observed without a process restart.
   */
  isDispatchEnabled: () => Promise<boolean>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createNotificationProcessor(
  deps: NotificationProcessorDeps,
): Processor {
  const { log, normalizer, isDispatchEnabled } = deps;

  return async function processNotificationJob(
    job: LeasedJob,
  ): Promise<ProcessorResult> {
    const enabled = await isDispatchEnabled();
    if (!enabled) {
      // `skipped` → runner calls `complete_job`, no retry, no DLQ. Jobs that
      // arrive while the dispatcher is off are acknowledged so the queue does
      // not grow unboundedly.
      return {
        status: 'skipped',
        reason: 'backend_notification_dispatch flag off',
        detail: { job_type: job.job_type },
      };
    }

    // Defensive: even with the flag on, the Phase B PR does not ship the
    // dispatcher wiring. We refuse to send notifications until that lands.
    log('warn', 'notification_processor_invoked_with_no_dispatch_wired', {
      job_id: job.id,
      job_type: job.job_type,
    });

    // Normalize category if present so future dispatcher consumers always see
    // a clean payload (forward-compatible).
    const rawCategory = asString(job.payload?.category_id);
    if (rawCategory !== null) {
      await normalizer.normalize(rawCategory);
    }

    return {
      status: 'failed',
      error:
        'notification dispatch not yet wired in Phase B — leave flag off or implement dispatcher',
    };
  };
}
