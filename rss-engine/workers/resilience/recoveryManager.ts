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
// Phase F enhancement — replay idempotency
// ---------------------------------------------------------------------------
//
// Phase E shipped the primitives but Phase F adds explicit dedup safety:
//
//   - every primitive computes a stable `replay fingerprint` from
//     (primitive, normalised params, idempotency window). Two replays
//     with the same fingerprint inside the window are coalesced — the
//     second one returns `{ ok: true, count: 0, detail: { suppressed: true } }`
//     WITHOUT touching the database.
//   - operators may pass an explicit `idempotencyKey` to override the
//     auto-computed fingerprint (useful for runbooks where the same
//     replay is intentionally scheduled twice within the dedup window).
//   - every successful primitive call appends a `ReplayLineageEntry`
//     to the in-memory ledger so an operator can answer "did we already
//     replay X today?" from the dashboard. Lineage is bounded by
//     `lineageCapacity` (default 500).
//
// This protects the live platform from:
//   - duplicate user-visible notifications (notification replay storms)
//   - duplicate ranking jobs (per-category dedup already exists in the
//     queue, but lineage stops the operator from re-arming the same
//     rebuild before the queue dedup window closes)
//   - replay storms triggered by repeated operator clicks during an
//     incident.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecoveryContext {
  /** Operator identifier captured in audit logs. */
  initiator: string;
  /** Free-form reason captured with every primitive call. */
  reason: string;
  /**
   * Optional explicit idempotency key. When omitted the manager computes
   * a fingerprint from (primitive + normalised params + time bucket).
   * Use this to *force* a duplicate replay (e.g., pass a unique value
   * derived from an incident ID) inside the dedup window.
   */
  idempotencyKey?: string;
}

export interface ReplayLineageEntry {
  /** Auto-computed or operator-supplied idempotency key. */
  fingerprint: string;
  primitive: string;
  initiator: string;
  reason: string;
  at: Date;
  count: number;
  /** Number of times this fingerprint has been suppressed. */
  suppressions: number;
  /** Subsystem touched (queue / category-set / time window). */
  target: string;
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
  /** Recent replay lineage entries (newest first). For the operator dashboard. */
  lineage(): ReplayLineageEntry[];
}

export interface RecoveryManagerOptions {
  /** Idempotency dedup window in ms. Default 5 minutes. */
  idempotencyWindowMs?: number;
  /** Maximum lineage entries retained. Default 500. */
  lineageCapacity?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_DLQ_MAX = 500;
const DEFAULT_RANKING_MAX = 50;
const DEFAULT_NOTIFICATION_MAX = 200;
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 5 * 60_000;
const DEFAULT_LINEAGE_CAPACITY = 500;

function fnv1a(input: string): string {
  // Simple, deterministic, dependency-free 32-bit FNV-1a; sufficient for
  // bucketing replay fingerprints in-memory.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableTargetForQueue(params: QueueReplayParams): string {
  const ids = (params.jobIds ?? []).slice().sort().join(',');
  return `queue=${params.queue};ids=${ids};max=${params.max ?? DEFAULT_DLQ_MAX}`;
}

function stableTargetForRanking(params: RankingRebuildParams): string {
  const cats = (params.categoryIds ?? []).slice().sort().join(',');
  return `cats=${cats};max=${params.max ?? DEFAULT_RANKING_MAX}`;
}

function stableTargetForNotification(params: NotificationReplayParams): string {
  return [
    `since=${params.since.toISOString()}`,
    `until=${params.until ? params.until.toISOString() : 'open'}`,
    `max=${params.max ?? DEFAULT_NOTIFICATION_MAX}`,
    `only_failed=${!!params.onlyFailed}`,
  ].join(';');
}

function logAudit(log: LogFn, ctx: RecoveryContext, primitive: string, payload: Record<string, unknown>): void {
  log('warn', `recovery_${primitive}`, {
    initiator: ctx.initiator,
    reason: ctx.reason,
    ...payload,
  });
}

export function createRecoveryManager(
  supabase: SupabaseLike,
  log: LogFn,
  opts: RecoveryManagerOptions = {},
): RecoveryManager {
  const idempotencyWindowMs = Math.max(opts.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS, 30_000);
  const lineageCapacity = Math.max(opts.lineageCapacity ?? DEFAULT_LINEAGE_CAPACITY, 10);
  const now = opts.now ?? (() => Date.now());

  const lineageEntries: ReplayLineageEntry[] = [];
  const lineageIndex = new Map<string, ReplayLineageEntry>();

  function fingerprint(primitive: string, ctx: RecoveryContext, target: string): string {
    if (ctx.idempotencyKey) return ctx.idempotencyKey;
    const bucket = Math.floor(now() / idempotencyWindowMs);
    return `${primitive}:${fnv1a(`${primitive}|${target}|${bucket}`)}`;
  }

  function recordLineage(
    fp: string,
    primitive: string,
    ctx: RecoveryContext,
    target: string,
    count: number,
    suppressed: boolean,
  ): ReplayLineageEntry {
    const existing = lineageIndex.get(fp);
    const tNow = new Date(now());
    if (existing) {
      existing.at = tNow;
      if (suppressed) existing.suppressions += 1;
      else existing.count += count;
      return existing;
    }
    const entry: ReplayLineageEntry = {
      fingerprint: fp,
      primitive,
      initiator: ctx.initiator,
      reason: ctx.reason,
      at: tNow,
      count: suppressed ? 0 : count,
      suppressions: suppressed ? 1 : 0,
      target,
    };
    lineageIndex.set(fp, entry);
    lineageEntries.unshift(entry);
    if (lineageEntries.length > lineageCapacity) {
      const dropped = lineageEntries.pop();
      if (dropped) lineageIndex.delete(dropped.fingerprint);
    }
    return entry;
  }

  function maybeSuppress(
    primitive: string,
    ctx: RecoveryContext,
    target: string,
  ): { suppressed: boolean; fp: string; previous?: ReplayLineageEntry } {
    const fp = fingerprint(primitive, ctx, target);
    const previous = lineageIndex.get(fp);
    if (previous && now() - previous.at.getTime() < idempotencyWindowMs && previous.count > 0) {
      recordLineage(fp, primitive, ctx, target, 0, true);
      logAudit(log, ctx, `${primitive}_suppressed_duplicate`, {
        fingerprint: fp,
        previous_at: previous.at.toISOString(),
        previous_count: previous.count,
        target,
      });
      return { suppressed: true, fp, previous };
    }
    return { suppressed: false, fp };
  }

  async function dlqReplay(ctx: RecoveryContext, params: QueueReplayParams): Promise<RecoveryResult> {
    const max = Math.max(1, Math.min(params.max ?? DEFAULT_DLQ_MAX, 5_000));
    const target = stableTargetForQueue({ ...params, max });
    const sup = maybeSuppress('dlq_replay', ctx, target);
    if (sup.suppressed) {
      return {
        primitive: 'dlq_replay',
        ok: true,
        count: 0,
        detail: { suppressed: true, fingerprint: sup.fp },
      };
    }
    logAudit(log, ctx, 'dlq_replay_started', {
      queue: params.queue,
      job_count: params.jobIds?.length ?? null,
      max,
      fingerprint: sup.fp,
    });
    try {
      const { data, error } = await supabase.rpc<number>('replay_dead_letter_jobs', {
        p_queue_name: params.queue,
        p_job_ids: params.jobIds ?? null,
        p_max: max,
        p_initiator: ctx.initiator,
        p_reason: ctx.reason,
        p_fingerprint: sup.fp,
      });
      if (error) {
        logAudit(log, ctx, 'dlq_replay_failed', {
          queue: params.queue,
          error: error.message,
        });
        return { primitive: 'dlq_replay', ok: false, count: 0, error: error.message };
      }
      const n = typeof data === 'number' ? data : 0;
      recordLineage(sup.fp, 'dlq_replay', ctx, target, n, false);
      logAudit(log, ctx, 'dlq_replay_completed', { queue: params.queue, count: n, fingerprint: sup.fp });
      return { primitive: 'dlq_replay', ok: true, count: n, detail: { fingerprint: sup.fp } };
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
    const target = stableTargetForRanking({ ...params, max });
    const sup = maybeSuppress('ranking_rebuild', ctx, target);
    if (sup.suppressed) {
      return {
        primitive: 'ranking_rebuild',
        ok: true,
        count: 0,
        detail: { suppressed: true, fingerprint: sup.fp },
      };
    }
    let scheduled = 0;
    for (const categoryId of targets) {
      try {
        const { error } = await supabase.rpc('enqueue_job', {
          p_queue_name: 'ranking',
          p_job_type: 'refresh_ranked_feed_for_category',
          p_payload: {
            category_id: categoryId,
            source: 'recovery_manager',
            initiator: ctx.initiator,
            fingerprint: sup.fp,
          },
          p_dedup_key: `recovery:ranking:${categoryId}:${Math.floor(now() / 60_000)}`,
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
    recordLineage(sup.fp, 'ranking_rebuild', ctx, target, scheduled, false);
    logAudit(log, ctx, 'ranking_rebuild_completed', {
      scheduled,
      requested: targets.length,
      fingerprint: sup.fp,
    });
    return {
      primitive: 'ranking_rebuild',
      ok: scheduled > 0,
      count: scheduled,
      detail: { requested: targets.length, fingerprint: sup.fp },
    };
  }

  async function notificationReplay(ctx: RecoveryContext, params: NotificationReplayParams): Promise<RecoveryResult> {
    const max = Math.max(1, Math.min(params.max ?? DEFAULT_NOTIFICATION_MAX, 5_000));
    const sinceIso = params.since.toISOString();
    const untilIso = params.until ? params.until.toISOString() : null;
    const target = stableTargetForNotification({ ...params, max });
    const sup = maybeSuppress('notification_replay', ctx, target);
    if (sup.suppressed) {
      return {
        primitive: 'notification_replay',
        ok: true,
        count: 0,
        detail: { suppressed: true, fingerprint: sup.fp },
      };
    }
    logAudit(log, ctx, 'notification_replay_started', {
      since: sinceIso,
      until: untilIso,
      max,
      only_failed: !!params.onlyFailed,
      fingerprint: sup.fp,
    });
    try {
      const { data, error } = await supabase.rpc<number>('replay_notification_events', {
        p_since: sinceIso,
        p_until: untilIso,
        p_max: max,
        p_only_failed: !!params.onlyFailed,
        p_initiator: ctx.initiator,
        p_reason: ctx.reason,
        p_fingerprint: sup.fp,
      });
      if (error) {
        logAudit(log, ctx, 'notification_replay_failed', { error: error.message });
        return { primitive: 'notification_replay', ok: false, count: 0, error: error.message };
      }
      const n = typeof data === 'number' ? data : 0;
      recordLineage(sup.fp, 'notification_replay', ctx, target, n, false);
      logAudit(log, ctx, 'notification_replay_completed', { count: n, fingerprint: sup.fp });
      return { primitive: 'notification_replay', ok: true, count: n, detail: { fingerprint: sup.fp } };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logAudit(log, ctx, 'notification_replay_threw', { error: message });
      return { primitive: 'notification_replay', ok: false, count: 0, error: message };
    }
  }

  async function workerStateRestore(ctx: RecoveryContext, params: WorkerStateRestoreParams): Promise<RecoveryResult> {
    const target = `worker=${params.workerId}`;
    const sup = maybeSuppress('worker_state_restore', ctx, target);
    if (sup.suppressed) {
      return {
        primitive: 'worker_state_restore',
        ok: true,
        count: 0,
        detail: { suppressed: true, fingerprint: sup.fp },
      };
    }
    logAudit(log, ctx, 'worker_state_restore_started', { worker_id: params.workerId, fingerprint: sup.fp });
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
      recordLineage(sup.fp, 'worker_state_restore', ctx, target, Math.max(n, 1), false);
      logAudit(log, ctx, 'worker_state_restore_completed', {
        worker_id: params.workerId,
        reclaimed: n,
        fingerprint: sup.fp,
      });
      return { primitive: 'worker_state_restore', ok: true, count: n, detail: { fingerprint: sup.fp } };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logAudit(log, ctx, 'worker_state_restore_threw', {
        worker_id: params.workerId,
        error: message,
      });
      return { primitive: 'worker_state_restore', ok: false, count: 0, error: message };
    }
  }

  function lineage(): ReplayLineageEntry[] {
    return lineageEntries.map((e) => ({ ...e }));
  }

  return {
    queueReplay,
    dlqReplay,
    rankingRebuild,
    notificationReplay,
    workerStateRestore,
    lineage,
  };
}
