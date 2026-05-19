/**
 * Phase F — Live rollout orchestrator.
 *
 * Coordinates the staged enablement of the four production features that
 * complete the NewsEra launch. The orchestrator is intentionally a thin
 * supervisor on top of the existing `canaryController`: it does NOT
 * bypass feature flags, it does NOT mutate ranking/notification state,
 * and it does NOT introduce new infrastructure. All work goes through
 * the same `set_feature_flag_rollout` RPC the operator dashboard uses.
 *
 * Strict rollout sequence:
 *
 *   stage 1 → queue_based_ingestion
 *   stage 2 → ranking_v1
 *   stage 3 → personalization_v1
 *   stage 4 → backend_notification_dispatch
 *
 * Each stage must be stabilised (per `stabilizationPolicy.ts`) before
 * the next can begin. The orchestrator records an in-memory audit
 * history so the operator dashboard can render a complete rollout
 * timeline.
 *
 * State machine per stage:
 *
 *   PENDING  → ACTIVE  → STABILIZING → STABLE   → (next stage begins)
 *                              ↘ FAILED  → ROLLED_BACK
 *   PAUSED is a side-state reachable from ACTIVE/STABILIZING.
 *
 * HARD RULES:
 *   - No out-of-order activation. `beginNextStage()` fails loudly if the
 *     previous stage is not STABLE.
 *   - Operator can call `pause(stage, reason)` at any time; advancement
 *     resumes only after `resume()`.
 *   - Rollback uses the existing canary controller's `rollback()`; this
 *     module never writes feature-flag rows directly.
 *   - All transitions emit `rollout_*` audit log lines.
 */

import type { LogFn } from '../lib/logger';
import type { CanaryController, RolloutStage as CanaryStage } from '../deployment/canaryController';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RolloutFlag =
  | 'queue_based_ingestion'
  | 'ranking_v1'
  | 'personalization_v1'
  | 'backend_notification_dispatch';

export const ROLLOUT_SEQUENCE: ReadonlyArray<RolloutFlag> = [
  'queue_based_ingestion',
  'ranking_v1',
  'personalization_v1',
  'backend_notification_dispatch',
];

export type RolloutStageStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'STABILIZING'
  | 'STABLE'
  | 'PAUSED'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface RolloutStageState {
  flag: RolloutFlag;
  ordinal: number;
  status: RolloutStageStatus;
  canaryStage: CanaryStage | null;
  startedAt: Date | null;
  enteredStabilizationAt: Date | null;
  stableSinceAt: Date | null;
  pausedAt: Date | null;
  pauseReason: string | null;
  rollbackReason: string | null;
  /** Operator who last touched this stage. */
  lastInitiator: string | null;
}

export interface RolloutAuditEntry {
  at: Date;
  flag: RolloutFlag;
  event: string;
  status: RolloutStageStatus;
  initiator: string | null;
  detail: Record<string, unknown>;
}

export interface RolloutSnapshot {
  generatedAt: Date;
  currentFlag: RolloutFlag | null;
  currentStatus: RolloutStageStatus | null;
  stages: RolloutStageState[];
  blockers: string[];
  history: RolloutAuditEntry[];
}

export interface RolloutManagerOptions {
  /** Initial canary stage to seed every flag at. Defaults to 'internal'. */
  initialCanaryStage?: CanaryStage;
  /** Max audit entries retained. Default 500. */
  historyCapacity?: number;
  /** Provider for `Date.now()`. */
  now?: () => number;
}

export interface BeginStageArgs {
  initiator: string;
  reason: string;
}

export interface MarkStabilizingArgs extends BeginStageArgs {
  flag?: RolloutFlag;
}

export interface PromoteArgs extends BeginStageArgs {
  /** Optional: force a specific flag (defaults to the currently active flag). */
  flag?: RolloutFlag;
}

export interface PauseArgs {
  reason: string;
  initiator: string;
}

export interface RolloutManager {
  /**
   * Register all four flags with the canary controller. Idempotent: a
   * subsequent call only re-registers missing flags.
   */
  bootstrap(): Promise<void>;
  /** Move the next pending stage to ACTIVE (advance its canary stage). */
  beginNextStage(args: BeginStageArgs): Promise<RolloutStageState>;
  /** Operator promotes the active flag one canary stage forward. */
  promote(args: PromoteArgs): Promise<RolloutStageState>;
  /**
   * Mark the active stage as STABILIZING. Typically called once the
   * canary reaches `global` (100%). Stabilization windows are policed
   * by `stabilizationPolicy.ts`; this module merely tracks the timer.
   */
  markStabilizing(args: MarkStabilizingArgs): RolloutStageState;
  /**
   * Mark the active flag STABLE. The next call to `beginNextStage()`
   * is allowed only after this transition.
   */
  markStable(args: BeginStageArgs & { flag?: RolloutFlag }): RolloutStageState;
  /** Pause the active flag — no canary advancement until `resume()`. */
  pause(args: PauseArgs & { flag?: RolloutFlag }): RolloutStageState;
  /** Resume a paused flag. */
  resume(args: BeginStageArgs & { flag?: RolloutFlag }): RolloutStageState;
  /** Hard rollback. Delegates to the canary controller. */
  rollback(args: { flag?: RolloutFlag; reason: string; initiator: string; panic?: boolean }): Promise<RolloutStageState>;
  /** Snapshot for the operator dashboard. */
  snapshot(): RolloutSnapshot;
  /**
   * List blockers (human-readable strings) preventing `beginNextStage()`.
   * Empty array = advancement allowed.
   */
  blockers(): string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULTS = {
  initialCanaryStage: 'internal' as CanaryStage,
  historyCapacity: 500,
  now: () => Date.now(),
};

const ACTIVE_STATUSES: ReadonlySet<RolloutStageStatus> = new Set([
  'ACTIVE',
  'STABILIZING',
  'PAUSED',
]);

export function createRolloutManager(
  canary: CanaryController,
  log: LogFn,
  opts: RolloutManagerOptions = {},
): RolloutManager {
  const cfg = { ...DEFAULTS, ...opts };
  const stages: RolloutStageState[] = ROLLOUT_SEQUENCE.map((flag, i) => ({
    flag,
    ordinal: i + 1,
    status: 'PENDING',
    canaryStage: null,
    startedAt: null,
    enteredStabilizationAt: null,
    stableSinceAt: null,
    pausedAt: null,
    pauseReason: null,
    rollbackReason: null,
    lastInitiator: null,
  }));
  const history: RolloutAuditEntry[] = [];

  function audit(flag: RolloutFlag, event: string, status: RolloutStageStatus, initiator: string | null, detail: Record<string, unknown> = {}): void {
    const entry: RolloutAuditEntry = {
      at: new Date(cfg.now()),
      flag,
      event,
      status,
      initiator,
      detail,
    };
    history.unshift(entry);
    if (history.length > cfg.historyCapacity) history.pop();
    log('info', `rollout_${event}`, {
      flag,
      status,
      initiator,
      ...detail,
    });
  }

  function getStage(flag: RolloutFlag): RolloutStageState {
    const s = stages.find((x) => x.flag === flag);
    if (!s) throw new Error(`rolloutManager: unknown flag '${flag}'`);
    return s;
  }

  function activeFlag(): RolloutStageState | null {
    return stages.find((s) => ACTIVE_STATUSES.has(s.status)) ?? null;
  }

  function nextPending(): RolloutStageState | null {
    for (const s of stages) {
      if (s.status === 'PENDING') return s;
      if (ACTIVE_STATUSES.has(s.status)) return null;
      if (s.status === 'FAILED' || s.status === 'ROLLED_BACK') return null;
    }
    return null;
  }

  function blockers(): string[] {
    const out: string[] = [];
    const active = activeFlag();
    if (active) {
      out.push(`active_stage_in_progress:${active.flag}:${active.status}`);
    }
    for (const s of stages) {
      if (s.status === 'PAUSED') out.push(`paused:${s.flag}:${s.pauseReason ?? 'no_reason'}`);
      if (s.status === 'ROLLED_BACK') out.push(`rolled_back:${s.flag}:${s.rollbackReason ?? 'no_reason'}`);
      if (s.status === 'FAILED') out.push(`failed:${s.flag}`);
    }
    return out;
  }

  async function bootstrap(): Promise<void> {
    const registered = new Set(canary.snapshot().map((s) => s.flag));
    for (const flag of ROLLOUT_SEQUENCE) {
      if (registered.has(flag)) continue;
      await canary.register(flag, cfg.initialCanaryStage, async () => ({ status: 'healthy' }));
      const s = getStage(flag);
      s.canaryStage = cfg.initialCanaryStage;
      audit(flag, 'registered', s.status, null, { canary_stage: cfg.initialCanaryStage });
    }
  }

  async function beginNextStage(args: BeginStageArgs): Promise<RolloutStageState> {
    const blk = blockers();
    if (blk.length > 0) {
      throw new Error(`rolloutManager: cannot begin next stage — blockers: ${blk.join('; ')}`);
    }
    const next = nextPending();
    if (!next) throw new Error('rolloutManager: no pending stage to begin');

    next.status = 'ACTIVE';
    next.startedAt = new Date(cfg.now());
    next.lastInitiator = args.initiator;
    const snap = canary.snapshot().find((s) => s.flag === next.flag);
    if (!snap) {
      await canary.register(next.flag, cfg.initialCanaryStage, async () => ({ status: 'healthy' }));
      next.canaryStage = cfg.initialCanaryStage;
    } else {
      next.canaryStage = snap.stage;
    }
    audit(next.flag, 'stage_begun', next.status, args.initiator, { reason: args.reason });
    return next;
  }

  async function promote(args: PromoteArgs): Promise<RolloutStageState> {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no active flag to promote');
    if (target.status !== 'ACTIVE') {
      throw new Error(`rolloutManager: flag '${target.flag}' is not ACTIVE (status=${target.status})`);
    }
    const result = await canary.advance(target.flag);
    target.canaryStage = result.newStage;
    target.lastInitiator = args.initiator;
    audit(target.flag, 'promoted', target.status, args.initiator, {
      previous_stage: result.previousStage,
      new_stage: result.newStage,
      exposure_pct: result.exposurePct,
      reason: args.reason,
    });
    return target;
  }

  function markStabilizing(args: MarkStabilizingArgs): RolloutStageState {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no active flag to stabilize');
    if (target.status !== 'ACTIVE' && target.status !== 'PAUSED') {
      throw new Error(`rolloutManager: cannot stabilize flag '${target.flag}' in status ${target.status}`);
    }
    target.status = 'STABILIZING';
    target.enteredStabilizationAt = new Date(cfg.now());
    target.lastInitiator = args.initiator;
    audit(target.flag, 'stabilizing', target.status, args.initiator, { reason: args.reason });
    return target;
  }

  function markStable(args: BeginStageArgs & { flag?: RolloutFlag }): RolloutStageState {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no active flag to mark stable');
    if (target.status !== 'STABILIZING') {
      throw new Error(`rolloutManager: cannot mark stable from status ${target.status}`);
    }
    target.status = 'STABLE';
    target.stableSinceAt = new Date(cfg.now());
    target.lastInitiator = args.initiator;
    audit(target.flag, 'stable', target.status, args.initiator, { reason: args.reason });
    return target;
  }

  function pause(args: PauseArgs & { flag?: RolloutFlag }): RolloutStageState {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no active flag to pause');
    if (target.status !== 'ACTIVE' && target.status !== 'STABILIZING') {
      throw new Error(`rolloutManager: cannot pause flag '${target.flag}' in status ${target.status}`);
    }
    target.status = 'PAUSED';
    target.pausedAt = new Date(cfg.now());
    target.pauseReason = args.reason;
    target.lastInitiator = args.initiator;
    audit(target.flag, 'paused', target.status, args.initiator, { reason: args.reason });
    return target;
  }

  function resume(args: BeginStageArgs & { flag?: RolloutFlag }): RolloutStageState {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no flag to resume');
    if (target.status !== 'PAUSED') {
      throw new Error(`rolloutManager: cannot resume flag '${target.flag}' in status ${target.status}`);
    }
    target.status = target.enteredStabilizationAt ? 'STABILIZING' : 'ACTIVE';
    target.pausedAt = null;
    target.pauseReason = null;
    target.lastInitiator = args.initiator;
    audit(target.flag, 'resumed', target.status, args.initiator, { reason: args.reason });
    return target;
  }

  async function rollback(args: { flag?: RolloutFlag; reason: string; initiator: string; panic?: boolean }): Promise<RolloutStageState> {
    const target = args.flag ? getStage(args.flag) : activeFlag();
    if (!target) throw new Error('rolloutManager: no flag to roll back');
    const result = await canary.rollback(target.flag, args.reason, { panic: args.panic });
    target.canaryStage = result.newStage;
    target.status = 'ROLLED_BACK';
    target.rollbackReason = args.reason;
    target.lastInitiator = args.initiator;
    audit(target.flag, 'rolled_back', target.status, args.initiator, {
      previous_stage: result.previousStage,
      new_stage: result.newStage,
      exposure_pct: result.exposurePct,
      panic: !!args.panic,
      reason: args.reason,
    });
    return target;
  }

  function snapshot(): RolloutSnapshot {
    const active = activeFlag();
    return {
      generatedAt: new Date(cfg.now()),
      currentFlag: active?.flag ?? null,
      currentStatus: active?.status ?? null,
      stages: stages.map((s) => ({ ...s })),
      blockers: blockers(),
      history: history.slice(0, 100).map((h) => ({ ...h, detail: { ...h.detail } })),
    };
  }

  return {
    bootstrap,
    beginNextStage,
    promote,
    markStabilizing,
    markStable,
    pause,
    resume,
    rollback,
    snapshot,
    blockers,
  };
}
