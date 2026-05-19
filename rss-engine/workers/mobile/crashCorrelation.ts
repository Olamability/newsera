/**
 * Phase G — Mobile crash correlation.
 *
 * Correlates mobile crash reports with rollout stages and app versions to
 * isolate "did this rollout cause the crash spike?" Pure compute. Host
 * pushes crash reports + rollout window descriptors.
 */

export interface MobileCrashReport {
  appVersion: string;
  os: 'ios' | 'android';
  /** Stack-trace fingerprint — same crash → same fingerprint. */
  fingerprint: string;
  /** Optional rollout/flag the user was in at the time. */
  flagBucket?: string;
  occurredAt: string;
  userId?: string;
}

export interface RolloutWindow {
  flag: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface CrashSpike {
  fingerprint: string;
  count: number;
  baselineCount: number;
  spikeRatio: number;
  appVersions: string[];
  flagBuckets: string[];
  /** Rollout window suspected to have caused the spike. */
  suspectedRollout: string | null;
  severity: 'info' | 'warn' | 'severe';
}

export interface RolloutToCrashMapping {
  flag: string;
  crashCountDuring: number;
  crashCountBefore: number;
  delta: number;
  recommendsRollback: boolean;
}

export interface CrashCorrelationConfig {
  spikeRatioThreshold?: number; // default 3x
  baselineWindowMs?: number;
  observationWindowMs?: number;
  now?: () => Date;
  maxReports?: number;
}

export interface CrashCorrelation {
  ingest(report: MobileCrashReport): void;
  ingestBatch(reports: MobileCrashReport[]): void;
  registerRollout(window: RolloutWindow): void;
  spikes(): CrashSpike[];
  rolloutMappings(): RolloutToCrashMapping[];
  reset(): void;
}

export function createCrashCorrelation(config: CrashCorrelationConfig = {}): CrashCorrelation {
  const spikeRatioThreshold = config.spikeRatioThreshold ?? 3;
  const baselineWindowMs = config.baselineWindowMs ?? 24 * 3_600_000;
  const observationWindowMs = config.observationWindowMs ?? 60 * 60_000;
  const now = config.now ?? (() => new Date());
  const maxReports = Math.max(256, config.maxReports ?? 50_000);

  const reports: MobileCrashReport[] = [];
  const rollouts: RolloutWindow[] = [];

  function inWindow(report: MobileCrashReport, lo: number, hi: number): boolean {
    const t = new Date(report.occurredAt).getTime();
    return t >= lo && t < hi;
  }

  return {
    ingest(report) {
      reports.push({ ...report });
      while (reports.length > maxReports) reports.shift();
    },
    ingestBatch(batch) {
      for (const r of batch) reports.push({ ...r });
      while (reports.length > maxReports) reports.shift();
    },
    registerRollout(window) {
      rollouts.push({ ...window });
    },

    spikes() {
      const nowMs = now().getTime();
      const obsLo = nowMs - observationWindowMs;
      const baselineLo = nowMs - baselineWindowMs - observationWindowMs;
      const baselineHi = nowMs - observationWindowMs;

      const byFp = new Map<string, MobileCrashReport[]>();
      for (const r of reports) {
        const arr = byFp.get(r.fingerprint) ?? [];
        arr.push(r);
        byFp.set(r.fingerprint, arr);
      }

      const out: CrashSpike[] = [];
      for (const [fp, list] of byFp) {
        const inObs = list.filter((r) => inWindow(r, obsLo, nowMs));
        const inBaseline = list.filter((r) => inWindow(r, baselineLo, baselineHi));
        if (inObs.length === 0) continue;
        // Normalise baseline rate to the observation window length.
        const baselineNormalized = (inBaseline.length / baselineWindowMs) * observationWindowMs;
        const ratio = baselineNormalized === 0 ? inObs.length : inObs.length / baselineNormalized;
        if (ratio < spikeRatioThreshold) continue;
        const versions = [...new Set(inObs.map((r) => r.appVersion))];
        const buckets = [...new Set(inObs.map((r) => r.flagBucket).filter((b): b is string => !!b))];
        const suspectedRollout =
          rollouts.find(
            (w) =>
              buckets.includes(w.flag) &&
              new Date(w.startedAt).getTime() <= nowMs &&
              (!w.endedAt || new Date(w.endedAt).getTime() >= obsLo),
          )?.flag ?? null;
        let severity: CrashSpike['severity'] = 'info';
        if (ratio >= spikeRatioThreshold * 3) severity = 'severe';
        else if (ratio >= spikeRatioThreshold * 1.5) severity = 'warn';
        out.push({
          fingerprint: fp,
          count: inObs.length,
          baselineCount: inBaseline.length,
          spikeRatio: ratio,
          appVersions: versions,
          flagBuckets: buckets,
          suspectedRollout,
          severity,
        });
      }
      return out.sort((a, b) => b.spikeRatio - a.spikeRatio);
    },

    rolloutMappings() {
      const out: RolloutToCrashMapping[] = [];
      for (const w of rollouts) {
        const start = new Date(w.startedAt).getTime();
        const end = w.endedAt ? new Date(w.endedAt).getTime() : now().getTime();
        const duration = Math.max(1, end - start);
        const before = reports.filter((r) => {
          const t = new Date(r.occurredAt).getTime();
          return t >= start - duration && t < start;
        }).length;
        const during = reports.filter((r) => {
          const t = new Date(r.occurredAt).getTime();
          return t >= start && t < end && r.flagBucket === w.flag;
        }).length;
        const delta = during - before;
        const ratio = before === 0 ? during : during / Math.max(1, before);
        out.push({
          flag: w.flag,
          crashCountDuring: during,
          crashCountBefore: before,
          delta,
          recommendsRollback: ratio >= spikeRatioThreshold && during >= 5,
        });
      }
      return out;
    },

    reset() {
      reports.length = 0;
      rollouts.length = 0;
    },
  };
}
