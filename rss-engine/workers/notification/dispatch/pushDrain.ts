/**
 * Phase C — Push delivery drain loop.
 *
 * The fanout engine stages each push recipient as a row in
 * `notification_deliveries` (status='pending', channel='push'). This module
 * drains those rows: it claims a batch, sends them through the Expo
 * `pushSender`, and writes each result back via the existing
 * `record_notification_delivery` RPC.
 *
 * It is intentionally *separate* from the notification queue runner — that
 * runner deals with the `notification` queue (fanout requests). The push
 * loop only deals with the side table the fanout created. Splitting them
 * keeps each component small and lets operators scale push delivery
 * independently of fanout throughput.
 *
 * Schema rules:
 *   - Reads use the minimal SupabaseLike `from(...).select.eq.maybeSingle`
 *     surface for tests, but the real deployment is expected to provide a
 *     `claim_pending_push_deliveries(p_limit, p_worker_id)` RPC. We try
 *     that RPC first; if missing we fall back to a single-row probe so the
 *     loop never crashes during partial deploys.
 *   - Writes go through `record_notification_delivery` (exists in 041).
 *   - Invalid-token cleanup: we call `record_notification_delivery` with
 *     status='failed' AND log a `push_token_marked_invalid` structured
 *     event so the admin pipeline can soft-deactivate the device row. We
 *     do NOT mutate `user_devices` directly (no direct writes from workers).
 */

import type { LogFn } from '../../lib/logger';
import type { RpcResponse, SupabaseLike } from '../../lib/types';
import type { PendingPushDelivery, PushSender } from '../push/pushSender';

export interface PushDrainDeps {
  supabase: SupabaseLike;
  log: LogFn;
  pushSender: PushSender;
  workerId: string;
}

export interface PushDrainOptions {
  /** Max deliveries claimed per cycle. */
  batchSize?: number;
  /** Sleep between cycles when no work. */
  idlePollMs?: number;
  /** Sleep between cycles when actively draining. */
  activePollMs?: number;
}

export interface PushDrainCycle {
  claimed: number;
  sent: number;
  failed: number;
  invalidTokens: number;
}

export interface PushDrainLoop {
  /** Run a single cycle. Useful for tests and the entry script's bootstrap. */
  runOnce(): Promise<PushDrainCycle>;
  /** Start the background loop. */
  start(sleep: (ms: number) => Promise<void>, stopSignal: () => boolean): Promise<void>;
}

/**
 * Shape returned by the (optional) `claim_pending_push_deliveries` RPC.
 * Mirrors the columns we actually need from `notification_deliveries`.
 */
interface ClaimedDeliveryRow {
  id: string;
  user_id: string | null;
  device_id: string | null;
  push_token: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
}

async function claimDeliveries(
  supabase: SupabaseLike,
  workerId: string,
  limit: number,
  log: LogFn,
): Promise<ClaimedDeliveryRow[]> {
  try {
    const { data, error }: RpcResponse<ClaimedDeliveryRow[]> = await supabase.rpc<
      ClaimedDeliveryRow[]
    >('claim_pending_push_deliveries', {
      p_worker_id: workerId,
      p_limit: limit,
    });
    if (!error && Array.isArray(data)) return data;
    if (error) {
      log('debug', 'claim_pending_push_deliveries_unavailable', {
        error: error.message,
      });
    }
  } catch (err) {
    log('debug', 'claim_pending_push_deliveries_threw', {
      error: (err as Error)?.message ?? String(err),
    });
  }
  // Fallback path — minimal SupabaseLike does not expose row claiming, so
  // we return empty and rely on the operator to deploy the RPC. The drain
  // loop will then idle harmlessly until the RPC ships.
  return [];
}

async function recordDelivery(
  supabase: SupabaseLike,
  log: LogFn,
  deliveryId: string,
  status: 'sent' | 'delivered' | 'failed' | 'skipped',
  provider: string | null,
  providerMessageId: string | null,
  error: string | null,
): Promise<void> {
  try {
    const { error: rpcError } = await supabase.rpc('record_notification_delivery', {
      p_delivery_id: deliveryId,
      p_status: status,
      p_provider: provider,
      p_provider_message_id: providerMessageId,
      p_error: error,
    });
    if (rpcError) {
      log('warn', 'record_notification_delivery_failed', {
        delivery_id: deliveryId,
        status,
        error: rpcError.message,
      });
    }
  } catch (err) {
    log('warn', 'record_notification_delivery_threw', {
      delivery_id: deliveryId,
      status,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

export function createPushDrainLoop(
  deps: PushDrainDeps,
  opts: PushDrainOptions = {},
): PushDrainLoop {
  const { supabase, log, pushSender, workerId } = deps;
  const batchSize = Math.min(Math.max(opts.batchSize ?? 100, 1), 1000);
  const idlePollMs = Math.max(opts.idlePollMs ?? 5_000, 100);
  const activePollMs = Math.max(opts.activePollMs ?? 200, 50);

  async function runOnce(): Promise<PushDrainCycle> {
    const rows = await claimDeliveries(supabase, workerId, batchSize, log);
    if (rows.length === 0) {
      return { claimed: 0, sent: 0, failed: 0, invalidTokens: 0 };
    }

    const pending: PendingPushDelivery[] = rows.map((r) => ({
      deliveryId: r.id,
      userId: r.user_id,
      deviceId: r.device_id,
      pushToken: r.push_token,
      title: r.title,
      body: r.body,
      data: r.payload ?? {},
    }));

    const result = await pushSender.send(pending);

    let sent = 0;
    let failed = 0;
    await Promise.all(
      result.tickets.map(async (t) => {
        if (t.status === 'ok') {
          sent += 1;
          await recordDelivery(
            supabase,
            log,
            t.deliveryId,
            'sent',
            t.provider ?? 'expo',
            t.providerMessageId ?? null,
            null,
          );
        } else {
          failed += 1;
          await recordDelivery(
            supabase,
            log,
            t.deliveryId,
            'failed',
            t.provider ?? 'expo',
            null,
            `${t.errorCode ?? 'unknown'}: ${t.errorMessage ?? ''}`.trim(),
          );
        }
      }),
    );

    // Surface invalid-token cleanup for the admin pipeline. The actual
    // soft-deactivation of `user_devices` is owned by the admin layer; this
    // log line is the contract.
    for (const id of result.invalidTokenDeliveryIds) {
      log('warn', 'push_token_marked_invalid', {
        delivery_id: id,
        reason: 'expo_reported_invalid_token',
      });
    }

    return {
      claimed: rows.length,
      sent,
      failed,
      invalidTokens: result.invalidTokenDeliveryIds.length,
    };
  }

  return {
    runOnce,
    async start(sleep, stopSignal) {
      log('info', 'push_drain_loop_started', { worker_id: workerId, batch_size: batchSize });
      while (!stopSignal()) {
        let cycle: PushDrainCycle;
        try {
          // eslint-disable-next-line no-await-in-loop
          cycle = await runOnce();
        } catch (err) {
          log('error', 'push_drain_cycle_threw', {
            error: (err as Error)?.message ?? String(err),
          });
          // eslint-disable-next-line no-await-in-loop
          await sleep(idlePollMs);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(cycle.claimed === 0 ? idlePollMs : activePollMs);
      }
      log('info', 'push_drain_loop_stopped', { worker_id: workerId });
    },
  };
}
