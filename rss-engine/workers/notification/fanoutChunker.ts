/**
 * Phase D — Notification fanout chunker.
 *
 * Closes the Phase C "notification fanout scaling debt" leftover.
 *
 * Phase C's fanout engine resolves the audience and materializes
 * `notification_deliveries` inside a single RPC. That works up to the
 * `maxRecipients` cap (default 5_000) but at large audience sizes a
 * single materialize call writes a *huge* burst to the database. This
 * module shards a giant audience into queueable chunks of at most
 * `CHUNK_SIZE` recipients each, emits one `notification` queue job per
 * chunk via `enqueue_job`, and records lineage in
 * `notification_fanout_chunks` (migration 048).
 *
 * Lineage rules:
 *   - Every chunk carries the same `trace_id`. If the caller doesn't
 *     provide one, the chunker mints a stable id and re-uses it across
 *     all chunks so observability can reconstruct the fanout.
 *   - `parent_dedup_key` collapses re-issues of the same fanout (e.g.
 *     a retry of the parent job) — no duplicate child jobs are emitted.
 *
 * The chunker is database-agnostic against the existing `SupabaseLike`
 * surface; it only calls `enqueue_job` and `record_fanout_chunk` (and
 * tolerates the lineage RPC being absent during partial deploys).
 */

import type { LogFn } from '../lib/logger';
import type { RpcResponse, SupabaseLike } from '../lib/types';

/** Hard cap per chunk. Mandated by the Phase C leftover spec ("1,000 recipients"). */
export const FANOUT_CHUNK_SIZE = 1_000;

export interface FanoutChunkerDeps {
  supabase: SupabaseLike;
  log: LogFn;
}

export interface FanoutChunkRequest {
  /** parent fanout request — the chunker reproduces this shape per chunk. */
  eventType: string;
  audience: string;
  title: string;
  body: string;
  /** Total resolved recipient ids. The chunker shards over this. */
  recipientUserIds: ReadonlyArray<string>;
  parentEventId?: string | null;
  parentDedupKey?: string | null;
  /** Trace id — minted if absent and reused for all chunks. */
  traceId?: string | null;
  /** Extra payload merged into each child job. */
  payload?: Record<string, unknown>;
  priority?: number;
  channels?: ReadonlyArray<string>;
  /** Override chunk size (capped at FANOUT_CHUNK_SIZE). */
  chunkSize?: number;
}

export interface FanoutChunkRecord {
  chunkIndex: number;
  chunkTotal: number;
  recipientCount: number;
  jobId: string | null;
  chunkRowId: string | null;
}

export interface FanoutChunkResult {
  ok: boolean;
  traceId: string;
  chunkTotal: number;
  jobsEnqueued: number;
  duplicatesSkipped: number;
  failures: number;
  chunks: FanoutChunkRecord[];
  reason?: string;
}

/**
 * Cheap unique-ish trace id. No need for UUID strength — this is only
 * used to correlate logs. Avoids importing node:crypto so the module
 * stays usable from environments without it (unlikely in our worker
 * runtime, but keeps the boundary clean).
 */
function mintTraceId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `fc-${t}-${r}`;
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export interface FanoutChunker {
  chunkAndEmit(req: FanoutChunkRequest): Promise<FanoutChunkResult>;
}

export function createFanoutChunker(deps: FanoutChunkerDeps): FanoutChunker {
  const { supabase, log } = deps;

  async function recordChunkRow(
    parentEventId: string | null,
    parentDedupKey: string | null,
    traceId: string,
    chunkIndex: number,
    chunkTotal: number,
    recipientCount: number,
    jobId: string | null,
  ): Promise<string | null> {
    try {
      const { data, error }: RpcResponse<string> = await supabase.rpc<string>(
        'record_fanout_chunk',
        {
          p_parent_event_id: parentEventId,
          p_parent_dedup_key: parentDedupKey,
          p_trace_id: traceId,
          p_chunk_index: chunkIndex,
          p_chunk_total: chunkTotal,
          p_recipient_count: recipientCount,
          p_job_id: jobId,
        },
      );
      if (error) {
        // Lineage table is best-effort. Log and continue; the child job
        // is the source of truth.
        log('debug', 'record_fanout_chunk_unavailable', {
          trace_id: traceId,
          error: error.message,
        });
        return null;
      }
      return typeof data === 'string' ? data : null;
    } catch (err) {
      log('debug', 'record_fanout_chunk_threw', {
        trace_id: traceId,
        error: (err as Error)?.message ?? String(err),
      });
      return null;
    }
  }

  async function enqueueChildJob(
    req: FanoutChunkRequest,
    traceId: string,
    chunkIndex: number,
    chunkTotal: number,
    recipientIds: ReadonlyArray<string>,
  ): Promise<{ jobId: string | null; deduped: boolean; error: string | null }> {
    const baseDedup = req.parentDedupKey
      ? `${req.parentDedupKey}:chunk:${chunkIndex}`
      : `fanout:${traceId}:chunk:${chunkIndex}`;
    const payload: Record<string, unknown> = {
      ...(req.payload ?? {}),
      event_type: req.eventType,
      audience: req.audience,
      title: req.title,
      body: req.body,
      channels: req.channels ?? ['inbox', 'push'],
      // Child-only fields.
      trace_id: traceId,
      parent_event_id: req.parentEventId ?? null,
      parent_dedup_key: req.parentDedupKey ?? null,
      chunk_index: chunkIndex,
      chunk_total: chunkTotal,
      recipient_user_ids: Array.from(recipientIds),
      recipient_count: recipientIds.length,
      max_recipients: recipientIds.length,
    };

    try {
      const { data, error }: RpcResponse<string> = await supabase.rpc<string>(
        'enqueue_job',
        {
          p_queue_name: 'notification',
          p_job_type: 'dispatch_chunk',
          p_payload: payload,
          p_dedup_key: baseDedup,
          p_priority: req.priority ?? 5,
          p_max_attempts: 3,
        },
      );
      if (error) {
        return { jobId: null, deduped: false, error: error.message };
      }
      return {
        jobId: typeof data === 'string' ? data : null,
        deduped: false, // best-effort: enqueue_job returns existing id on dedup,
        // but we can't distinguish without a second probe. We rely on the
        // dedup_key collapsing duplicate writes server-side, which is enough.
        error: null,
      };
    } catch (err) {
      return {
        jobId: null,
        deduped: false,
        error: (err as Error)?.message ?? String(err),
      };
    }
  }

  return {
    async chunkAndEmit(req) {
      const traceId = req.traceId ?? mintTraceId();
      const recipients = req.recipientUserIds ?? [];
      const size = Math.min(
        Math.max(1, req.chunkSize ?? FANOUT_CHUNK_SIZE),
        FANOUT_CHUNK_SIZE,
      );

      if (recipients.length === 0) {
        log('info', 'fanout_chunker_no_recipients', { trace_id: traceId });
        return {
          ok: true,
          traceId,
          chunkTotal: 0,
          jobsEnqueued: 0,
          duplicatesSkipped: 0,
          failures: 0,
          chunks: [],
        };
      }

      const buckets = chunk(recipients, size);
      const total = buckets.length;
      const records: FanoutChunkRecord[] = [];
      let jobsEnqueued = 0;
      let duplicatesSkipped = 0;
      let failures = 0;

      // De-dup detection across already-seen job ids in this batch. If
      // enqueue_job returns the same id twice (because the same dedup key
      // collapsed) we count it as a duplicate to keep stats honest.
      const seenJobIds = new Set<string>();

      for (let i = 0; i < buckets.length; i += 1) {
        const bucket = buckets[i];
        // eslint-disable-next-line no-await-in-loop
        const r = await enqueueChildJob(req, traceId, i, total, bucket);
        if (r.error) {
          failures += 1;
          log('warn', 'fanout_chunker_child_enqueue_failed', {
            trace_id: traceId,
            chunk_index: i,
            error: r.error,
          });
        } else if (r.jobId && seenJobIds.has(r.jobId)) {
          duplicatesSkipped += 1;
        } else if (r.jobId) {
          seenJobIds.add(r.jobId);
          jobsEnqueued += 1;
        }
        // eslint-disable-next-line no-await-in-loop
        const rowId = await recordChunkRow(
          req.parentEventId ?? null,
          req.parentDedupKey ?? null,
          traceId,
          i,
          total,
          bucket.length,
          r.jobId,
        );
        records.push({
          chunkIndex: i,
          chunkTotal: total,
          recipientCount: bucket.length,
          jobId: r.jobId,
          chunkRowId: rowId,
        });
      }

      log('info', 'fanout_chunker_emitted', {
        trace_id: traceId,
        chunk_total: total,
        jobs_enqueued: jobsEnqueued,
        duplicates_skipped: duplicatesSkipped,
        failures,
        recipient_count: recipients.length,
      });

      return {
        ok: failures === 0,
        traceId,
        chunkTotal: total,
        jobsEnqueued,
        duplicatesSkipped,
        failures,
        chunks: records,
        reason: failures > 0 ? 'partial_chunk_enqueue_failure' : undefined,
      };
    },
  };
}
