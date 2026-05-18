/**
 * Phase D — User interest graph.
 *
 * Pure compute that turns a stream of normalized signals (see
 * `personalization/signals/index.ts`) into a weighted user vector.
 *
 * The graph captures five things the ranker needs:
 *
 *   1. category affinity      — Map<categoryId, score>
 *   2. source affinity        — Map<sourceId, score>
 *   3. topic affinity         — Map<topic, score>          (opaque key)
 *   4. engagement depth       — average dwell across reads (seconds)
 *   5. reading consistency    — distinct active days / observation window
 *
 * Everything is bounded, normalized, and trivially diffable so the
 * upstream feedback loop can detect "strong affinity shift" — the
 * trigger for selective personalized-feed refresh.
 *
 * The module is database-agnostic. The worker fetches rows via RPC and
 * feeds them in; the database is the system of record (rows live in
 * user_category_affinity / user_source_affinity from migration 042).
 */

import type { NormalizedSignal, RawSignal, SignalScoringOptions } from './signals';
import { aggregateSignals, normalizeSignals } from './signals';

export interface InterestVector {
  userId: string;
  categoryAffinity: Map<string, number>;
  sourceAffinity: Map<string, number>;
  topicAffinity: Map<string, number>;
  /** Average accepted-signal dwell in seconds (0 when no dwell observed). */
  engagementDepthSec: number;
  /** Distinct active days / `consistencyWindowDays`, in [0, 1]. */
  readingConsistency: number;
  /** Total accepted signals contributing to the vector. */
  signalCount: number;
  /** Most recent contributing signal (null when no signals contributed). */
  lastInteractionAt: Date | null;
  /** Generation timestamp. */
  computedAt: Date;
}

export interface InterestGraphOptions extends SignalScoringOptions {
  /** Window for "active days" / "consistency" denominator. Default 14. */
  consistencyWindowDays?: number;
  /**
   * Optional topic key extractor — opaque to the graph. The worker hands
   * in a function that maps an article to its topic ids (e.g. NER topics).
   * Defaults to "no topics" so the module is usable without a topic store.
   */
  topicKeyFor?: (signal: NormalizedSignal) => string[];
  /**
   * Normalize affinity values into [0, 1] so the ranker's
   * `affinity_weight` term is comparable across users. Default true.
   */
  normalize?: boolean;
}

function normMap(m: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  if (max <= 0) return new Map(m);
  const out = new Map<string, number>();
  for (const [k, v] of m.entries()) out.set(k, Math.max(0, v) / max);
  return out;
}

/**
 * Build a user vector from an arbitrary set of raw signals. Convenient
 * top-level entry point used by both the worker and tests.
 */
export function buildInterestVector(
  userId: string,
  raws: ReadonlyArray<RawSignal>,
  opts: InterestGraphOptions = {},
): InterestVector {
  const { signals } = normalizeSignals(raws, opts);
  return buildInterestVectorFromNormalized(userId, signals, opts);
}

/**
 * Same as `buildInterestVector` but skips the noise-reduction layer when
 * the worker has already normalized signals upstream (avoids double-work
 * during incremental recomputes).
 */
export function buildInterestVectorFromNormalized(
  userId: string,
  signals: ReadonlyArray<NormalizedSignal>,
  opts: InterestGraphOptions = {},
): InterestVector {
  const consistencyWindow = opts.consistencyWindowDays ?? 14;
  const now = (opts.now ?? (() => new Date()))();
  const normalize = opts.normalize !== false;
  const topicFor = opts.topicKeyFor;

  const buckets = aggregateSignals(signals, opts);
  const topic = new Map<string, number>();

  let dwellSum = 0;
  let dwellN = 0;
  const activeDays = new Set<string>();
  const consistencyCutoff = now.getTime() - consistencyWindow * 86_400_000;

  for (const s of signals) {
    if (s.rejected) continue;
    if (s.rawWeight === 0) continue;
    if (s.dwellMs > 0) {
      dwellSum += s.dwellMs;
      dwellN += 1;
    }
    if (s.happenedAt.getTime() >= consistencyCutoff) {
      const isoDay = s.happenedAt.toISOString().slice(0, 10);
      activeDays.add(isoDay);
    }
    if (topicFor) {
      const topics = topicFor(s);
      for (const t of topics) {
        topic.set(t, (topic.get(t) ?? 0) + s.rawWeight);
      }
    }
  }

  const engagementDepthSec = dwellN > 0 ? dwellSum / dwellN / 1000 : 0;
  const readingConsistency =
    Math.min(activeDays.size, consistencyWindow) /
    Math.max(consistencyWindow, 1);

  return {
    userId,
    categoryAffinity: normalize ? normMap(buckets.byCategory) : new Map(buckets.byCategory),
    sourceAffinity: normalize ? normMap(buckets.bySource) : new Map(buckets.bySource),
    topicAffinity: normalize ? normMap(topic) : topic,
    engagementDepthSec,
    readingConsistency,
    signalCount: buckets.contributingCount,
    lastInteractionAt: buckets.lastInteractionAt,
    computedAt: now,
  };
}

/**
 * Map-distance helper: returns sum(|a - b|) over the union of keys.
 * Used by the feedback loop to decide whether an affinity shift is
 * "strong" enough to invalidate the personalized feed slice. We use L1
 * (Manhattan) on the [0,1]-normalized vectors because it is cheap and
 * directly interpretable as "total absolute movement in interest".
 */
export function affinityDistance(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  let dist = 0;
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    dist += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  }
  return dist;
}

/**
 * Diff two interest vectors. Returns a structured report the feedback
 * loop uses to enqueue a `refresh_personalized_feed` job when distance
 * exceeds the configured threshold.
 */
export interface InterestShift {
  categoryDistance: number;
  sourceDistance: number;
  topicDistance: number;
  isStrong: boolean;
}

export function diffInterestVectors(
  previous: InterestVector | null,
  next: InterestVector,
  strongThreshold = 0.35,
): InterestShift {
  if (!previous) {
    // First-ever vector counts as a strong shift so the slice is built.
    return {
      categoryDistance: Number.POSITIVE_INFINITY,
      sourceDistance: Number.POSITIVE_INFINITY,
      topicDistance: Number.POSITIVE_INFINITY,
      isStrong: true,
    };
  }
  const cd = affinityDistance(previous.categoryAffinity, next.categoryAffinity);
  const sd = affinityDistance(previous.sourceAffinity, next.sourceAffinity);
  const td = affinityDistance(previous.topicAffinity, next.topicAffinity);
  return {
    categoryDistance: cd,
    sourceDistance: sd,
    topicDistance: td,
    isStrong: cd >= strongThreshold || sd >= strongThreshold || td >= strongThreshold,
  };
}
