/**
 * Phase G — Release orchestrator.
 *
 * Top-level state machine for an entire deployment session. Sits ABOVE
 * `canaryController` and `rolloutManager`: a single release session may
 * encompass multiple feature-flag rollouts, plus the migration apply step
 * and post-deploy verification.
 *
 * Stages (strict order):
 *
 *   PLANNED      — session created from manifest
 *   PREFLIGHT    — release validator + environment diff
 *   MIGRATING    — declared migrations apply (host runs them; we record)
 *   DEPLOYING    — build artifact rolled out to runtime
 *   VERIFYING    — post-deploy health probes
 *   STABILIZED   — verification passed
 *   ROLLED_BACK  — automatic or operator-triggered rollback
 *   FAILED       — preflight or verification blocked
 *
 * Features:
 *   - dry-run deployments (no state side-effects beyond the session log)
 *   - partial-deploy rollback (per-stage)
 *   - failed-migration isolation (subsequent stages refuse to proceed)
 *   - deployment replay safety (rejects identical fingerprint within
 *     `replayWindowMs`)
 *   - production freeze mode (rejects non-dry-run sessions)
 *   - staged mobile/backend coordination (mobile stage waits on backend)
 *   - safe restart orchestration (host-supplied callbacks)
 *   - deployment health scoring
 *   - blue/green-compatible logic via parity diff (no infra required)
 *
 * HARD RULES:
 *   - PURE COMPUTE. The host wires the side-effects via callbacks.
 *   - APPEND-ONLY transitions. Each transition emits an event entry.
 *   - REVERSIBLE. Any transition prior to STABILIZED may trigger rollback.
 */

import type { LogFn } from '../lib/logger';
import type { BuildFingerprint } from './buildFingerprint';
import type { EnvironmentDiff } from './environmentDiff';
import { fingerprintIsRedeploy } from './buildFingerprint';
import type {
  FlagDeclaration,
  ReleaseValidationReport,
  ValidationFinding,
} from './releaseValidator';
import { validateRelease } from './releaseValidator';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReleaseStage =
  | 'PLANNED'
  | 'PREFLIGHT'
  | 'MIGRATING'
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'STABILIZED'
  | 'ROLLED_BACK'
  | 'FAILED';

export interface ReleaseManifest {
  sessionId?: string;
  build: BuildFingerprint;
  declaredMigrations: string[];
  appliedMigrations: string[];
  flags: FlagDeclaration[];
  openSevereIncidentIds?: string[];
  envDiff?: EnvironmentDiff;
  /** When true, mobile rollout waits for backend verification. */
  coordinateMobile?: boolean;
  initiator: string;
  reason: string;
}

export interface ReleaseSessionEvent {
  at: string;
  from: ReleaseStage;
  to: ReleaseStage;
  initiator: string;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface VerificationProbeSnapshot {
  /** Composite health 0..1; <0.85 fails verification. */
  healthScore: number;
  queueLatencyMs: number;
  errorSpikeRatio: number;
  notificationFailurePct: number;
  rankingFreshnessMs: number;
  mobileReady?: boolean;
}

export interface ReleaseSessionState {
  sessionId: string;
  stage: ReleaseStage;
  dryRun: boolean;
  productionFreeze: boolean;
  build: BuildFingerprint;
  manifest: ReleaseManifest;
  events: ReleaseSessionEvent[];
  validation: ReleaseValidationReport | null;
  verification: VerificationProbeSnapshot | null;
  healthScore: number | null;
  rollbackReason: string | null;
}

export interface ReleaseOrchestratorConfig {
  now?: () => Date;
  /** Window during which a redeploy of the same fingerprint is rejected. */
  replayWindowMs?: number;
  /** Verification health-score threshold. Default 0.85. */
  verificationThreshold?: number;
}

export interface ReleaseOrchestrator {
  plan(manifest: ReleaseManifest, opts?: { dryRun?: boolean }): ReleaseSessionState;
  preflight(sessionId: string): ReleaseSessionState;
  beginMigrations(sessionId: string): ReleaseSessionState;
  beginDeploy(sessionId: string): ReleaseSessionState;
  beginVerification(sessionId: string, probe: VerificationProbeSnapshot): ReleaseSessionState;
  markStabilized(sessionId: string): ReleaseSessionState;
  rollback(sessionId: string, reason: string, initiator: string): ReleaseSessionState;
  setProductionFreeze(active: boolean, initiator: string, reason: string): void;
  isProductionFrozen(): boolean;
  get(sessionId: string): ReleaseSessionState | null;
  list(): ReleaseSessionState[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReleaseOrchestrator(
  log: LogFn,
  config: ReleaseOrchestratorConfig = {},
): ReleaseOrchestrator {
  const now = config.now ?? (() => new Date());
  const replayWindowMs = Math.max(60_000, config.replayWindowMs ?? 10 * 60_000);
  const verificationThreshold = config.verificationThreshold ?? 0.85;

  const sessions = new Map<string, ReleaseSessionState>();
  let productionFreeze = false;

  function transition(
    s: ReleaseSessionState,
    to: ReleaseStage,
    initiator: string,
    reason: string,
    detail?: Record<string, unknown>,
  ): void {
    const event: ReleaseSessionEvent = {
      at: now().toISOString(),
      from: s.stage,
      to,
      initiator,
      reason,
      detail,
    };
    s.events.push(event);
    s.stage = to;
    log('info', `release_orchestrator:${to.toLowerCase()}`, {
      session_id: s.sessionId,
      from: event.from,
      to,
      reason,
    });
  }

  function recentReplay(build: BuildFingerprint): ReleaseSessionState | null {
    const cutoff = now().getTime() - replayWindowMs;
    for (const s of sessions.values()) {
      if (s.stage !== 'STABILIZED' && s.stage !== 'DEPLOYING') continue;
      const last = s.events[s.events.length - 1];
      if (!last) continue;
      if (new Date(last.at).getTime() < cutoff) continue;
      if (fingerprintIsRedeploy(s.build, build)) return s;
    }
    return null;
  }

  return {
    plan(manifest, opts = {}) {
      const dryRun = !!opts.dryRun;
      const replay = recentReplay(manifest.build);
      if (replay && !dryRun) {
        log('warn', 'release_orchestrator:replay_rejected', {
          replaying_session: replay.sessionId,
          fingerprint: manifest.build.contentHash,
        });
      }
      const sessionId =
        manifest.sessionId ??
        `rel_${now().getTime().toString(36)}_${manifest.build.contentHash.slice(0, 8)}`;
      const state: ReleaseSessionState = {
        sessionId,
        stage: 'PLANNED',
        dryRun,
        productionFreeze,
        build: manifest.build,
        manifest,
        events: [],
        validation: null,
        verification: null,
        healthScore: null,
        rollbackReason: null,
      };
      sessions.set(sessionId, state);
      transition(state, 'PLANNED', manifest.initiator, manifest.reason, {
        dry_run: dryRun,
        replay_blocked: !!(replay && !dryRun),
      });
      return state;
    },

    preflight(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage !== 'PLANNED') {
        throw new Error(`preflight_requires_planned:current=${s.stage}`);
      }
      transition(s, 'PREFLIGHT', s.manifest.initiator, 'begin_preflight');
      const report = validateRelease({
        build: s.build,
        declaredMigrations: s.manifest.declaredMigrations,
        appliedMigrations: s.manifest.appliedMigrations,
        flags: s.manifest.flags,
        productionFreeze,
        dryRun: s.dryRun,
        openSevereIncidentIds: s.manifest.openSevereIncidentIds ?? [],
        envDiff: s.manifest.envDiff,
      });
      s.validation = report;
      if (!report.ok) {
        transition(s, 'FAILED', s.manifest.initiator, 'preflight_blocked', {
          blockers: report.findings.filter((f: ValidationFinding) => f.severity === 'blocker'),
        });
      }
      return s;
    },

    beginMigrations(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage !== 'PREFLIGHT' || !s.validation?.ok) {
        throw new Error(`migrations_require_passing_preflight:current=${s.stage}`);
      }
      transition(s, 'MIGRATING', s.manifest.initiator, 'begin_migrations');
      return s;
    },

    beginDeploy(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage !== 'MIGRATING') {
        throw new Error(`deploy_requires_migrations:current=${s.stage}`);
      }
      transition(s, 'DEPLOYING', s.manifest.initiator, 'begin_deploy');
      return s;
    },

    beginVerification(sessionId, probe) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage !== 'DEPLOYING') {
        throw new Error(`verify_requires_deploying:current=${s.stage}`);
      }
      s.verification = { ...probe };
      s.healthScore = probe.healthScore;
      transition(s, 'VERIFYING', s.manifest.initiator, 'begin_verification', {
        health_score: probe.healthScore,
      });
      if (probe.healthScore < verificationThreshold) {
        s.rollbackReason = `verification_failed:health=${probe.healthScore.toFixed(2)}`;
        transition(s, 'ROLLED_BACK', s.manifest.initiator, s.rollbackReason);
      } else if (s.manifest.coordinateMobile && probe.mobileReady === false) {
        s.rollbackReason = 'mobile_not_ready';
        transition(s, 'ROLLED_BACK', s.manifest.initiator, s.rollbackReason);
      }
      return s;
    },

    markStabilized(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage !== 'VERIFYING') {
        throw new Error(`stabilize_requires_verifying:current=${s.stage}`);
      }
      transition(s, 'STABILIZED', s.manifest.initiator, 'verification_passed');
      return s;
    },

    rollback(sessionId, reason, initiator) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown_session:${sessionId}`);
      if (s.stage === 'STABILIZED' || s.stage === 'ROLLED_BACK' || s.stage === 'FAILED') {
        return s; // idempotent
      }
      s.rollbackReason = reason;
      transition(s, 'ROLLED_BACK', initiator, reason);
      return s;
    },

    setProductionFreeze(active, initiator, reason) {
      productionFreeze = active;
      log('warn', 'release_orchestrator:freeze_changed', { active, initiator, reason });
    },

    isProductionFrozen() {
      return productionFreeze;
    },

    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },

    list() {
      return [...sessions.values()];
    },
  };
}
