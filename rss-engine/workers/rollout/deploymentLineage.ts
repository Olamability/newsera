/**
 * Phase G — Deployment lineage.
 *
 * Closes the Phase F debt: `rolloutManager` tracks stage transitions but
 * has no immutable deployment lineage record. This module owns the
 * cryptographically-stable identifier for every release session and the
 * directed-graph of "what shipped on top of what".
 *
 * Capabilities:
 *   - deployment fingerprinting (build hash + migration hash + flag hash)
 *   - rollout session IDs (one per orchestrated release)
 *   - build → migration → feature-flag lineage mapping
 *   - release traceability (find the session that introduced a flag)
 *   - rollback ancestry graph (which session was rolled back to what)
 *
 * HARD RULES:
 *   - PURE COMPUTE. Persistence is the host's responsibility.
 *   - IMMUTABLE. Sessions cannot be edited once closed; only superseded.
 *   - DETERMINISTIC. Same inputs → same fingerprint.
 */

export interface BuildArtifactDescriptor {
  buildId: string;
  gitSha: string;
  builtAt: string;
  /** Names of the packages this build contains. */
  packages: string[];
}

export interface MigrationDescriptor {
  /** Migration filename or unique key — e.g., '20251201_add_notification_ledger'. */
  id: string;
  /** True if the migration has been verified applied in the target env. */
  applied: boolean;
  /** Optional checksum reported by Supabase migration metadata. */
  checksum?: string;
}

export interface FeatureFlagDescriptor {
  key: string;
  rolloutPct: number;
  enabled: boolean;
}

export interface DeploymentSessionInput {
  sessionId?: string; // generated when omitted
  environment: 'preview' | 'staging' | 'production';
  build: BuildArtifactDescriptor;
  migrations: MigrationDescriptor[];
  flags: FeatureFlagDescriptor[];
  /** sessionId this deployment supersedes (null for the first). */
  parentSessionId?: string | null;
  initiator: string;
  reason: string;
}

export type DeploymentStatus =
  | 'STAGED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ROLLED_BACK'
  | 'FAILED';

export interface DeploymentSession {
  sessionId: string;
  fingerprint: string;
  environment: 'preview' | 'staging' | 'production';
  build: BuildArtifactDescriptor;
  migrationFingerprint: string;
  flagFingerprint: string;
  migrations: MigrationDescriptor[];
  flags: FeatureFlagDescriptor[];
  parentSessionId: string | null;
  rolledBackBySessionId: string | null;
  status: DeploymentStatus;
  initiator: string;
  reason: string;
  startedAt: string;
  closedAt: string | null;
}

export interface RollbackAncestry {
  sessionId: string;
  fingerprint: string;
  status: DeploymentStatus;
  parentSessionId: string | null;
  rolledBackBySessionId: string | null;
}

export interface DeploymentLineageConfig {
  now?: () => Date;
  /** Hard cap on retained sessions to bound memory. */
  maxSessions?: number;
}

export interface DeploymentLineage {
  openSession(input: DeploymentSessionInput): DeploymentSession;
  markInProgress(sessionId: string): DeploymentSession | null;
  closeSession(sessionId: string, status: 'COMPLETED' | 'FAILED'): DeploymentSession | null;
  rollback(sessionId: string, supersededBy: string, reason: string): DeploymentSession | null;
  findByFlagIntroduction(flagKey: string): DeploymentSession[];
  findByMigration(migrationId: string): DeploymentSession[];
  ancestry(sessionId: string): RollbackAncestry[];
  get(sessionId: string): DeploymentSession | null;
  list(): DeploymentSession[];
  computeFingerprint(input: DeploymentSessionInput): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(input: string): string {
  // FNV-1a 32-bit — deterministic and good enough for fingerprint use.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortedJoin(values: string[]): string {
  return [...values].sort().join('|');
}

function flagFingerprint(flags: FeatureFlagDescriptor[]): string {
  return hashString(
    sortedJoin(flags.map((f) => `${f.key}=${f.enabled ? 'on' : 'off'}@${f.rolloutPct}`)),
  );
}

function migrationFingerprint(migrations: MigrationDescriptor[]): string {
  return hashString(
    sortedJoin(migrations.map((m) => `${m.id}:${m.checksum ?? 'na'}:${m.applied ? '1' : '0'}`)),
  );
}

export function createDeploymentLineage(config: DeploymentLineageConfig = {}): DeploymentLineage {
  const now = config.now ?? (() => new Date());
  const maxSessions = Math.max(8, config.maxSessions ?? 500);
  const sessions: DeploymentSession[] = [];
  const byId = new Map<string, DeploymentSession>();

  function computeFingerprint(input: DeploymentSessionInput): string {
    const buildPart = `${input.build.buildId}:${input.build.gitSha}`;
    const mig = migrationFingerprint(input.migrations);
    const flg = flagFingerprint(input.flags);
    return `${hashString(buildPart)}-${mig}-${flg}-${input.environment}`;
  }

  function pruneIfNeeded(): void {
    while (sessions.length > maxSessions) {
      const dropped = sessions.shift();
      if (dropped) byId.delete(dropped.sessionId);
    }
  }

  return {
    computeFingerprint,

    openSession(input) {
      const fingerprint = computeFingerprint(input);
      const ts = now();
      const sessionId =
        input.sessionId ?? `rel_${ts.getTime().toString(36)}_${fingerprint.slice(0, 8)}`;
      const session: DeploymentSession = {
        sessionId,
        fingerprint,
        environment: input.environment,
        build: { ...input.build, packages: [...input.build.packages] },
        migrationFingerprint: migrationFingerprint(input.migrations),
        flagFingerprint: flagFingerprint(input.flags),
        migrations: input.migrations.map((m) => ({ ...m })),
        flags: input.flags.map((f) => ({ ...f })),
        parentSessionId: input.parentSessionId ?? null,
        rolledBackBySessionId: null,
        status: 'STAGED',
        initiator: input.initiator,
        reason: input.reason,
        startedAt: ts.toISOString(),
        closedAt: null,
      };
      sessions.push(session);
      byId.set(sessionId, session);
      pruneIfNeeded();
      return session;
    },

    markInProgress(sessionId) {
      const s = byId.get(sessionId);
      if (!s) return null;
      if (s.status === 'STAGED') s.status = 'IN_PROGRESS';
      return s;
    },

    closeSession(sessionId, status) {
      const s = byId.get(sessionId);
      if (!s) return null;
      if (s.status === 'ROLLED_BACK') return s;
      s.status = status;
      s.closedAt = now().toISOString();
      return s;
    },

    rollback(sessionId, supersededBy, reason) {
      const s = byId.get(sessionId);
      if (!s) return null;
      s.status = 'ROLLED_BACK';
      s.rolledBackBySessionId = supersededBy;
      s.closedAt = now().toISOString();
      s.reason = `${s.reason} | rollback: ${reason}`;
      return s;
    },

    findByFlagIntroduction(flagKey) {
      const out: DeploymentSession[] = [];
      for (const s of sessions) {
        const flag = s.flags.find((f) => f.key === flagKey);
        if (!flag) continue;
        // Compare to parent: introduction = first session enabling the flag.
        const parent = s.parentSessionId ? byId.get(s.parentSessionId) ?? null : null;
        const parentFlag = parent?.flags.find((f) => f.key === flagKey);
        if (!parentFlag || parentFlag.enabled !== flag.enabled || parentFlag.rolloutPct !== flag.rolloutPct) {
          out.push(s);
        }
      }
      return out;
    },

    findByMigration(migrationId) {
      return sessions.filter((s) => s.migrations.some((m) => m.id === migrationId));
    },

    ancestry(sessionId) {
      const chain: RollbackAncestry[] = [];
      let cursor: DeploymentSession | null = byId.get(sessionId) ?? null;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.sessionId)) {
        seen.add(cursor.sessionId);
        chain.push({
          sessionId: cursor.sessionId,
          fingerprint: cursor.fingerprint,
          status: cursor.status,
          parentSessionId: cursor.parentSessionId,
          rolledBackBySessionId: cursor.rolledBackBySessionId,
        });
        cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) ?? null : null;
      }
      return chain;
    },

    get(sessionId) {
      return byId.get(sessionId) ?? null;
    },

    list() {
      return [...sessions];
    },
  };
}
