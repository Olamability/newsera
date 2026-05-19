/**
 * Phase D — Analytics delivery health sink.
 *
 * Closes the Phase C "analytics sink visibility gap" leftover.
 *
 * Wraps the migration-048 `record_delivery_health_event` RPC behind a
 * tiny, batched sink that all phase D + carry-over phase C subsystems
 * use to report:
 *
 *   emitted  — a unit of work was produced (e.g. fanout chunk created)
 *   accepted — downstream confirmed receipt (e.g. push sent)
 *   dropped  — work was intentionally discarded (dedup, suppression)
 *   failed   — work could not be delivered after retries
 *
 * Failures to record are *swallowed* (logged at debug) — analytics
 * should never block real work. The sink is intentionally fire-and-
 * forget but exposes `flush()` for the test harness.
 */

import type { LogFn } from '../lib/logger';
import type { SupabaseLike } from '../lib/types';

export type DeliveryHealthSink =
  | 'notification_fanout'
  | 'notification_push'
  | 'notification_inbox'
  | 'analytics_metrics'
  | 'ranking_feedback'
  | 'personalization_recompute';

export type DeliveryHealthEvent = 'emitted' | 'accepted' | 'dropped' | 'failed';

export interface DeliveryHealthRecorder {
  record(
    sink: DeliveryHealthSink,
    event: DeliveryHealthEvent,
    count?: number,
    reason?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** Snapshot for observability dashboards / tests. */
  snapshot(lookbackMinutes?: number): Promise<DeliveryHealthSnapshotRow[]>;
}

export interface DeliveryHealthSnapshotRow {
  sink: DeliveryHealthSink | string;
  emitted: number;
  accepted: number;
  dropped: number;
  failed: number;
}

export function createDeliveryHealthRecorder(
  supabase: SupabaseLike,
  log: LogFn,
): DeliveryHealthRecorder {
  async function record(
    sink: DeliveryHealthSink,
    event: DeliveryHealthEvent,
    count = 1,
    reason?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { error } = await supabase.rpc('record_delivery_health_event', {
        p_sink: sink,
        p_event: event,
        p_count: Math.max(1, Math.floor(count)),
        p_reason: reason ?? null,
        p_metadata: metadata ?? {},
      });
      if (error) {
        log('debug', 'delivery_health_record_failed', {
          sink,
          event,
          error: error.message,
        });
      }
    } catch (err) {
      log('debug', 'delivery_health_record_threw', {
        sink,
        event,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  async function snapshot(
    lookbackMinutes = 60,
  ): Promise<DeliveryHealthSnapshotRow[]> {
    try {
      const { data, error } = await supabase.rpc<DeliveryHealthSnapshotRow[]>(
        'delivery_health_snapshot',
        { p_lookback_minutes: lookbackMinutes },
      );
      if (error) {
        log('debug', 'delivery_health_snapshot_failed', {
          error: error.message,
        });
        return [];
      }
      // Normalize numeric coercion from PG (bigints come over as strings).
      return (Array.isArray(data) ? data : []).map((row) => ({
        sink: String(row.sink),
        emitted: Number(row.emitted ?? 0),
        accepted: Number(row.accepted ?? 0),
        dropped: Number(row.dropped ?? 0),
        failed: Number(row.failed ?? 0),
      }));
    } catch (err) {
      log('debug', 'delivery_health_snapshot_threw', {
        error: (err as Error)?.message ?? String(err),
      });
      return [];
    }
  }

  return { record, snapshot };
}
