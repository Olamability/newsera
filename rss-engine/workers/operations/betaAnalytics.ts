/**
 * Phase G — Beta cohort analytics.
 *
 * Closes the Phase F debt: `betaTrafficController` admits or denies users
 * but does not measure cohort behaviour. This module is the
 * post-admission lens: cohort retention, feature adoption, crash
 * correlation, rollout-satisfaction signals, and cohort-level incident
 * impact.
 *
 * Pure compute. The host feeds in raw activity events; the module
 * aggregates and exposes derived snapshots.
 */

export interface CohortActivityEvent {
  cohort: string;
  userId: string;
  /** ISO timestamp of the activity sample. */
  occurredAt: string;
  /** True if the user opened the app in this sample window. */
  active: boolean;
  /** Feature keys touched in this sample (empty = none). */
  featuresUsed: string[];
  /** True if the user reported a crash during the window. */
  crashed: boolean;
  /** Optional 1..5 satisfaction signal (rating, thumbs, NPS bucket). */
  satisfaction?: number;
}

export interface CohortRetentionSnapshot {
  cohort: string;
  cohortSize: number;
  day1Retention: number;
  day7Retention: number;
  day30Retention: number;
}

export interface CohortAdoptionSnapshot {
  cohort: string;
  featureKey: string;
  adopters: number;
  adoptionRate: number;
}

export interface CohortCrashCorrelation {
  cohort: string;
  crashRate: number;
  flaggedAsHotspot: boolean;
}

export interface CohortSatisfactionSnapshot {
  cohort: string;
  sampleSize: number;
  averageScore: number | null;
  promoterRate: number; // % >=4
  detractorRate: number; // % <=2
}

export interface CohortIncidentImpact {
  cohort: string;
  impactedUsers: number;
  share: number;
}

export interface BetaAnalyticsConfig {
  /** Crash rate above which a cohort is flagged. Default 0.05 (5%). */
  crashHotspotThreshold?: number;
  now?: () => Date;
  maxEventsPerCohort?: number;
}

export interface BetaAnalytics {
  ingest(event: CohortActivityEvent): void;
  ingestBatch(events: CohortActivityEvent[]): void;
  retention(cohort: string): CohortRetentionSnapshot | null;
  adoption(cohort: string, featureKey: string): CohortAdoptionSnapshot | null;
  crashCorrelation(cohort: string): CohortCrashCorrelation | null;
  satisfaction(cohort: string): CohortSatisfactionSnapshot | null;
  incidentImpact(cohort: string, impactedUserIds: string[]): CohortIncidentImpact | null;
  cohorts(): string[];
  reset(cohort?: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBetaAnalytics(config: BetaAnalyticsConfig = {}): BetaAnalytics {
  const crashHotspotThreshold = config.crashHotspotThreshold ?? 0.05;
  const maxEvents = Math.max(100, config.maxEventsPerCohort ?? 10_000);
  const now = config.now ?? (() => new Date());

  const events = new Map<string, CohortActivityEvent[]>();

  function push(event: CohortActivityEvent): void {
    const bucket = events.get(event.cohort) ?? [];
    bucket.push(event);
    if (bucket.length > maxEvents) bucket.shift();
    events.set(event.cohort, bucket);
  }

  function userIdsIn(cohort: string): Set<string> {
    const bucket = events.get(cohort);
    if (!bucket) return new Set();
    return new Set(bucket.map((e) => e.userId));
  }

  function firstSeenMap(cohort: string): Map<string, Date> {
    const bucket = events.get(cohort) ?? [];
    const map = new Map<string, Date>();
    for (const e of bucket) {
      const ts = new Date(e.occurredAt);
      const existing = map.get(e.userId);
      if (!existing || ts.getTime() < existing.getTime()) {
        map.set(e.userId, ts);
      }
    }
    return map;
  }

  function retentionAt(cohort: string, dayOffset: number): number {
    const bucket = events.get(cohort);
    if (!bucket || bucket.length === 0) return 0;
    const firstSeen = firstSeenMap(cohort);
    let eligible = 0;
    let retained = 0;
    for (const [userId, firstDate] of firstSeen) {
      const cutoff = new Date(firstDate.getTime() + dayOffset * 86_400_000);
      const nowTs = now();
      if (nowTs.getTime() < cutoff.getTime()) continue;
      eligible += 1;
      const hasReturn = bucket.some(
        (e) =>
          e.userId === userId &&
          e.active &&
          daysBetween(firstDate, new Date(e.occurredAt)) >= dayOffset,
      );
      if (hasReturn) retained += 1;
    }
    return eligible === 0 ? 0 : retained / eligible;
  }

  return {
    ingest(event) {
      push({ ...event, featuresUsed: [...event.featuresUsed] });
    },

    ingestBatch(batch) {
      for (const e of batch) push({ ...e, featuresUsed: [...e.featuresUsed] });
    },

    retention(cohort) {
      const bucket = events.get(cohort);
      if (!bucket || bucket.length === 0) return null;
      const cohortSize = userIdsIn(cohort).size;
      return {
        cohort,
        cohortSize,
        day1Retention: retentionAt(cohort, 1),
        day7Retention: retentionAt(cohort, 7),
        day30Retention: retentionAt(cohort, 30),
      };
    },

    adoption(cohort, featureKey) {
      const bucket = events.get(cohort);
      if (!bucket || bucket.length === 0) return null;
      const cohortSize = userIdsIn(cohort).size;
      const adopters = new Set(
        bucket.filter((e) => e.featuresUsed.includes(featureKey)).map((e) => e.userId),
      ).size;
      return {
        cohort,
        featureKey,
        adopters,
        adoptionRate: cohortSize === 0 ? 0 : adopters / cohortSize,
      };
    },

    crashCorrelation(cohort) {
      const bucket = events.get(cohort);
      if (!bucket || bucket.length === 0) return null;
      const crashed = new Set(bucket.filter((e) => e.crashed).map((e) => e.userId)).size;
      const total = userIdsIn(cohort).size;
      const rate = total === 0 ? 0 : crashed / total;
      return {
        cohort,
        crashRate: rate,
        flaggedAsHotspot: rate >= crashHotspotThreshold,
      };
    },

    satisfaction(cohort) {
      const bucket = events.get(cohort);
      if (!bucket || bucket.length === 0) return null;
      const scored = bucket.filter((e) => typeof e.satisfaction === 'number');
      if (scored.length === 0) {
        return { cohort, sampleSize: 0, averageScore: null, promoterRate: 0, detractorRate: 0 };
      }
      const promoters = scored.filter((e) => (e.satisfaction ?? 0) >= 4).length;
      const detractors = scored.filter((e) => (e.satisfaction ?? 0) <= 2).length;
      const avg = scored.reduce((s, e) => s + (e.satisfaction ?? 0), 0) / scored.length;
      return {
        cohort,
        sampleSize: scored.length,
        averageScore: avg,
        promoterRate: promoters / scored.length,
        detractorRate: detractors / scored.length,
      };
    },

    incidentImpact(cohort, impactedUserIds) {
      const bucket = events.get(cohort);
      if (!bucket || bucket.length === 0) return null;
      const impacted = new Set(impactedUserIds);
      const cohortUsers = userIdsIn(cohort);
      const overlap = [...cohortUsers].filter((u) => impacted.has(u)).length;
      return {
        cohort,
        impactedUsers: overlap,
        share: cohortUsers.size === 0 ? 0 : overlap / cohortUsers.size,
      };
    },

    cohorts() {
      return [...events.keys()];
    },

    reset(cohort) {
      if (cohort) events.delete(cohort);
      else events.clear();
    },
  };
}
