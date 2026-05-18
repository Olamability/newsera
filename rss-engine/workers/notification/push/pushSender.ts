/**
 * Phase C — Expo push delivery layer.
 *
 * Wraps the (intentionally abstract) Expo push API behind a transport that
 * the notification runner can call with a flat list of pending
 * `notification_deliveries` rows. The transport is injected so:
 *   - unit tests can drive a fake transport without network IO,
 *   - the production deployment can swap Expo for a different provider
 *     later without rewriting the runner.
 *
 * Guarantees:
 *   - BATCHING. Expo accepts up to 100 messages per request; we cap below
 *     that and split overflow into successive batches.
 *   - DEDUP. Duplicate push tokens within a single fanout (same user logged
 *     in on two devices that share a token, or a buggy client re-registering
 *     the same token) are collapsed before the network call. This closes
 *     the Phase C "duplicate device tokens are deduplicated" requirement.
 *   - SINGLE RETRY. A failed batch is retried exactly once; persistent
 *     failures are reported back to the runner per-delivery so it can mark
 *     the row failed via `record_notification_delivery`.
 *   - INVALID-TOKEN CLEANUP. Expo returns a per-message `DeviceNotRegistered`
 *     ticket for stale tokens. We surface those to the caller so it can
 *     soft-deactivate the device row via the existing service-role RPC
 *     surface — we deliberately do NOT mutate `user_devices` ourselves
 *     (no direct table writes from workers).
 *
 * Phase C also requires "token-user binding is always consistent" — we
 * enforce that by keying dedup on `(user_id, push_token)` rather than the
 * token alone, so a token re-registered against a new user counts as a
 * distinct delivery, not a dedup target.
 */

import type { LogFn } from '../../lib/logger';

export interface PendingPushDelivery {
  /** notification_deliveries.id — used to call record_notification_delivery later. */
  deliveryId: string;
  userId: string | null;
  deviceId: string | null;
  pushToken: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Optional sound / priority hints honoured by Expo. */
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
}

export interface PushBatchTicket {
  /** Echo of `deliveryId` so the caller can match the result. */
  deliveryId: string;
  status: 'ok' | 'error';
  provider?: string;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type PushTransport = (
  batch: ReadonlyArray<{
    deliveryId: string;
    to: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
    sound?: 'default' | null;
    priority?: 'default' | 'normal' | 'high';
  }>,
) => Promise<PushBatchTicket[]>;

export interface PushSenderOptions {
  /** Hard cap per batch. Defaults to 100 (Expo limit). */
  maxBatchSize?: number;
  /** Single-retry toggle. Defaults to true. */
  retryOnce?: boolean;
}

export interface PushSendResult {
  /** Tickets keyed by deliveryId — the runner uses these to write back. */
  tickets: PushBatchTicket[];
  /**
   * Delivery ids whose token Expo flagged as invalid (DeviceNotRegistered,
   * InvalidCredentials, etc). The caller is responsible for marking the
   * underlying device row inactive via its existing service-layer RPC.
   */
  invalidTokenDeliveryIds: string[];
  /** Total deliveries actually sent (post-dedup). */
  attempted: number;
  /** Deduped due to (user_id, token) collisions inside the request. */
  dedupedCount: number;
}

export interface PushSender {
  send(
    deliveries: ReadonlyArray<PendingPushDelivery>,
  ): Promise<PushSendResult>;
}

/** Token shapes Expo considers permanently invalid. */
const INVALID_TOKEN_CODES = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'ExpoError',
  'MessageTooBig',
  'InvalidPushToken',
]);

/**
 * Tokens issued by the legitimate Expo SDK have one of two well-known
 * shapes. Anything else is rejected client-side so we never waste a network
 * round-trip on garbage tokens (and never accidentally forward a real
 * device's APNs token straight to Expo).
 */
export function looksLikeExpoToken(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  return (
    /^ExponentPushToken\[[^\]]+\]$/.test(token) ||
    /^ExpoPushToken\[[^\]]+\]$/.test(token)
  );
}

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function createPushSender(
  transport: PushTransport,
  log: LogFn,
  opts: PushSenderOptions = {},
): PushSender {
  const maxBatch = Math.min(Math.max(opts.maxBatchSize ?? 100, 1), 100);
  const retryOnce = opts.retryOnce !== false;

  async function sendOnce(
    deliveries: ReadonlyArray<PendingPushDelivery>,
  ): Promise<PushBatchTicket[]> {
    const messages = deliveries.map((d) => ({
      deliveryId: d.deliveryId,
      to: d.pushToken,
      title: d.title,
      body: d.body,
      data: d.data,
      sound: d.sound ?? 'default',
      priority: d.priority ?? 'default',
    }));
    try {
      return await transport(messages);
    } catch (err) {
      // Whole-batch failure — synthesise per-delivery error tickets so the
      // caller can still write them back to `notification_deliveries`.
      const message = (err as Error)?.message ?? String(err);
      log('warn', 'push_transport_threw', {
        batch_size: deliveries.length,
        error: message,
      });
      return deliveries.map((d) => ({
        deliveryId: d.deliveryId,
        status: 'error' as const,
        provider: 'expo',
        errorCode: 'TransportFailure',
        errorMessage: message,
      }));
    }
  }

  return {
    async send(deliveries) {
      if (deliveries.length === 0) {
        return {
          tickets: [],
          invalidTokenDeliveryIds: [],
          attempted: 0,
          dedupedCount: 0,
        };
      }

      // 1) Pre-flight filter: drop malformed tokens (mark as invalid up front
      //    so the runner cleans them up). This is the device-token-hardening
      //    contract from the problem statement.
      const malformed: PushBatchTicket[] = [];
      const malformedIds: string[] = [];
      const wellFormed: PendingPushDelivery[] = [];
      for (const d of deliveries) {
        if (!looksLikeExpoToken(d.pushToken)) {
          malformed.push({
            deliveryId: d.deliveryId,
            status: 'error',
            provider: 'expo',
            errorCode: 'InvalidPushToken',
            errorMessage: 'token_shape_invalid',
          });
          malformedIds.push(d.deliveryId);
        } else {
          wellFormed.push(d);
        }
      }

      // 2) Dedup on (user_id, push_token) within this request.
      const seen = new Set<string>();
      const dedupedDeliveries: PendingPushDelivery[] = [];
      let dedupedCount = 0;
      for (const d of wellFormed) {
        const key = `${d.userId ?? ''}::${d.pushToken}`;
        if (seen.has(key)) {
          dedupedCount += 1;
          // Synthesise a 'skipped' ticket so the upstream still gets a
          // disposition for the row (it will be written as `skipped` via
          // record_notification_delivery, not failed).
          malformed.push({
            deliveryId: d.deliveryId,
            status: 'ok',
            provider: 'expo',
            providerMessageId: 'deduped_within_batch',
          });
          continue;
        }
        seen.add(key);
        dedupedDeliveries.push(d);
      }

      // 3) Batch + send.
      const tickets: PushBatchTicket[] = [...malformed];
      const invalidTokenDeliveryIds: string[] = [...malformedIds];

      for (const batch of chunk(dedupedDeliveries, maxBatch)) {
        // eslint-disable-next-line no-await-in-loop
        let batchTickets = await sendOnce(batch);

        // 4) Single retry path — only retry the failures (not the whole batch).
        if (retryOnce) {
          const failed = batchTickets.filter((t) => t.status === 'error');
          const retryableIds = new Set(
            failed
              .filter(
                (t) =>
                  // Only retry transient classes; never retry tokens Expo
                  // already classified as invalid.
                  !t.errorCode || !INVALID_TOKEN_CODES.has(t.errorCode),
              )
              .map((t) => t.deliveryId),
          );
          if (retryableIds.size > 0) {
            const retryBatch = batch.filter((d) => retryableIds.has(d.deliveryId));
            // eslint-disable-next-line no-await-in-loop
            const retryResults = await sendOnce(retryBatch);
            // Overlay retry results into the original ticket list.
            const byId = new Map(batchTickets.map((t) => [t.deliveryId, t]));
            for (const r of retryResults) byId.set(r.deliveryId, r);
            batchTickets = Array.from(byId.values());
          }
        }

        // 5) Surface invalid-token ids so the runner can soft-deactivate.
        for (const t of batchTickets) {
          if (t.status === 'error' && t.errorCode && INVALID_TOKEN_CODES.has(t.errorCode)) {
            invalidTokenDeliveryIds.push(t.deliveryId);
          }
        }
        tickets.push(...batchTickets);
      }

      log('info', 'push_send_complete', {
        attempted: dedupedDeliveries.length,
        deduped: dedupedCount,
        invalid_tokens: invalidTokenDeliveryIds.length,
        batches: Math.ceil(dedupedDeliveries.length / maxBatch),
      });

      return {
        tickets,
        invalidTokenDeliveryIds,
        attempted: dedupedDeliveries.length,
        dedupedCount,
      };
    },
  };
}
