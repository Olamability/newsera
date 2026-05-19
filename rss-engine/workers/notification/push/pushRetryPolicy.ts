/**
 * Phase D — Push retry orchestration (tiered retry + dead-letter).
 *
 * Closes the Phase C "push retry strategy too shallow" leftover.
 *
 * Replaces the single-shot retry in `pushSender` with a three-tier
 * orchestration:
 *
 *   Attempt 1: immediate
 *   Attempt 2: +30 sec
 *   Attempt 3: +5 min
 *   After 3 failures: dead-letter via `record_notification_delivery`
 *                     with status='failed' AND a structured
 *                     `reason_code` carried in the error column.
 *
 * The orchestrator is delivery-attempt-aware: it consumes the
 * per-delivery `attempts` counter that already lives on
 * `notification_deliveries` (Phase C schema) and computes the *next*
 * available time. The push drain loop calls into the orchestrator
 * BEFORE sending — so deliveries currently inside their backoff window
 * are skipped, not silently re-sent.
 *
 * This module is pure logic + thin DB writes via existing RPCs. No new
 * schema is required: the lineage is the existing `attempts` column.
 */

import type { LogFn } from '../../lib/logger';
import type { SupabaseLike } from '../../lib/types';

/**
 * Tier ladder. Index 0 = first retry delay (after attempt 1 fails).
 * The orchestrator picks `RETRY_DELAYS_SEC[attemptsSoFar - 1]`.
 */
export const RETRY_DELAYS_SEC: ReadonlyArray<number> = [0, 30, 300];

/** Hard ceiling on attempts — matches RETRY_DELAYS_SEC length. */
export const MAX_PUSH_ATTEMPTS = RETRY_DELAYS_SEC.length;

/** Structured reason codes written into the dead-letter row. */
export const PUSH_DEAD_LETTER_REASONS = {
  PROVIDER_ERROR: 'push_provider_persistent_error',
  TRANSPORT_FAILURE: 'push_transport_failure_max_retries',
  INVALID_TOKEN: 'push_invalid_token_unrecoverable',
  EXPIRED: 'push_expired_after_max_retries',
} as const;

export type PushDeadLetterReason =
  (typeof PUSH_DEAD_LETTER_REASONS)[keyof typeof PUSH_DEAD_LETTER_REASONS];

export interface DeliveryAttemptInput {
  deliveryId: string;
  attemptsSoFar: number;
  /** ISO timestamp of last attempt, if any. */
  lastAttemptAt?: Date | string | number | null;
  /** Last-error class, if known (e.g. 'TransportFailure'). */
  lastErrorCode?: string | null;
}

export interface RetryDecision {
  deliveryId: string;
  /** 'send' | 'wait' | 'dead-letter'. */
  action: 'send' | 'wait' | 'dead_letter';
  /** When `action='wait'`, the ISO timestamp the delivery is eligible again. */
  nextEligibleAt?: Date;
  /** Attempt index that *would* be made (1-indexed). */
  nextAttempt?: number;
  /** Dead-letter reason when `action='dead_letter'`. */
  reasonCode?: PushDeadLetterReason;
}

function toDate(v: Date | string | number | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

/**
 * Pure decision function: given an attempt's current state, decide
 * what to do next. Separated from any side effects so it is trivially
 * unit-testable.
 */
export function decideRetry(
  input: DeliveryAttemptInput,
  now: Date = new Date(),
): RetryDecision {
  const attempts = Math.max(0, input.attemptsSoFar | 0);
  if (attempts >= MAX_PUSH_ATTEMPTS) {
    let reason: PushDeadLetterReason = PUSH_DEAD_LETTER_REASONS.PROVIDER_ERROR;
    if (input.lastErrorCode === 'TransportFailure') {
      reason = PUSH_DEAD_LETTER_REASONS.TRANSPORT_FAILURE;
    } else if (
      input.lastErrorCode === 'DeviceNotRegistered' ||
      input.lastErrorCode === 'InvalidPushToken' ||
      input.lastErrorCode === 'InvalidCredentials'
    ) {
      reason = PUSH_DEAD_LETTER_REASONS.INVALID_TOKEN;
    }
    return {
      deliveryId: input.deliveryId,
      action: 'dead_letter',
      reasonCode: reason,
    };
  }

  const delaySec = RETRY_DELAYS_SEC[attempts] ?? 0;
  const last = toDate(input.lastAttemptAt);
  if (delaySec === 0 || !last) {
    return {
      deliveryId: input.deliveryId,
      action: 'send',
      nextAttempt: attempts + 1,
    };
  }
  const eligibleAt = new Date(last.getTime() + delaySec * 1000);
  if (eligibleAt.getTime() <= now.getTime()) {
    return {
      deliveryId: input.deliveryId,
      action: 'send',
      nextAttempt: attempts + 1,
    };
  }
  return {
    deliveryId: input.deliveryId,
    action: 'wait',
    nextEligibleAt: eligibleAt,
    nextAttempt: attempts + 1,
  };
}

export interface DeadLetterDeps {
  supabase: SupabaseLike;
  log: LogFn;
}

/**
 * Side-effecting helper — writes the dead-letter terminal status via
 * the existing `record_notification_delivery` RPC. We DO NOT mutate
 * the row directly (no direct table writes from workers).
 */
export async function deadLetterDelivery(
  deps: DeadLetterDeps,
  deliveryId: string,
  reasonCode: PushDeadLetterReason,
  detail?: string,
): Promise<boolean> {
  try {
    const { error } = await deps.supabase.rpc('record_notification_delivery', {
      p_delivery_id: deliveryId,
      p_status: 'failed',
      p_provider: 'expo',
      p_provider_message_id: null,
      p_error: detail ? `${reasonCode}: ${detail}` : reasonCode,
    });
    if (error) {
      deps.log('warn', 'push_dead_letter_failed', {
        delivery_id: deliveryId,
        reason_code: reasonCode,
        error: error.message,
      });
      return false;
    }
    deps.log('info', 'push_dead_lettered', {
      delivery_id: deliveryId,
      reason_code: reasonCode,
    });
    return true;
  } catch (err) {
    deps.log('warn', 'push_dead_letter_threw', {
      delivery_id: deliveryId,
      reason_code: reasonCode,
      error: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}
