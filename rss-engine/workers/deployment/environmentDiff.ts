/**
 * Phase G — Environment diff.
 *
 * Compares two `EnvironmentSnapshot`s and produces a structured diff. The
 * release orchestrator uses this for environment-parity checks, blue/green
 * compatibility validation, and preflight reports.
 *
 * Pure compute. No I/O.
 */

import type { BuildFingerprint } from './buildFingerprint';

export interface EnvironmentSnapshot {
  environment: 'preview' | 'staging' | 'production' | 'green' | 'blue';
  build: BuildFingerprint;
  flags: Record<string, { enabled: boolean; rolloutPct: number }>;
  migrationsApplied: string[];
  cronJobsActive: string[];
  /** Free-form environment markers (region, DB version, etc.). */
  markers: Record<string, string>;
}

export interface EnvironmentDiff {
  contentMatches: boolean;
  artifactMatches: boolean;
  flagsAdded: string[];
  flagsRemoved: string[];
  flagsChanged: Array<{ key: string; from: { enabled: boolean; rolloutPct: number }; to: { enabled: boolean; rolloutPct: number } }>;
  migrationsAhead: string[]; // in target but not in source
  migrationsBehind: string[]; // in source but not in target
  cronAdded: string[];
  cronRemoved: string[];
  markersChanged: Array<{ key: string; from: string | null; to: string | null }>;
  /** True if no meaningful differences remain. */
  isParity: boolean;
}

export function diffEnvironments(
  source: EnvironmentSnapshot,
  target: EnvironmentSnapshot,
): EnvironmentDiff {
  const flagsAdded: string[] = [];
  const flagsRemoved: string[] = [];
  const flagsChanged: EnvironmentDiff['flagsChanged'] = [];

  const allFlagKeys = new Set([...Object.keys(source.flags), ...Object.keys(target.flags)]);
  for (const k of allFlagKeys) {
    const a = source.flags[k];
    const b = target.flags[k];
    if (a && !b) flagsRemoved.push(k);
    else if (!a && b) flagsAdded.push(k);
    else if (a && b && (a.enabled !== b.enabled || a.rolloutPct !== b.rolloutPct)) {
      flagsChanged.push({ key: k, from: a, to: b });
    }
  }

  const srcMig = new Set(source.migrationsApplied);
  const tgtMig = new Set(target.migrationsApplied);
  const migrationsAhead = [...tgtMig].filter((m) => !srcMig.has(m));
  const migrationsBehind = [...srcMig].filter((m) => !tgtMig.has(m));

  const srcCron = new Set(source.cronJobsActive);
  const tgtCron = new Set(target.cronJobsActive);
  const cronAdded = [...tgtCron].filter((c) => !srcCron.has(c));
  const cronRemoved = [...srcCron].filter((c) => !tgtCron.has(c));

  const markersChanged: EnvironmentDiff['markersChanged'] = [];
  const allMarkers = new Set([...Object.keys(source.markers), ...Object.keys(target.markers)]);
  for (const k of allMarkers) {
    const from = source.markers[k] ?? null;
    const to = target.markers[k] ?? null;
    if (from !== to) markersChanged.push({ key: k, from, to });
  }

  const isParity =
    flagsAdded.length === 0 &&
    flagsRemoved.length === 0 &&
    flagsChanged.length === 0 &&
    migrationsAhead.length === 0 &&
    migrationsBehind.length === 0 &&
    cronAdded.length === 0 &&
    cronRemoved.length === 0 &&
    markersChanged.length === 0;

  return {
    contentMatches: source.build.contentHash === target.build.contentHash,
    artifactMatches: source.build.artifactHash === target.build.artifactHash,
    flagsAdded,
    flagsRemoved,
    flagsChanged,
    migrationsAhead,
    migrationsBehind,
    cronAdded,
    cronRemoved,
    markersChanged,
    isParity,
  };
}

/**
 * Returns a short human-readable summary of the diff suitable for logs.
 */
export function summarizeDiff(diff: EnvironmentDiff): string {
  if (diff.isParity) return 'parity';
  const parts: string[] = [];
  if (!diff.artifactMatches) parts.push('artifact_changed');
  if (diff.flagsAdded.length) parts.push(`flags+${diff.flagsAdded.length}`);
  if (diff.flagsRemoved.length) parts.push(`flags-${diff.flagsRemoved.length}`);
  if (diff.flagsChanged.length) parts.push(`flags~${diff.flagsChanged.length}`);
  if (diff.migrationsAhead.length) parts.push(`mig+${diff.migrationsAhead.length}`);
  if (diff.migrationsBehind.length) parts.push(`mig-${diff.migrationsBehind.length}`);
  if (diff.cronAdded.length) parts.push(`cron+${diff.cronAdded.length}`);
  if (diff.cronRemoved.length) parts.push(`cron-${diff.cronRemoved.length}`);
  if (diff.markersChanged.length) parts.push(`markers~${diff.markersChanged.length}`);
  return parts.join(' ');
}
