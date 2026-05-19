/**
 * Phase E — Traffic guard.
 *
 * Operator-triggerable safety controls for live traffic. Each control is a
 * boolean (or numeric throttle) the rest of the worker code reads via
 * `isAllowed()` / `getThrottleFactor()` before doing potentially risky work.
 * The guard NEVER mutates business state — it only blocks/slows callers.
 *
 * Controls (mapped 1:1 to the problem statement):
 *
 *   - emergency_throttle           — slows ingestion + ranking + notification
 *                                    by `throttleFactor` (a multiplier in
 *                                    [0..1] applied to outbound concurrency).
 *   - queue_freeze                 — pauses leasing of new jobs across all
 *                                    queues. In-flight jobs keep running.
 *   - notification_kill_switch     — `isAllowed('notification')` returns
 *                                    false; the dispatch pipeline drops the
 *                                    job as `skipped` rather than failing.
 *   - ranking_degradation_mode     — falls back to the global ranker; the
 *                                    personalized ranker is bypassed.
 *   - ingestion_slowdown_mode      — caps ingestion concurrency to 1 and
 *                                    doubles the idle poll interval.
 *
 * Activation:
 *   - The operator sets a control via `set('queue_freeze', true)`.
 *   - The guard mirrors its state to the `traffic_guard_state` table via
 *     the existing `set_traffic_guard_state` RPC (idempotent upsert) so all
 *     workers converge within one heartbeat. RPC absence is non-fatal: a
 *     guard that fails to persist still works in-process.
 *   - Workers call `refresh()` periodically (typically once per cycle) to
 *     pull authoritative state from `get_traffic_guard_state`.
 *
 * HARD RULES:
 *   - The guard never bypasses feature flags. Controls are independent —
 *     a flag can be ON while a guard control is ALSO ON; the guard wins.
 *   - All transitions emit a structured `traffic_guard_*` log line so the
 *     incident timeline is self-documenting.
 *   - Idempotent: setting a control to its current value is a no-op.
 */

import type { LogFn } from '../lib/logger';
import type { QueueName, SupabaseLike } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GuardControl =
  | 'emergency_throttle'
  | 'queue_freeze'
  | 'notification_kill_switch'
  | 'ranking_degradation_mode'
  | 'ingestion_slowdown_mode';

export interface GuardState {
  emergencyThrottle: boolean;
  /** Multiplier in [0..1] applied when emergencyThrottle is on. Default 0.25. */
  throttleFactor: number;
  queueFreeze: boolean;
  notificationKillSwitch: boolean;
  rankingDegradationMode: boolean;
  ingestionSlowdownMode: boolean;
  /** Audit string, last operator. */
  lastUpdatedBy: string | null;
  lastUpdatedAt: Date;
}

export interface GuardAllowance {
  allowed: boolean;
  reason?: string;
  /** Concurrency multiplier (1.0 = no impact, 0.25 = throttle). */
  concurrencyFactor: number;
}

export interface TrafficGuard {
  /** Current in-memory state. */
  state(): GuardState;
  /** Set a control, optionally with a `throttleFactor`. */
  set(control: GuardControl, value: boolean, opts?: { initiator?: string; reason?: string; throttleFactor?: number }): Promise<GuardState>;
  /** Reload state from the database. Safe to call every cycle. */
  refresh(): Promise<GuardState>;
  /** Should a queue be allowed to lease new jobs right now? */
  canLease(queue: QueueName): GuardAllowance;
  /** Should a notification dispatch fire right now? */
  canDispatchNotification(): GuardAllowance;
  /** Should the personalized ranker run, or should we degrade to global? */
  shouldUsePersonalizedRanker(): boolean;
  /** Recommended concurrency multiplier for ingestion paths. */
  ingestionConcurrencyFactor(): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_STATE: GuardState = {
  emergencyThrottle: false,
  throttleFactor: 0.25,
  queueFreeze: false,
  notificationKillSwitch: false,
  rankingDegradationMode: false,
  ingestionSlowdownMode: false,
  lastUpdatedBy: null,
  lastUpdatedAt: new Date(0),
};

export interface TrafficGuardOptions {
  /** Initial state — useful for tests. */
  initial?: Partial<GuardState>;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

export function createTrafficGuard(
  supabase: SupabaseLike,
  log: LogFn,
  opts: TrafficGuardOptions = {},
): TrafficGuard {
  const now = opts.now ?? (() => Date.now());
  let state: GuardState = {
    ...DEFAULT_STATE,
    ...opts.initial,
    lastUpdatedAt: new Date(now()),
  };

  function logTransition(prev: GuardState, next: GuardState, initiator: string | null, reason: string | null): void {
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(next) as Array<keyof GuardState>) {
      if (k === 'lastUpdatedAt' || k === 'lastUpdatedBy') continue;
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
        changed[k] = { from: prev[k], to: next[k] };
      }
    }
    if (Object.keys(changed).length === 0) return;
    log('warn', 'traffic_guard_state_changed', {
      changed,
      initiator,
      reason,
    });
  }

  async function persist(): Promise<void> {
    try {
      const { error } = await supabase.rpc('set_traffic_guard_state', {
        p_state: {
          emergency_throttle: state.emergencyThrottle,
          throttle_factor: state.throttleFactor,
          queue_freeze: state.queueFreeze,
          notification_kill_switch: state.notificationKillSwitch,
          ranking_degradation_mode: state.rankingDegradationMode,
          ingestion_slowdown_mode: state.ingestionSlowdownMode,
        },
        p_initiator: state.lastUpdatedBy,
      });
      if (error) {
        log('warn', 'traffic_guard_persist_failed', { error: error.message });
      }
    } catch (err) {
      log('warn', 'traffic_guard_persist_threw', {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  async function refresh(): Promise<GuardState> {
    try {
      const { data, error } = await supabase.rpc<{
        emergency_throttle: boolean;
        throttle_factor: number;
        queue_freeze: boolean;
        notification_kill_switch: boolean;
        ranking_degradation_mode: boolean;
        ingestion_slowdown_mode: boolean;
        last_updated_by: string | null;
        last_updated_at: string;
      }>('get_traffic_guard_state');
      if (error || !data) {
        // No state in the database yet (fresh deploy) — keep in-memory state.
        if (error) {
          log('debug', 'traffic_guard_refresh_unavailable', { error: error.message });
        }
        return state;
      }
      const prev = state;
      state = {
        emergencyThrottle: !!data.emergency_throttle,
        throttleFactor: Number(data.throttle_factor ?? DEFAULT_STATE.throttleFactor),
        queueFreeze: !!data.queue_freeze,
        notificationKillSwitch: !!data.notification_kill_switch,
        rankingDegradationMode: !!data.ranking_degradation_mode,
        ingestionSlowdownMode: !!data.ingestion_slowdown_mode,
        lastUpdatedBy: data.last_updated_by ?? null,
        lastUpdatedAt: data.last_updated_at ? new Date(data.last_updated_at) : new Date(now()),
      };
      logTransition(prev, state, state.lastUpdatedBy, 'refresh');
      return state;
    } catch (err) {
      log('debug', 'traffic_guard_refresh_threw', {
        error: (err as Error)?.message ?? String(err),
      });
      return state;
    }
  }

  function applyControl(control: GuardControl, value: boolean, throttleFactor?: number): GuardState {
    const next: GuardState = { ...state, lastUpdatedAt: new Date(now()) };
    switch (control) {
      case 'emergency_throttle':
        next.emergencyThrottle = value;
        if (typeof throttleFactor === 'number' && Number.isFinite(throttleFactor)) {
          next.throttleFactor = Math.min(1, Math.max(0.05, throttleFactor));
        }
        break;
      case 'queue_freeze':
        next.queueFreeze = value;
        break;
      case 'notification_kill_switch':
        next.notificationKillSwitch = value;
        break;
      case 'ranking_degradation_mode':
        next.rankingDegradationMode = value;
        break;
      case 'ingestion_slowdown_mode':
        next.ingestionSlowdownMode = value;
        break;
    }
    return next;
  }

  async function set(
    control: GuardControl,
    value: boolean,
    setOpts: { initiator?: string; reason?: string; throttleFactor?: number } = {},
  ): Promise<GuardState> {
    const prev = state;
    const next = applyControl(control, value, setOpts.throttleFactor);
    next.lastUpdatedBy = setOpts.initiator ?? prev.lastUpdatedBy;
    state = next;
    logTransition(prev, next, setOpts.initiator ?? null, setOpts.reason ?? null);
    await persist();
    return state;
  }

  function canLease(queue: QueueName): GuardAllowance {
    if (state.queueFreeze) {
      return { allowed: false, reason: 'queue_freeze', concurrencyFactor: 0 };
    }
    if (state.notificationKillSwitch && queue === 'notification') {
      return { allowed: false, reason: 'notification_kill_switch', concurrencyFactor: 0 };
    }
    let factor = 1.0;
    if (state.emergencyThrottle) factor = Math.min(factor, state.throttleFactor);
    if (state.ingestionSlowdownMode && queue === 'ingestion') factor = Math.min(factor, 0.25);
    return { allowed: true, concurrencyFactor: factor };
  }

  function canDispatchNotification(): GuardAllowance {
    if (state.notificationKillSwitch) {
      return { allowed: false, reason: 'notification_kill_switch', concurrencyFactor: 0 };
    }
    if (state.queueFreeze) {
      return { allowed: false, reason: 'queue_freeze', concurrencyFactor: 0 };
    }
    let factor = 1.0;
    if (state.emergencyThrottle) factor = Math.min(factor, state.throttleFactor);
    return { allowed: true, concurrencyFactor: factor };
  }

  function shouldUsePersonalizedRanker(): boolean {
    return !state.rankingDegradationMode;
  }

  function ingestionConcurrencyFactor(): number {
    let factor = 1.0;
    if (state.emergencyThrottle) factor = Math.min(factor, state.throttleFactor);
    if (state.ingestionSlowdownMode) factor = Math.min(factor, 0.25);
    return factor;
  }

  return {
    state: () => state,
    set,
    refresh,
    canLease,
    canDispatchNotification,
    shouldUsePersonalizedRanker,
    ingestionConcurrencyFactor,
  };
}
