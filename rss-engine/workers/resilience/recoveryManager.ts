/**
 * Phase E — Recovery manager.
 *
 * Single entry point for disaster-recovery primitives that the operator
 * invokes from runbooks (see `docs/DISASTER_RECOVERY.md` and
 * `docs/FAILOVER_RUNBOOK.md`). Each primitive is a thin wrapper around an
 * existing RPC so the recovery surface stays auditable and queue-safe.
 *
 * Primitives:
 *
 *   - queueReplay({queue, jobIds?})        — re-enqueue failed jobs from the
 *                                            DLQ (alias of `dlqReplay`).
 *   - dlqReplay({queue, jobIds?, max})     — explicit DLQ replay with
 *                                            per-call cap.
 *   - rankingRebuild({categories?})        — schedule selective ranking
 *                                            refresh; never global.
 *   - notificationReplay({since, max})     — re-fire `notification_events`
 *                                            in a bounded window. Goes
 *                                            through the dispatch pipeline
 *                                            so dedup holds.
 *   - workerStateRestore({workerId})       — release leases held by a
 *                                            crashed worker so its work can
 *                                            be re-leased by another.
 *
 * HARD RULES:
 *   - No primitive is allowed to scan the entire table without a cap.
 *     Defaults are conservative; the operator must pass `max` overrides
 *     when running large replays.
 *   - Every primitive emits a structured `recovery_*` log line so an
 *     incident timeline can be reconstructed from logs alone.
 *   - All replays must traverse the existing queue (so dedup, fanout
 *     suppression, and notification preferences hold).
 *   - No primitive bypasses RLS — RPCs are SECURITY DEFINER and the
 *     operator's identity is captured in the audit log via `p_initiator`.
 */

import type { LogFn } from '../lib/logger';
import type { QueueName, SupabaseLike } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecoveryContext {
  /** Operator identifier captured in audit logs. */
  initiator: string;
  /** Free-form reason captured with every primitive call. */
  reason: string;
}

export interface QueueReplayParams {
  queue: QueueName;
  jobIds?: ReadonlyArray<string>;
  /** Maximum jobs to replay in one call. Default 500. */
  max?: number;
}

export interface RankingRebuildParams {
  /** Restrict the rebuild to specific category ids. */
  categoryIds?: ReadonlyArray<string>;
  /** Maximum categories to enqueue. Default 50. */
  max?: number;
}

export interface NotificationReplayParams {
  /** Replay events occurring at or after this timestamp. */
  since: Date;
  /** Replay events occurring strictly before this timestamp. */
  until?: Date;
  /** Cap on events fired. Default 200. */
  max?: number;
  /** When true, only replay events that previously failed. */
  onlyFailed?: boolean;
}

export interface WorkerStateRestoreParams {
  workerId: string;
}

export interface RecoveryResult {
  primitive: string;
  ok: boolean;
  count: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface RecoveryManager {
  queueReplay(ctx: RecoveryContext, params: QueueReplayParams): Promise<RecoveryResult>;
  dlqReplay(ctx: RecoveryContext, params: QueueReplayParams): Promise<RecoveryResult>;
  rankingRebuild(ctx: RecoveryContext, params: RankingRebuildParams): Promise<RecoveryResult>;
  notificationReplay(ctx: RecoveryContext, params: NotificationReplayParams): Promise<RecoveryResult>;
  workerStateRestore(ctx: RecoveryContext, params: WorkerStateRestoreParams): Promise<RecoveryResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_DLQ_MAX = 500;
const DEFAULT_RANKING_MAX = 50;
const DEFAULT_NOTIFICATION_MAX = 200;

function logAudit(log: LogFn, ctx: RecoveryContext, primitive: string, payload: Record<string, unknown>): void {
  log('warn', `recovery_${primitive}`, {
    initiator: ctx.initiator,
    reason: ctx.reason,
    ...payload,
  });
}

export function createRecoveryManager(supabase: SupabaseLike, log: LogFn): RecoveryManager {
  async function dlqReplay(ctx: RecoveryContext, params: QueueReplayParams): Promise<RecoveryResult> {
    const max = Math.max(1, Math.min(params.max ?? DEFAULT_DLQ_MAX, 5_000));
    logAudit(log, ctx, 'dlq_replay_started', {
      queue: params.queue,
      job_count: params.jobIds?.length ?? null,
      max,
    });
    try {
      const { data, error } = await supabase.rpc<number>('replay_dead_letter_jobs', {
        p_queue_name: params.queue,
        p_job_ids: params.jobIds ?? null,
        p_max: max,
        p_initiator: ctx.initiator,
        p_reason: ctx.reason,
      });
      if (error) {
        logAudit(log, ctx, 'dlq_replay_failed', {
          queue: params.queue,
          error: error.message,
        });
        return { primitive: 'dlq_replay', ok: false, count: 0, error: error.message };
      }
      const n = typeof data === 'number' ? data : 0;
      logAudit(log, ctx, 'dlq_replay_completed', { queue: params.queue, count: n });
      return { primitive: 'dlq_replay', ok: true, count: n };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logAudit(log, ctx, 'dlq_replay_threw', { queue: params.queue, error: message });
      return { primitive: 'dlq_replay', ok: false, count: 0, error: message };
    }
  }

  async function queueReplay(ctx: RecoveryContext, params: QueueReplayParams): Promise<RecoveryResult> {
    // queueReplay is the documented alias.
    return dlqReplay(ctx, params);
  }

  async function rankingRebuild(ctx: RecoveryContext, params: RankingRebuildParams): Promise<RecoveryResult> {
    const max = Math.max(1, Math.min(params.max ?? DEFAULT_RANKING_MAX, 500));
    const categories = params.categoryIds ?? [];
    if (categories.length === 0) {
      // Per Phase E rules we never trigger a *global* recompute. The
      // operator MUST list the categories to rebuild. Surface this
      // refusal as a structured event for the incident timeline.
      logAudit(log, ctx, 'ranking_rebuild_refused_global', {});
      return {
        primitive: 'ranking_rebuild',
        ok: false,
        count: 0,
        error: 'global_rebuild_refused',
      };
    }
    const targets = categories.slice(0, max);
    let scheduled = 0;
    for (const categoryId of targets) {
      try {
        const { error } = await supabase.rpc('enqueue_job', {
          p_queue_name: 'ranking',
          p_job_type: 'refresh_ranked_feed_for_category',
          p_payload: { category_id: categoryId, source: 'recovery_manager', initiator: ctx.initiator },
          p_dedup_key: `recovery:ranking:${categoryId}:${Math.floor(Date.now() / 60_000)}`,
          p_priority: 50,
        });
        if (error) {
          logAudit(log, ctx, 'ranking_rebuild_enqueue_failed', {
            category_id: categoryId,
            error: error.message,
          });
          continue;
        }
        scheduled += 1;
      } catch (err) {
        logAudit(log, ctx, 'ranking_rebuild_enqueue_threw', {
          category_id: categoryId,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }
    logAudit(log, ctx, 'ranking_rebuild_completed', {
      scheduled,
      requested: targets.length,
    });
    return {
      primitive: 'ranking_rebuild',
      ok: scheduled > 0,
      count: scheduled,
      detail: { requested: targets.length },
    };
  }

  async function notificationReplay(ctx: RecoveryContext, params: NotificationReplayParams): Promise<RecoveryResult> {
    const max = Math.max(1, Math.min(params.max ?? DEFAULT_NOTIFICATION_MAX, 5_000));
    const sinceIso = params.since.toISOString();
    const untilIso = params.until ? params.until.toISOString() : null;
    logAudit(log, ctx, 'notification_replay_started', {
      since: sinceIso,
      until: untilIso,
      max,
      only_failed: !!params.onlyFailed,
    });
    try {
      const { data, error } = await supabase.rpc<number>('replay_notification_events', {
        p_since: sinceIso,
        p_until: untilIso,
        p_max: max,
        p_only_failed: !!params.onlyFailed,
        p_initiator: ctx.initiator,
        p_reason: ctx.reason,
      });
      if (error) {
        logAudit(log, ctx, 'notification_replay_failed', { error: error.message });
        return { primitive: 'notification_replay', ok: false, count: 0, error: error.message };
      }
      const n = typeof data === 'number' ? data : 0;
      logAudit(log, ctx, 'notification_replay_completed', { count: n });
      return { primitive: 'notification_replay', ok: true, count: n };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logAudit(log, ctx, 'notification_replay_threw', { error: message });
      return { primitive: 'notification_replay', ok: false, count: 0, error: message };
    }
  }

  async function workerStateRestore(ctx: RecoveryContext, params: WorkerStateRestoreParams): Promise<RecoveryResult> {
    logAudit(log, ctx, 'worker_state_restore_started', { worker_id: params.workerId });
    try {
      const { data, error } = await supabase.rpc<number>('reclaim_expired_leases', {
        p_worker_id: params.workerId,
      });
      if (error) {
        logAudit(log, ctx, 'worker_state_restore_failed', {
          worker_id: params.workerId,
          error: error.message,
        });
        return { primitive: 'worker_state_restore', ok: false, count: 0, error: error.message };
      }
      const n = typeof data === 'number' ? data : 0;
      logAudit(log, ctx, 'worker_state_restore_completed', {
        worker_id: params.workerId,
        reclaimed: n,
      });
      return { primitive: 'worker_state_restore', ok: true, count: n };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logAudit(log, ctx, 'worker_state_restore_threw', {
        worker_id: params.workerId,
        error: message,
      });
      return { primitive: 'worker_state_restore', ok: false, count: 0, error: message };
    }
  }

  return {
    queueReplay,
    dlqReplay,
    rankingRebuild,
    notificationReplay,
    workerStateRestore,
  };
}
