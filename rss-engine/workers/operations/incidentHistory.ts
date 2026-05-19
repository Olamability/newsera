/**
 * Phase G — Persistent incident history.
 *
 * Closes the Phase F debt: `incidentDetector` is runtime-only and forgets
 * everything between processes. This module is the durable companion: an
 * append-only timeline of incidents with fingerprint-based dedup, MTTR
 * tracking, recurrence detection, severity trend analysis, and operator
 * acknowledgement lifecycle.
 *
 * Pure compute. The host is responsible for persistence (Postgres / file).
 * `serialize()` / `hydrate()` give the host a stable JSON envelope.
 *
 * HARD RULES:
 *   - Append-only. `resolve()` and `acknowledge()` mutate state, but never
 *     drop history entries (entries roll off only when the rolling window
 *     overflows `maxEntries`).
 *   - Dedup. Two incidents with the same fingerprint within
 *     `dedupWindowMs` collapse into a single timeline row whose
 *     `occurrences` counter increments.
 *   - Bounded memory. Timeline capped at `maxEntries`.
 */

import type { Incident, IncidentType, Severity } from './incidentDetector';
import { SEVERITY_RANK } from './incidentDetector';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AcknowledgementState = 'UNACKED' | 'ACKED' | 'RESOLVED';

export interface IncidentTimelineEntry {
  /** Stable id derived from fingerprint + firstSeen. */
  id: string;
  fingerprint: string;
  type: IncidentType;
  severity: Severity;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  state: AcknowledgementState;
  occurrences: number;
  /** Duration from firstSeen → resolvedAt in ms (null while open). */
  durationMs: number | null;
  /** Free-form metadata copied from the underlying incident. */
  detail: Record<string, unknown>;
}

export interface IncidentTrendSnapshot {
  windowMs: number;
  totalEntries: number;
  openEntries: number;
  unacknowledged: number;
  bySeverity: Record<Severity, number>;
  byType: Partial<Record<IncidentType, number>>;
  recurrenceRate: number; // entries with occurrences > 1 / total
  averageMttrMs: number | null;
  p95MttrMs: number | null;
  severityTrend: 'improving' | 'steady' | 'worsening';
}

export interface IncidentHistoryConfig {
  maxEntries?: number;
  dedupWindowMs?: number;
  now?: () => Date;
}

export interface IncidentHistory {
  record(incident: Incident): IncidentTimelineEntry;
  acknowledge(id: string, operator: string): IncidentTimelineEntry | null;
  resolve(id: string, note?: string): IncidentTimelineEntry | null;
  list(opts?: { state?: AcknowledgementState; sinceMs?: number }): IncidentTimelineEntry[];
  trend(windowMs: number): IncidentTrendSnapshot;
  serialize(): IncidentTimelineEntry[];
  hydrate(entries: IncidentTimelineEntry[]): void;
  size(): number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fingerprintOf(inc: Incident): string {
  // Stable fingerprint independent of timestamp/id.
  return `${inc.type}:${inc.severity}:${JSON.stringify(inc.detail ?? {})}`;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIncidentHistory(config: IncidentHistoryConfig = {}): IncidentHistory {
  const maxEntries = Math.max(16, config.maxEntries ?? 2_000);
  const dedupWindowMs = Math.max(1_000, config.dedupWindowMs ?? 5 * 60_000);
  const now = config.now ?? (() => new Date());

  let entries: IncidentTimelineEntry[] = [];
  const indexByFingerprint = new Map<string, IncidentTimelineEntry>();

  function pruneIfNeeded(): void {
    while (entries.length > maxEntries) {
      const dropped = entries.shift();
      if (dropped) {
        const idx = indexByFingerprint.get(dropped.fingerprint);
        if (idx && idx.id === dropped.id) indexByFingerprint.delete(dropped.fingerprint);
      }
    }
  }

  return {
    record(incident) {
      const fp = fingerprintOf(incident);
      const ts = now();
      const tsMs = ts.getTime();
      const existing = indexByFingerprint.get(fp);
      if (
        existing &&
        existing.state !== 'RESOLVED' &&
        tsMs - new Date(existing.lastSeenAt).getTime() <= dedupWindowMs
      ) {
        existing.lastSeenAt = ts.toISOString();
        existing.occurrences += 1;
        if (SEVERITY_RANK[incident.severity] > SEVERITY_RANK[existing.severity]) {
          existing.severity = incident.severity;
        }
        return existing;
      }

      const entry: IncidentTimelineEntry = {
        id: `${fp}|${tsMs}`,
        fingerprint: fp,
        type: incident.type,
        severity: incident.severity,
        firstSeenAt: ts.toISOString(),
        lastSeenAt: ts.toISOString(),
        resolvedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        state: 'UNACKED',
        occurrences: 1,
        durationMs: null,
        detail: { ...(incident.detail ?? {}) },
      };
      entries.push(entry);
      indexByFingerprint.set(fp, entry);
      pruneIfNeeded();
      return entry;
    },

    acknowledge(id, operator) {
      const entry = entries.find((e) => e.id === id);
      if (!entry || entry.state === 'RESOLVED') return null;
      entry.state = 'ACKED';
      entry.acknowledgedAt = now().toISOString();
      entry.acknowledgedBy = operator;
      return entry;
    },

    resolve(id, note) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;
      if (entry.state === 'RESOLVED') return entry;
      const ts = now();
      entry.state = 'RESOLVED';
      entry.resolvedAt = ts.toISOString();
      entry.durationMs = ts.getTime() - new Date(entry.firstSeenAt).getTime();
      if (note) entry.detail.resolution_note = note;
      return entry;
    },

    list(opts = {}) {
      const cutoff = opts.sinceMs ? now().getTime() - opts.sinceMs : null;
      return entries.filter((e) => {
        if (opts.state && e.state !== opts.state) return false;
        if (cutoff !== null && new Date(e.firstSeenAt).getTime() < cutoff) return false;
        return true;
      });
    },

    trend(windowMs) {
      const cutoff = now().getTime() - windowMs;
      const slice = entries.filter((e) => new Date(e.firstSeenAt).getTime() >= cutoff);
      const bySeverity: Record<Severity, number> = { INFO: 0, WARNING: 0, SEVERE: 0, CRITICAL: 0 };
      const byType: Partial<Record<IncidentType, number>> = {};
      const mttrSamples: number[] = [];
      let recurring = 0;
      let open = 0;
      let unacked = 0;
      for (const e of slice) {
        bySeverity[e.severity] += 1;
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        if (e.durationMs !== null) mttrSamples.push(e.durationMs);
        if (e.occurrences > 1) recurring += 1;
        if (e.state !== 'RESOLVED') open += 1;
        if (e.state === 'UNACKED') unacked += 1;
      }
      // Severity trend: compare first vs second half of the window.
      const half = cutoff + windowMs / 2;
      const firstHalf = slice.filter((e) => new Date(e.firstSeenAt).getTime() < half);
      const secondHalf = slice.filter((e) => new Date(e.firstSeenAt).getTime() >= half);
      const scoreOf = (xs: IncidentTimelineEntry[]) =>
        xs.reduce((s, e) => s + SEVERITY_RANK[e.severity], 0);
      const first = scoreOf(firstHalf);
      const second = scoreOf(secondHalf);
      let severityTrend: IncidentTrendSnapshot['severityTrend'] = 'steady';
      if (second > first * 1.25) severityTrend = 'worsening';
      else if (second < first * 0.75) severityTrend = 'improving';

      const averageMttrMs =
        mttrSamples.length === 0
          ? null
          : Math.round(mttrSamples.reduce((s, x) => s + x, 0) / mttrSamples.length);
      const p95MttrMs = percentile(mttrSamples, 0.95);

      return {
        windowMs,
        totalEntries: slice.length,
        openEntries: open,
        unacknowledged: unacked,
        bySeverity,
        byType,
        recurrenceRate: slice.length === 0 ? 0 : recurring / slice.length,
        averageMttrMs,
        p95MttrMs,
        severityTrend,
      };
    },

    serialize() {
      return entries.map((e) => ({ ...e, detail: { ...e.detail } }));
    },

    hydrate(restored) {
      entries = restored.slice(-maxEntries).map((e) => ({ ...e, detail: { ...e.detail } }));
      indexByFingerprint.clear();
      for (const e of entries) indexByFingerprint.set(e.fingerprint, e);
    },

    size() {
      return entries.length;
    },
  };
}
