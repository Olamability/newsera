/**
 * Phase E — Canary deployment controller.
 *
 * Wraps the existing `feature_flags` table so the operator can roll a flag
 * through a fixed staircase of exposure tiers and have the controller
 * roll it back automatically if observability metrics degrade.
 *
 * Stages (locked by spec):
 *
 *   internal → 1%
 *   beta     → 5%
 *   limited  → 25%
 *   broad    → 50%
 *   global   → 100%
 *
 * Promotion is *manual* (the operator calls `advance()`); rollback is
 * *automatic* if the health probe returns `degraded`. Both code paths go
 * through the same `set_feature_flag_rollout` RPC the dashboard already
 * uses; this file does NOT bypass the flag service.
 *
 * Health probes are pluggable: the caller injects a `HealthProbe` that
 * returns a `HealthSnapshot` (status + reason). The controller compares the
 * snapshot to thresholds and decides:
 *
 *   - `healthy`  → no action
 *   - `watching` → log a warning, but stay at current stage
 *   - `degraded` → rollback one stage (or to `internal` if `panicRollback`
 *                  is true)
 *
 * HARD RULES:
 *   - NO bypassing feature_flags. All promotion goes through the RPC.
 *   - NO disabling feature flags entirely — the rollback drops the
 *     exposure to the previous tier, never to 0%, unless the caller
 *     explicitly passes `panicRollback: true`.
 *   - Idempotent: re-running `advance()` at the same stage is a no-op.
 */

import type { LogFn } from '../lib/logger';
import type { SupabaseLike } from '../lib/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RolloutStage = 'internal' | 'beta' | 'limited' | 'broad' | 'global';

export const STAGE_ORDER: ReadonlyArray<RolloutStage> = [
  'internal',
  'beta',
  'limited',
  'broad',
  'global',
];

export const STAGE_EXPOSURE: Record<RolloutStage, number> = {
  internal: 1,
  beta: 5,
  limited: 25,
  broad: 50,
  global: 100,
};

export type HealthStatus = 'healthy' | 'watching' | 'degraded';

export interface HealthSnapshot {
  status: HealthStatus;
  reason?: string;
  /** Optional metrics included in structured logs. */
  metrics?: Record<string, number>;
}

export type HealthProbe = (flag: string, stage: RolloutStage) => Promise<HealthSnapshot> | HealthSnapshot;

export interface CanaryControllerOptions {
  /** Number of consecutive degraded probes before a rollback fires. Default 2. */
  degradedConsecutiveTrigger?: number;
  /** When true, a degrade rolls all the way back to `internal`. */
  panicRollback?: boolean;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

export interface AdvanceResult {
  flag: string;
  previousStage: RolloutStage;
  newStage: RolloutStage;
  exposurePct: number;
  changed: boolean;
}

export interface RollbackResult {
  flag: string;
  previousStage: RolloutStage;
  newStage: RolloutStage;
  exposurePct: number;
  reason: string;
}

export interface ProbeResult {
  flag: string;
  stage: RolloutStage;
  status: HealthStatus;
  rolledBack: boolean;
  result?: RollbackResult;
}

export interface CanaryController {
  /** Register a flag and probe so the controller can supervise it. */
  register(flag: string, initialStage: RolloutStage, probe: HealthProbe): Promise<void>;
  /** Move the flag to the next stage. */
  advance(flag: string): Promise<AdvanceResult>;
  /** Force a rollback (operator-triggered). */
  rollback(flag: string, reason: string, opts?: { panic?: boolean }): Promise<RollbackResult>;
  /** Run the health probe once and act on it. */
  probe(flag: string): Promise<ProbeResult>;
  /** Snapshot all registered flags (for dashboards). */
  snapshot(): Array<{ flag: string; stage: RolloutStage; exposurePct: number; consecutiveDegraded: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface FlagState {
  flag: string;
  stage: RolloutStage;
  probe: HealthProbe;
  consecutiveDegraded: number;
  lastStageChangeAt: number;
}

const DEFAULTS: Required<Pick<CanaryControllerOptions, 'degradedConsecutiveTrigger' | 'panicRollback'>> & {
  now: () => number;
} = {
  degradedConsecutiveTrigger: 2,
  panicRollback: false,
  now: () => Date.now(),
};

export function nextStage(stage: RolloutStage): RolloutStage {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx === STAGE_ORDER.length - 1) return stage;
  return STAGE_ORDER[idx + 1];
}

export function previousStage(stage: RolloutStage): RolloutStage {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx <= 0) return STAGE_ORDER[0];
  return STAGE_ORDER[idx - 1];
}

export function createCanaryController(
  supabase: SupabaseLike,
  log: LogFn,
  opts: CanaryControllerOptions = {},
): CanaryController {
  const cfg = { ...DEFAULTS, ...opts };
  const flags = new Map<string, FlagState>();

  async function applyStage(flag: string, stage: RolloutStage, reason: string): Promise<void> {
    const exposure = STAGE_EXPOSURE[stage];
    try {
      const { error } = await supabase.rpc('set_feature_flag_rollout', {
        p_flag_key: flag,
        p_rollout_pct: exposure,
        p_reason: reason,
      });
      if (error) {
        log('error', 'canary_flag_apply_failed', {
          flag,
          stage,
          exposure_pct: exposure,
          error: error.message,
        });
        throw new Error(`canary: failed to set flag ${flag}: ${error.message}`);
      }
    } catch (err) {
      log('error', 'canary_flag_apply_threw', {
        flag,
        stage,
        exposure_pct: exposure,
        error: (err as Error)?.message ?? String(err),
      });
      throw err;
    }
  }

  async function register(flag: string, initialStage: RolloutStage, probe: HealthProbe): Promise<void> {
    flags.set(flag, {
      flag,
      stage: initialStage,
      probe,
      consecutiveDegraded: 0,
      lastStageChangeAt: cfg.now(),
    });
    log('info', 'canary_registered', {
      flag,
      stage: initialStage,
      exposure_pct: STAGE_EXPOSURE[initialStage],
    });
    await applyStage(flag, initialStage, 'canary_register');
  }

  async function advance(flag: string): Promise<AdvanceResult> {
    const state = flags.get(flag);
    if (!state) throw new Error(`canary: unknown flag '${flag}'`);
    const previousStageValue = state.stage;
    const next = nextStage(state.stage);
    if (next === state.stage) {
      return {
        flag,
        previousStage: previousStageValue,
        newStage: next,
        exposurePct: STAGE_EXPOSURE[next],
        changed: false,
      };
    }
    await applyStage(flag, next, 'canary_advance');
    state.stage = next;
    state.consecutiveDegraded = 0;
    state.lastStageChangeAt = cfg.now();
    log('info', 'canary_advanced', {
      flag,
      from_stage: previousStageValue,
      to_stage: next,
      exposure_pct: STAGE_EXPOSURE[next],
    });
    return {
      flag,
      previousStage: previousStageValue,
      newStage: next,
      exposurePct: STAGE_EXPOSURE[next],
      changed: true,
    };
  }

  async function rollback(flag: string, reason: string, opts: { panic?: boolean } = {}): Promise<RollbackResult> {
    const state = flags.get(flag);
    if (!state) throw new Error(`canary: unknown flag '${flag}'`);
    const panic = opts.panic ?? cfg.panicRollback;
    const target: RolloutStage = panic ? 'internal' : previousStage(state.stage);
    const previousStageValue = state.stage;
    await applyStage(flag, target, `canary_rollback:${reason}`);
    state.stage = target;
    state.consecutiveDegraded = 0;
    state.lastStageChangeAt = cfg.now();
    log('warn', 'canary_rolled_back', {
      flag,
      from_stage: previousStageValue,
      to_stage: target,
      exposure_pct: STAGE_EXPOSURE[target],
      reason,
      panic,
    });
    return {
      flag,
      previousStage: previousStageValue,
      newStage: target,
      exposurePct: STAGE_EXPOSURE[target],
      reason,
    };
  }

  async function probe(flag: string): Promise<ProbeResult> {
    const state = flags.get(flag);
    if (!state) throw new Error(`canary: unknown flag '${flag}'`);
    let snap: HealthSnapshot;
    try {
      snap = await Promise.resolve(state.probe(flag, state.stage));
    } catch (err) {
      log('warn', 'canary_probe_threw', {
        flag,
        stage: state.stage,
        error: (err as Error)?.message ?? String(err),
      });
      // Probe failure is treated as `watching` rather than `degraded` so an
      // observability outage doesn't roll back a healthy rollout.
      snap = { status: 'watching', reason: 'probe_error' };
    }
    if (snap.status === 'healthy') {
      state.consecutiveDegraded = 0;
    } else if (snap.status === 'watching') {
      // Don't reset; don't increment. Hold position.
      log('warn', 'canary_probe_watching', {
        flag,
        stage: state.stage,
        reason: snap.reason,
        metrics: snap.metrics ?? {},
      });
    } else {
      state.consecutiveDegraded += 1;
      log('warn', 'canary_probe_degraded', {
        flag,
        stage: state.stage,
        consecutive_degraded: state.consecutiveDegraded,
        reason: snap.reason,
        metrics: snap.metrics ?? {},
      });
      if (state.consecutiveDegraded >= cfg.degradedConsecutiveTrigger) {
        const r = await rollback(flag, snap.reason ?? 'health_degraded');
        return { flag, stage: r.newStage, status: snap.status, rolledBack: true, result: r };
      }
    }
    return { flag, stage: state.stage, status: snap.status, rolledBack: false };
  }

  function snapshot() {
    return [...flags.values()].map((s) => ({
      flag: s.flag,
      stage: s.stage,
      exposurePct: STAGE_EXPOSURE[s.stage],
      consecutiveDegraded: s.consecutiveDegraded,
    }));
  }

  return { register, advance, rollback, probe, snapshot };
}
