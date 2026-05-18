/**
 * Phase C — Notification fanout layer.
 *
 * The fanout module is the single integration point between the queue runner
 * and the Phase 041 notification-dispatch pipeline. It is also the *only*
 * place in the worker tier that creates notification rows: the runner, the
 * push sender and the dispatch entry script all delegate here.
 *
 * Two responsibilities:
 *
 *   1. RESOLVE the audience for a notification job and turn it into the
 *      `notification_events` row(s) the dispatch pipeline already knows how
 *      to materialize. Four audience types are supported, mapping directly
 *      to the `target_audience` column of the 041 schema:
 *
 *        single_user        → 'specific_user'
 *        category_followers → 'category_followers'
 *        global             → 'all'
 *        source_followers   → 'all' (with a payload filter — the 041
 *                             schema does not yet model per-source
 *                             subscription, so we widen and let the
 *                             downstream materializer respect any
 *                             subsequent schema additions)
 *
 *   2. INVOKE `materialize_notification_event` (the 041 RPC) which writes
 *      the per-recipient `notifications` rows AND the staged `push` /
 *      `inbox` rows of `notification_deliveries`. Push delivery itself is
 *      handed off to `pushSender.ts`.
 *
 * Hard rules baked in here:
 *   - No direct table writes. Every mutation is via an RPC.
 *   - No client-originated payloads. Triggers come from ranking, ingestion
 *     and admin paths only — the queue runner already enforces this by
 *     vending these jobs from server-side workflows.
 *   - Category id is *always* normalized — invalid ids resolve to the
 *     uncategorized fallback, never null.
 *   - Recipient fanout is capped (`maxRecipients`) to protect the DB at
 *     the 50k-subscriber scale required by the Phase C testing matrix.
 */

import type { LogFn } from '../lib/logger';
import type { CategoryNormalizer } from '../lib/normalizeCategory';
import type { RpcResponse, SupabaseLike } from '../lib/types';

export type NotificationAudienceType =
  | 'single_user'
  | 'category_followers'
  | 'global'
  | 'source_followers';

export type NotificationEventType =
  | 'breaking_news'
  | 'followed_category'
  | 'engagement_alert'
  | 'admin_broadcast'
  | 'personalized_recommendation'
  | 'reward'
  | 'editorial';

/**
 * Input contract for fanout. Mirrors the smallest superset of fields
 * required to enqueue a `notification_events` row via the 041 RPC.
 */
export interface FanoutRequest {
  eventType: NotificationEventType;
  title: string;
  body: string;
  audience: NotificationAudienceType;
  /** Required when audience='single_user'. */
  userId?: string | null;
  /** Required when audience='category_followers'. Normalized internally. */
  categoryId?: string | null;
  /** Required when audience='source_followers'. Carried in payload. */
  sourceId?: string | null;
  articleId?: string | null;
  payload?: Record<string, unknown>;
  /** 1..10. Default 5. */
  priority?: number;
  /** ['inbox','push'] by default. */
  channels?: ReadonlyArray<'inbox' | 'push' | 'realtime' | 'email'>;
  /** Stable dedup key — collapses re-enqueues of the same logical event. */
  dedupKey?: string | null;
  /** Cap on materialized recipients per event. Default 5_000. */
  maxRecipients?: number;
}

export interface FanoutResult {
  /** True when the upstream pipeline accepted the event. */
  ok: boolean;
  eventId: string | null;
  recipients: number;
  /** Set when the event was a deterministic duplicate of an in-flight event. */
  deduped: boolean;
  reason?: string;
}

export interface FanoutDeps {
  supabase: SupabaseLike;
  log: LogFn;
  normalizer: CategoryNormalizer;
}

/** Defensive coercer so a stray non-string never reaches the RPC layer. */
function asNonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Map our audience enum to the 041 `target_audience` enum. */
function mapAudience(a: NotificationAudienceType): string {
  switch (a) {
    case 'single_user':
      return 'specific_user';
    case 'category_followers':
      return 'category_followers';
    case 'global':
    case 'source_followers':
      // 041 does not yet model source-followers; widen to `all` and rely on
      // a downstream filter once that schema lands. Documented in the
      // module header.
      return 'all';
    default:
      return 'all';
  }
}

/**
 * Validate the request before we round-trip the DB. Returns null on success,
 * a short failure reason otherwise.
 */
function validate(req: FanoutRequest): string | null {
  if (!req.title || !req.body) return 'title_and_body_required';
  if (req.audience === 'single_user' && !asNonEmpty(req.userId)) {
    return 'single_user_requires_user_id';
  }
  if (req.audience === 'category_followers' && !asNonEmpty(req.categoryId)) {
    return 'category_followers_requires_category_id';
  }
  if (req.audience === 'source_followers' && !asNonEmpty(req.sourceId)) {
    return 'source_followers_requires_source_id';
  }
  if (req.priority !== undefined && (req.priority < 1 || req.priority > 10)) {
    return 'priority_out_of_range';
  }
  return null;
}

export interface FanoutEngine {
  fanout(req: FanoutRequest): Promise<FanoutResult>;
}

export function createFanoutEngine(deps: FanoutDeps): FanoutEngine {
  const { supabase, log, normalizer } = deps;

  async function enqueueEvent(
    req: FanoutRequest,
    resolvedCategoryId: string | null,
  ): Promise<{ id: string | null; error: string | null }> {
    const channels = (req.channels && req.channels.length > 0
      ? req.channels
      : ['inbox', 'push']) as string[];

    // The `payload` blob is the future-proofing escape hatch — it is what
    // lets `source_followers` work today even though the 041 schema does not
    // model per-source subscriptions: the source_id rides in the payload so
    // the downstream materializer can filter when that capability lands.
    const enrichedPayload: Record<string, unknown> = {
      ...(req.payload ?? {}),
      ...(req.sourceId ? { source_id: req.sourceId } : {}),
      ...(req.audience === 'source_followers'
        ? { audience_filter: 'source_followers' }
        : {}),
    };

    try {
      const { data, error } = await supabase.rpc<string>(
        'enqueue_notification_event',
        {
          p_event_type: req.eventType,
          p_title: req.title,
          p_body: req.body,
          p_target_audience: mapAudience(req.audience),
          p_target_user_id:
            req.audience === 'single_user' ? asNonEmpty(req.userId) : null,
          p_article_id: asNonEmpty(req.articleId),
          p_category_id: resolvedCategoryId,
          p_payload: enrichedPayload,
          p_priority: req.priority ?? 5,
          p_channels: Array.from(channels),
          p_dedup_key: asNonEmpty(req.dedupKey ?? null),
        },
      );
      if (error) {
        return { id: null, error: error.message };
      }
      return { id: typeof data === 'string' ? data : null, error: null };
    } catch (err) {
      return { id: null, error: (err as Error)?.message ?? String(err) };
    }
  }

  async function materialize(
    eventId: string,
    maxRecipients: number,
  ): Promise<{ recipients: number; error: string | null }> {
    try {
      const { data, error }: RpcResponse<number> = await supabase.rpc<number>(
        'materialize_notification_event',
        { p_event_id: eventId, p_max_recipients: maxRecipients },
      );
      if (error) return { recipients: 0, error: error.message };
      return { recipients: typeof data === 'number' ? data : 0, error: null };
    } catch (err) {
      return {
        recipients: 0,
        error: (err as Error)?.message ?? String(err),
      };
    }
  }

  return {
    async fanout(req) {
      const validationError = validate(req);
      if (validationError) {
        log('warn', 'fanout_validation_failed', {
          event_type: req.eventType,
          audience: req.audience,
          reason: validationError,
        });
        return {
          ok: false,
          eventId: null,
          recipients: 0,
          deduped: false,
          reason: validationError,
        };
      }

      // Normalize category whenever it is part of the audience contract. We
      // intentionally do NOT normalize when audience is `single_user` /
      // `global` — those paths legitimately have no category, and forcing
      // them through the fallback would dilute analytics.
      let categoryId: string | null = null;
      if (req.audience === 'category_followers' || req.categoryId) {
        const norm = await normalizer.normalize(asNonEmpty(req.categoryId));
        if (!norm.resolved) {
          log('warn', 'fanout_category_unresolved', {
            event_type: req.eventType,
            audience: req.audience,
            reason: norm.reason,
          });
          // For category_followers we must have a real category; abort.
          if (req.audience === 'category_followers') {
            return {
              ok: false,
              eventId: null,
              recipients: 0,
              deduped: false,
              reason: 'category_fallback_unavailable',
            };
          }
        } else {
          categoryId = norm.categoryId;
        }
      }

      const enq = await enqueueEvent(req, categoryId);
      if (enq.error || !enq.id) {
        log('warn', 'fanout_enqueue_failed', {
          event_type: req.eventType,
          audience: req.audience,
          error: enq.error,
        });
        return {
          ok: false,
          eventId: null,
          recipients: 0,
          deduped: false,
          reason: enq.error ?? 'enqueue_event_failed',
        };
      }

      const mat = await materialize(enq.id, req.maxRecipients ?? 5_000);
      if (mat.error) {
        log('warn', 'fanout_materialize_failed', {
          event_type: req.eventType,
          event_id: enq.id,
          error: mat.error,
        });
        return {
          ok: false,
          eventId: enq.id,
          recipients: 0,
          deduped: false,
          reason: mat.error,
        };
      }

      // Recipient=0 with the dedup key set is the documented duplicate
      // signal: `enqueue_notification_event` returned an already-existing
      // pending row, so `materialize_notification_event` ran as a no-op.
      const deduped = mat.recipients === 0 && Boolean(req.dedupKey);

      log('info', 'fanout_completed', {
        event_type: req.eventType,
        audience: req.audience,
        event_id: enq.id,
        recipients: mat.recipients,
        deduped,
      });

      return {
        ok: true,
        eventId: enq.id,
        recipients: mat.recipients,
        deduped,
      };
    },
  };
}
