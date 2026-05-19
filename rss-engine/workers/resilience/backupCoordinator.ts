/**
 * Phase G — Backup coordinator.
 *
 * Pure metadata/orchestration layer for backup operations. Does NOT
 * implement the backup itself — Supabase / Postgres backups remain owned
 * by the infra. This module records what is expected, what was observed,
 * and emits freshness scoring + restore-point lineage.
 *
 * Capabilities:
 *   - backup scheduling metadata (RPO / RTO targets)
 *   - retention windows (per-tier)
 *   - backup verification state (passed / failed / pending)
 *   - restore-point lineage (parent → child snapshot chain)
 *   - corruption detection markers
 *   - backup freshness scoring
 *   - restore simulation tracking
 */

export type BackupTier = 'continuous' | 'daily' | 'weekly' | 'monthly';

export interface BackupSchedule {
  tier: BackupTier;
  intervalMs: number;
  retentionMs: number;
  /** Recovery point objective — max acceptable age for this tier. */
  rpoMs: number;
}

export interface BackupRecord {
  id: string;
  tier: BackupTier;
  createdAt: string;
  sizeBytes: number;
  /** ID of the parent snapshot (the snapshot this delta builds on). */
  parentId: string | null;
  /** True if the verifier validated checksum + restore-ability. */
  verified: boolean;
  verifiedAt: string | null;
  corruptionMarkers: string[];
  /** When non-null, this snapshot has been used for a restore-sim. */
  lastRestoreSimulationAt: string | null;
}

export interface BackupFreshness {
  tier: BackupTier;
  latestAt: string | null;
  ageMs: number | null;
  withinRpo: boolean;
  freshnessScore: number; // 0..1
}

export interface RestoreSimulationOutcome {
  snapshotId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  notes: string[];
}

export interface BackupCoordinatorConfig {
  schedules: BackupSchedule[];
  now?: () => Date;
  maxRecords?: number;
}

export interface BackupCoordinator {
  recordBackup(input: Omit<BackupRecord, 'verified' | 'verifiedAt' | 'corruptionMarkers' | 'lastRestoreSimulationAt'>): BackupRecord;
  markVerified(id: string): BackupRecord | null;
  markCorrupted(id: string, marker: string): BackupRecord | null;
  recordRestoreSimulation(snapshotId: string, outcome: Omit<RestoreSimulationOutcome, 'snapshotId'>): RestoreSimulationOutcome | null;
  freshness(): BackupFreshness[];
  freshnessScore(): number;
  lineage(snapshotId: string): BackupRecord[];
  list(tier?: BackupTier): BackupRecord[];
  schedule(tier: BackupTier): BackupSchedule | null;
}

export function createBackupCoordinator(config: BackupCoordinatorConfig): BackupCoordinator {
  const now = config.now ?? (() => new Date());
  const maxRecords = Math.max(64, config.maxRecords ?? 5_000);
  const records: BackupRecord[] = [];
  const byId = new Map<string, BackupRecord>();
  const simulations: RestoreSimulationOutcome[] = [];
  const schedules = new Map<BackupTier, BackupSchedule>(config.schedules.map((s) => [s.tier, s]));

  function prune(): void {
    while (records.length > maxRecords) {
      const dropped = records.shift();
      if (dropped) byId.delete(dropped.id);
    }
  }

  return {
    recordBackup(input) {
      const record: BackupRecord = {
        ...input,
        verified: false,
        verifiedAt: null,
        corruptionMarkers: [],
        lastRestoreSimulationAt: null,
      };
      records.push(record);
      byId.set(record.id, record);
      prune();
      return record;
    },

    markVerified(id) {
      const r = byId.get(id);
      if (!r) return null;
      r.verified = true;
      r.verifiedAt = now().toISOString();
      return r;
    },

    markCorrupted(id, marker) {
      const r = byId.get(id);
      if (!r) return null;
      if (!r.corruptionMarkers.includes(marker)) r.corruptionMarkers.push(marker);
      r.verified = false;
      return r;
    },

    recordRestoreSimulation(snapshotId, outcome) {
      const r = byId.get(snapshotId);
      if (!r) return null;
      r.lastRestoreSimulationAt = outcome.completedAt;
      const sim: RestoreSimulationOutcome = { snapshotId, ...outcome };
      simulations.push(sim);
      return sim;
    },

    freshness() {
      const result: BackupFreshness[] = [];
      for (const [tier, schedule] of schedules) {
        const latest = records
          .filter((r) => r.tier === tier && r.verified && r.corruptionMarkers.length === 0)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        const ageMs = latest ? now().getTime() - new Date(latest.createdAt).getTime() : null;
        const withinRpo = ageMs !== null && ageMs <= schedule.rpoMs;
        const freshnessScore =
          ageMs === null ? 0 : Math.max(0, 1 - ageMs / (schedule.rpoMs * 2));
        result.push({
          tier,
          latestAt: latest?.createdAt ?? null,
          ageMs,
          withinRpo,
          freshnessScore,
        });
      }
      return result;
    },

    freshnessScore() {
      const items = this.freshness();
      if (items.length === 0) return 0;
      return items.reduce((s, f) => s + f.freshnessScore, 0) / items.length;
    },

    lineage(snapshotId) {
      const chain: BackupRecord[] = [];
      let cursor = byId.get(snapshotId);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.push(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) ?? undefined : undefined;
      }
      return chain;
    },

    list(tier) {
      return records.filter((r) => !tier || r.tier === tier);
    },

    schedule(tier) {
      return schedules.get(tier) ?? null;
    },
  };
}

export const DEFAULT_BACKUP_SCHEDULES: BackupSchedule[] = [
  { tier: 'continuous', intervalMs: 5 * 60_000, retentionMs: 24 * 3_600_000, rpoMs: 15 * 60_000 },
  { tier: 'daily', intervalMs: 24 * 3_600_000, retentionMs: 30 * 24 * 3_600_000, rpoMs: 26 * 3_600_000 },
  { tier: 'weekly', intervalMs: 7 * 24 * 3_600_000, retentionMs: 90 * 24 * 3_600_000, rpoMs: 8 * 24 * 3_600_000 },
  { tier: 'monthly', intervalMs: 30 * 24 * 3_600_000, retentionMs: 365 * 24 * 3_600_000, rpoMs: 32 * 24 * 3_600_000 },
];
