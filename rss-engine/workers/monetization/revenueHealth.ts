/**
 * Phase G — Revenue health snapshots.
 *
 * Tracks RPM (revenue per mille), fill rate, eCPM trend, and source-level
 * monetization analytics. Aggregates raw impression/revenue events into
 * rolling windows and detects engagement-vs-revenue anomalies.
 *
 * Pure compute.
 */

export interface RevenueEvent {
  source: string;
  articleId?: string;
  /** Impressions delivered. */
  impressions: number;
  /** Filled impressions (impressions that returned an ad). */
  filledImpressions: number;
  /** Revenue in micros (1e-6 of the smallest currency unit). */
  revenueMicros: number;
  /** Engagement count attributed to the article (CTR, dwell). */
  engagementScore?: number;
  occurredAt: string;
}

export interface RevenueWindowSnapshot {
  windowMs: number;
  totalImpressions: number;
  totalFilled: number;
  totalRevenueMicros: number;
  fillRate: number;
  rpm: number;
  eCpmMicros: number;
}

export interface SourceMonetization {
  source: string;
  impressions: number;
  filled: number;
  revenueMicros: number;
  fillRate: number;
  rpm: number;
  averageEngagement: number | null;
}

export interface EngagementRevenueAnomaly {
  source: string;
  engagementBaseline: number;
  engagementObserved: number;
  rpmBaseline: number;
  rpmObserved: number;
  /** Negative means revenue diverged downwards relative to engagement. */
  divergence: number;
  severity: 'info' | 'warn' | 'severe';
}

export interface RevenueHealthConfig {
  windowMs?: number;
  maxEvents?: number;
  now?: () => Date;
}

export interface RevenueHealth {
  ingest(event: RevenueEvent): void;
  ingestBatch(events: RevenueEvent[]): void;
  windowSnapshot(windowMs?: number): RevenueWindowSnapshot;
  /** Per-source breakdown over the window. */
  sourceBreakdown(windowMs?: number): SourceMonetization[];
  /** RPM samples over the window for trend rendering. */
  rpmTrend(buckets: number, windowMs?: number): Array<{ tsMs: number; rpm: number }>;
  anomalies(windowMs?: number): EngagementRevenueAnomaly[];
  reset(): void;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function createRevenueHealth(config: RevenueHealthConfig = {}): RevenueHealth {
  const defaultWindowMs = Math.max(60_000, config.windowMs ?? 60 * 60_000);
  const maxEvents = Math.max(256, config.maxEvents ?? 100_000);
  const now = config.now ?? (() => new Date());
  const events: RevenueEvent[] = [];

  function within(window: number): RevenueEvent[] {
    const cutoff = now().getTime() - window;
    return events.filter((e) => new Date(e.occurredAt).getTime() >= cutoff);
  }

  function aggregate(slice: RevenueEvent[]): {
    impressions: number;
    filled: number;
    revenueMicros: number;
    engagement: number[];
  } {
    let impressions = 0;
    let filled = 0;
    let revenueMicros = 0;
    const engagement: number[] = [];
    for (const e of slice) {
      impressions += e.impressions;
      filled += e.filledImpressions;
      revenueMicros += e.revenueMicros;
      if (typeof e.engagementScore === 'number') engagement.push(e.engagementScore);
    }
    return { impressions, filled, revenueMicros, engagement };
  }

  return {
    ingest(event) {
      events.push({ ...event });
      if (events.length > maxEvents) events.shift();
    },

    ingestBatch(batch) {
      for (const e of batch) {
        events.push({ ...e });
        if (events.length > maxEvents) events.shift();
      }
    },

    windowSnapshot(windowMs = defaultWindowMs) {
      const slice = within(windowMs);
      const { impressions, filled, revenueMicros } = aggregate(slice);
      const rpm = impressions === 0 ? 0 : (revenueMicros / impressions) * 1_000;
      const eCpm = filled === 0 ? 0 : (revenueMicros / filled) * 1_000;
      return {
        windowMs,
        totalImpressions: impressions,
        totalFilled: filled,
        totalRevenueMicros: revenueMicros,
        fillRate: safeDiv(filled, impressions),
        rpm,
        eCpmMicros: eCpm,
      };
    },

    sourceBreakdown(windowMs = defaultWindowMs) {
      const slice = within(windowMs);
      const bySource = new Map<string, RevenueEvent[]>();
      for (const e of slice) {
        const bucket = bySource.get(e.source) ?? [];
        bucket.push(e);
        bySource.set(e.source, bucket);
      }
      const out: SourceMonetization[] = [];
      for (const [source, list] of bySource) {
        const agg = aggregate(list);
        out.push({
          source,
          impressions: agg.impressions,
          filled: agg.filled,
          revenueMicros: agg.revenueMicros,
          fillRate: safeDiv(agg.filled, agg.impressions),
          rpm: agg.impressions === 0 ? 0 : (agg.revenueMicros / agg.impressions) * 1_000,
          averageEngagement:
            agg.engagement.length === 0
              ? null
              : agg.engagement.reduce((s, v) => s + v, 0) / agg.engagement.length,
        });
      }
      return out.sort((a, b) => b.revenueMicros - a.revenueMicros);
    },

    rpmTrend(buckets, windowMs = defaultWindowMs) {
      const slice = within(windowMs);
      if (slice.length === 0 || buckets <= 0) return [];
      const nowMs = now().getTime();
      const start = nowMs - windowMs;
      const bucketSize = windowMs / buckets;
      const out: Array<{ tsMs: number; rpm: number }> = [];
      for (let i = 0; i < buckets; i += 1) {
        const lo = start + i * bucketSize;
        const hi = lo + bucketSize;
        const inBucket = slice.filter((e) => {
          const t = new Date(e.occurredAt).getTime();
          return t >= lo && t < hi;
        });
        const agg = aggregate(inBucket);
        out.push({
          tsMs: lo,
          rpm: agg.impressions === 0 ? 0 : (agg.revenueMicros / agg.impressions) * 1_000,
        });
      }
      return out;
    },

    anomalies(windowMs = defaultWindowMs) {
      const sources = this.sourceBreakdown(windowMs);
      // Baseline = previous window of equal size.
      const baselineSlice = events.filter((e) => {
        const t = new Date(e.occurredAt).getTime();
        const start = now().getTime() - 2 * windowMs;
        const end = now().getTime() - windowMs;
        return t >= start && t < end;
      });
      const baselineBySource = new Map<string, RevenueEvent[]>();
      for (const e of baselineSlice) {
        const bucket = baselineBySource.get(e.source) ?? [];
        bucket.push(e);
        baselineBySource.set(e.source, bucket);
      }
      const out: EngagementRevenueAnomaly[] = [];
      for (const s of sources) {
        const baselineList = baselineBySource.get(s.source) ?? [];
        const baseAgg = aggregate(baselineList);
        const baseRpm =
          baseAgg.impressions === 0 ? 0 : (baseAgg.revenueMicros / baseAgg.impressions) * 1_000;
        const baseEng =
          baseAgg.engagement.length === 0
            ? 0
            : baseAgg.engagement.reduce((s2, v) => s2 + v, 0) / baseAgg.engagement.length;
        if (baseRpm === 0 || baseEng === 0) continue;
        const engRatio = (s.averageEngagement ?? 0) / baseEng;
        const rpmRatio = s.rpm / baseRpm;
        // Divergence = engagement up but revenue down (or vice-versa).
        const divergence = rpmRatio - engRatio;
        if (Math.abs(divergence) < 0.2) continue;
        let severity: EngagementRevenueAnomaly['severity'] = 'info';
        if (Math.abs(divergence) >= 0.6) severity = 'severe';
        else if (Math.abs(divergence) >= 0.35) severity = 'warn';
        out.push({
          source: s.source,
          engagementBaseline: baseEng,
          engagementObserved: s.averageEngagement ?? 0,
          rpmBaseline: baseRpm,
          rpmObserved: s.rpm,
          divergence,
          severity,
        });
      }
      return out;
    },

    reset() {
      events.length = 0;
    },
  };
}
