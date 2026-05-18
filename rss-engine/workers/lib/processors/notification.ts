/**
 * Phase C — `process_notification_job` (now wired to the dispatch engine).
 *
 * Phase B shipped this processor as a stub: notification jobs were either
 * silently skipped (flag off) or hard-failed (flag on). Phase C closes
 * both gaps:
 *
 *   Flag OFF →   structured `skipped_feature_flag` result so observers can
 *                trace exactly *why* a job was dropped (closes the Phase B
 *                "notification skipped ambiguity" debt). The job is still
 *                acknowledged so the queue does not grow unboundedly.
 *
 *   Flag ON  →   the processor delegates to the fanout engine which
 *                resolves the audience, enqueues the `notification_events`
 *                row, and triggers `materialize_notification_event`. Push
 *                delivery is handled by a separate runner that drains the
 *                staged `notification_deliveries` rows.
 *
 * The processor itself is intentionally thin — all heavy lifting lives in
 * `notification/fanout.ts`. This makes the processor easy to unit test and
 * keeps `lib/processors/` free of dispatch-specific schema knowledge.
 */

import type { LogFn } from '../logger';
import type { CategoryNormalizer } from '../normalizeCategory';
import type {
  FanoutRequest,
  NotificationAudienceType,
  NotificationEventType,
} from '../../notification/fanout';
import { createFanoutEngine } from '../../notification/fanout';
import type { FanoutEngine } from '../../notification/fanout';
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
  /**
   * Optional fanout engine override — when omitted, the processor builds
   * its own from the injected supabase + normalizer. Tests use this to
   * stub fanout behaviour without going through the whole RPC chain.
   */
  fanout?: FanoutEngine;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out.length === 0 ? null : out;
}

/**
 * Map a queue job payload to a fanout request. Keeps the processor free of
 * audience-resolution knowledge and produces a single, well-typed object the
 * fanout engine can validate.
 */
function buildFanoutRequest(job: LeasedJob): {
  req: FanoutRequest | null;
  reason?: string;
} {
  const payload = job.payload ?? {};

  const eventType = asString(payload.event_type) as NotificationEventType | null;
  const audience = asString(payload.audience) as NotificationAudienceType | null;
  const title = asString(payload.title);
  const body = asString(payload.body);

  if (!eventType || !audience || !title || !body) {
    return { req: null, reason: 'missing_required_fields' };
  }

  const allowedEvents: NotificationEventType[] = [
    'breaking_news',
    'followed_category',
    'engagement_alert',
    'admin_broadcast',
    'personalized_recommendation',
    'reward',
    'editorial',
  ];
  if (!allowedEvents.includes(eventType)) {
    return { req: null, reason: 'invalid_event_type' };
  }

  const allowedAudiences: NotificationAudienceType[] = [
    'single_user',
    'category_followers',
    'global',
    'source_followers',
  ];
  if (!allowedAudiences.includes(audience)) {
    return { req: null, reason: 'invalid_audience' };
  }

  const priorityRaw = payload.priority;
  const priority =
    typeof priorityRaw === 'number' && Number.isFinite(priorityRaw)
      ? Math.min(Math.max(Math.round(priorityRaw), 1), 10)
      : undefined;

  return {
    req: {
      eventType,
      audience,
      title,
      body,
      userId: asString(payload.user_id),
      categoryId: asString(payload.category_id),
      sourceId: asString(payload.source_id),
      articleId: asString(payload.article_id),
      payload: (payload.payload ?? {}) as Record<string, unknown>,
      priority,
      channels: (asStringArray(payload.channels) ?? undefined) as
        | ReadonlyArray<'inbox' | 'push' | 'realtime' | 'email'>
        | undefined,
      dedupKey: asString(payload.dedup_key),
      maxRecipients:
        typeof payload.max_recipients === 'number'
          ? Math.max(1, Math.floor(payload.max_recipients))
          : undefined,
    },
  };
}

export function createNotificationProcessor(
  deps: NotificationProcessorDeps,
): Processor {
  const { supabase, log, normalizer, isDispatchEnabled } = deps;
  const fanout: FanoutEngine =
    deps.fanout ?? createFanoutEngine({ supabase, log, normalizer });

  return async function processNotificationJob(
    job: LeasedJob,
  ): Promise<ProcessorResult> {
    const enabled = await isDispatchEnabled();
    if (!enabled) {
      // Phase C — structured skip. Replaces the Phase B silent skip so
      // downstream traceability/alerting can distinguish a flag-off
      // acknowledgement from a "we don't know how to handle this" skip.
      // The shape mirrors the contract in the problem statement.
      return {
        status: 'skipped',
        reason: 'backend_notification_dispatch_disabled',
        detail: {
          status: 'skipped_feature_flag',
          queue: 'notification',
          reason: 'backend_notification_dispatch_disabled',
          traceable: true,
          job_type: job.job_type,
        },
      };
    }

    const { req, reason } = buildFanoutRequest(job);
    if (!req) {
      log('warn', 'notification_job_invalid_payload', {
        job_id: job.id,
        job_type: job.job_type,
        reason,
      });
      return {
        status: 'failed',
        error: `notification_job: ${reason ?? 'invalid_payload'}`,
      };
    }

    const result = await fanout.fanout(req);
    if (!result.ok) {
      return {
        status: 'failed',
        error: `fanout_failed: ${result.reason ?? 'unknown'}`,
        detail: { event_id: result.eventId, audience: req.audience },
      };
    }

    return {
      status: 'success',
      detail: {
        event_id: result.eventId,
        recipients: result.recipients,
        deduped: result.deduped,
        audience: req.audience,
        event_type: req.eventType,
      },
    };
  };
}
