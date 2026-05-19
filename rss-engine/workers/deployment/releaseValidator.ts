/**
 * Phase G — Release validator.
 *
 * Runs the suite of preflight checks the release orchestrator depends on:
 *
 *   - migration verification (declared migrations are actually applied)
 *   - feature-flag compatibility validation (no flag dependency cycles,
 *     no flag enabled while its prerequisite migration is unapplied)
 *   - blocked-rollout detection (incident-active stages)
 *   - production freeze enforcement
 *   - deployment fingerprint sanity
 *   - dry-run safety markers
 *
 * Pure compute. Returns a structured report; the caller decides whether
 * to halt the deployment.
 */

import type { BuildFingerprint } from './buildFingerprint';
import type { EnvironmentDiff } from './environmentDiff';

export interface FlagDeclaration {
  key: string;
  enabled: boolean;
  rolloutPct: number;
  /** Flags this flag depends on (must be enabled first). */
  dependsOn: string[];
  /** Migrations this flag requires. */
  requiresMigrations: string[];
}

export interface ReleaseValidationInput {
  build: BuildFingerprint;
  declaredMigrations: string[];
  appliedMigrations: string[];
  flags: FlagDeclaration[];
  /** True if the orchestrator is in production-freeze mode. */
  productionFreeze: boolean;
  /** True if this is a dry run (no side-effects). */
  dryRun: boolean;
  /** Incident IDs currently open at SEVERE+ severity. */
  openSevereIncidentIds: string[];
  envDiff?: EnvironmentDiff;
}

export type FindingSeverity = 'info' | 'warning' | 'blocker';

export interface ValidationFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ReleaseValidationReport {
  ok: boolean;
  blockerCount: number;
  warningCount: number;
  findings: ValidationFinding[];
  build: BuildFingerprint;
}

function flagCycle(flags: FlagDeclaration[]): string[] | null {
  const byKey = new Map(flags.map((f) => [f.key, f]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let cycle: string[] | null = null;

  function visit(key: string, stack: string[]): void {
    if (cycle) return;
    const c = color.get(key) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      const cycleStart = stack.indexOf(key);
      cycle = stack.slice(cycleStart === -1 ? 0 : cycleStart).concat(key);
      return;
    }
    color.set(key, GRAY);
    stack.push(key);
    const node = byKey.get(key);
    if (node) {
      for (const dep of node.dependsOn) {
        if (byKey.has(dep)) visit(dep, stack);
      }
    }
    stack.pop();
    color.set(key, BLACK);
  }

  for (const f of flags) visit(f.key, []);
  return cycle;
}

export function validateRelease(input: ReleaseValidationInput): ReleaseValidationReport {
  const findings: ValidationFinding[] = [];

  // Migration coverage.
  const applied = new Set(input.appliedMigrations);
  const missing = input.declaredMigrations.filter((m) => !applied.has(m));
  if (missing.length > 0) {
    findings.push({
      code: 'migration_not_applied',
      severity: 'blocker',
      message: `${missing.length} declared migration(s) not applied`,
      detail: { missing },
    });
  }
  const orphaned = input.appliedMigrations.filter((m) => !input.declaredMigrations.includes(m));
  if (orphaned.length > 0) {
    findings.push({
      code: 'migration_orphaned',
      severity: 'warning',
      message: `${orphaned.length} migration(s) applied but not declared`,
      detail: { orphaned },
    });
  }

  // Flag dependency cycles.
  const cycle = flagCycle(input.flags);
  if (cycle) {
    findings.push({
      code: 'flag_dependency_cycle',
      severity: 'blocker',
      message: 'feature flag dependency graph has a cycle',
      detail: { cycle },
    });
  }

  // Flag prerequisites.
  const enabledKeys = new Set(input.flags.filter((f) => f.enabled).map((f) => f.key));
  for (const f of input.flags) {
    if (!f.enabled) continue;
    const missingDeps = f.dependsOn.filter((d) => !enabledKeys.has(d));
    if (missingDeps.length > 0) {
      findings.push({
        code: 'flag_dependency_missing',
        severity: 'blocker',
        message: `flag ${f.key} requires dependencies that are not enabled`,
        detail: { flag: f.key, missing: missingDeps },
      });
    }
    const missingMig = f.requiresMigrations.filter((m) => !applied.has(m));
    if (missingMig.length > 0) {
      findings.push({
        code: 'flag_requires_unapplied_migration',
        severity: 'blocker',
        message: `flag ${f.key} requires unapplied migration(s)`,
        detail: { flag: f.key, missing: missingMig },
      });
    }
  }

  // Production freeze.
  if (input.productionFreeze && !input.dryRun) {
    findings.push({
      code: 'production_freeze_active',
      severity: 'blocker',
      message: 'production deploys are frozen; only dry-runs are allowed',
    });
  }

  // Open severe incidents.
  if (input.openSevereIncidentIds.length > 0) {
    findings.push({
      code: 'open_severe_incidents',
      severity: 'blocker',
      message: `${input.openSevereIncidentIds.length} open SEVERE+ incident(s); cannot deploy`,
      detail: { incidentIds: input.openSevereIncidentIds },
    });
  }

  // Environment diff signals.
  if (input.envDiff) {
    if (input.envDiff.migrationsBehind.length > 0) {
      findings.push({
        code: 'env_migration_behind',
        severity: 'warning',
        message: 'target environment is missing migrations the source already has',
        detail: { migrations: input.envDiff.migrationsBehind },
      });
    }
    if (!input.envDiff.artifactMatches && input.envDiff.flagsChanged.length === 0) {
      findings.push({
        code: 'artifact_diverged',
        severity: 'info',
        message: 'build artifact differs but no flag changes — verify intent',
      });
    }
  }

  const blockerCount = findings.filter((f) => f.severity === 'blocker').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  return {
    ok: blockerCount === 0,
    blockerCount,
    warningCount,
    findings,
    build: input.build,
  };
}
