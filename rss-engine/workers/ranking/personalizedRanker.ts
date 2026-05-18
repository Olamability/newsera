/**
 * Phase D — Personalized ranker.
 *
 * Pure ranking function. Takes:
 *   - a global ranked feed (snapshot of articles + global score)
 *   - a user affinity vector (from interestGraph)
 *   - context (already-read article ids, negative signals, source
 *     reliability map, fatigue history)
 *
 * Produces the final per-user feed slice in deterministic order,
 * applying:
 *
 *     final_score =
 *         (global_score * affinity_weight)
 *       + freshness_bonus
 *       + engagement_bonus
 *       - repetition_penalty
 *       - fatigue_penalty
 *
 * with three structural overlays:
 *
 *   (a) Suppression — already-read, hidden, blocked-source, muted
 *       category, and disliked-article ids never appear.
 *   (b) Diversity   — no more than `maxConsecutiveSameSource` /
 *       `maxConsecutiveSameCategory` consecutive items; subsequent
 *       violators are deferred until the streak breaks.
 *   (c) Exploration — inject `explorationRatio` of items from
 *       categories/sources the user has NEVER interacted with so the
 *       feed adapts beyond the user's current bubble.
 *
 * The module is database-free; it returns plain rows the worker writes
 * to `ranked_feed_personalized_v2` via the migration 048 RPC.
 */

import type { InterestVector } from '../personalization/interestGraph';

export interface RankableArticle {
  articleId: string;
  sourceId: string | null;
  categoryId: string | null;
  globalScore: number;
  publishedAt: Date | string | number;
}

export interface NegativeSignalSet {
  hiddenArticleIds: ReadonlySet<string>;
  blockedSourceIds: ReadonlySet<string>;
  mutedCategoryIds: ReadonlySet<string>;
  dislikedArticleIds: ReadonlySet<string>;
  /** Article ids the user scrolled past quickly — soft suppression, not a hard hide. */
  fastScrollArticleIds: ReadonlySet<string>;
}

export interface PersonalizedRankerOptions {
  /** Hard slice size returned to the caller. Default 50. */
  limit?: number;
  /** Decay half-life (hours) for `freshness_bonus`. Default 12h. */
  freshnessHalfLifeHours?: number;
  /** Maximum same-source items in a row before deferral. Default 3. */
  maxConsecutiveSameSource?: number;
  /** Maximum same-category items in a row before deferral. Default 3. */
  maxConsecutiveSameCategory?: number;
  /** Fraction (0..1) of returned items injected from unseen sources/categories. Default 0.10. */
  explorationRatio?: number;
  /** Penalty per repeated source already in slice. Default 0.20. */
  repetitionPenaltyPerHit?: number;
  /** Source reliability lookup; missing entries default to 0.8. */
  sourceReliability?: ReadonlyMap<string, number>;
  /**
   * Per-article engagement bonus lookup (e.g. high-velocity click rate).
   * Bounded contribution; missing entries default to 0.
   */
  engagementBonus?: ReadonlyMap<string, number>;
  /**
   * Per-source "fatigue" — how many articles from this source the user
   * has read in the recent window. Adds a `fatigue_penalty` scaling
   * with the count. Missing entries default to 0.
   */
  sourceFatigue?: ReadonlyMap<string, number>;
  /** Now-clock injection for deterministic tests. */
  now?: () => Date;
  /**
   * Deterministic RNG hook (returns numbers in [0,1)). Used to pick
   * exploration injections without making the test suite flaky.
   */
  random?: () => number;
}

export interface RankedSlot {
  rankPosition: number;
  articleId: string;
  sourceId: string | null;
  categoryId: string | null;
  personalizedScore: number;
  globalScore: number;
  affinityWeight: number;
  freshnessBonus: number;
  engagementBonus: number;
  repetitionPenalty: number;
  fatiguePenalty: number;
  isExploration: boolean;
}

export interface RankResult {
  slots: RankedSlot[];
  /** Articles suppressed by the negative-signal layer (debug/observability). */
  suppressedCount: number;
  /** Items rotated by diversity enforcement. */
  diversityRotations: number;
  /** Fraction of the returned slice marked exploration. */
  explorationRatio: number;
  /** Distinct sources / categories in the final slice. */
  distinctSources: number;
  distinctCategories: number;
}

export const EMPTY_NEGATIVE: NegativeSignalSet = {
  hiddenArticleIds: new Set(),
  blockedSourceIds: new Set(),
  mutedCategoryIds: new Set(),
  dislikedArticleIds: new Set(),
  fastScrollArticleIds: new Set(),
};

function toDate(v: Date | string | number): Date {
  return v instanceof Date ? v : new Date(v);
}

function freshnessBonus(
  publishedAt: Date,
  now: Date,
  halfLifeHours: number,
): number {
  const ageMs = Math.max(now.getTime() - publishedAt.getTime(), 0);
  const ageHours = ageMs / 3_600_000;
  // Base value 0.5 so the bonus stays a *bonus* (added on top of
  // affinity-multiplied global), capping at 0.5 for brand-new content.
  return 0.5 * Math.exp(-(Math.LN2 / Math.max(halfLifeHours, 0.1)) * ageHours);
}

function affinityWeight(
  article: RankableArticle,
  vec: InterestVector,
): number {
  const cat = article.categoryId
    ? vec.categoryAffinity.get(article.categoryId) ?? 0
    : 0;
  const src = article.sourceId
    ? vec.sourceAffinity.get(article.sourceId) ?? 0
    : 0;
  // 1.0 baseline (cold start safe) + up to +1 from category + +1 from source.
  // Clamped to keep the multiplier interpretable for observability.
  return Math.min(5, 1.0 + cat + src);
}

/**
 * Rank the candidate set for a single user. See module header for the
 * formula and the three overlays.
 */
export function rankForUser(
  user: InterestVector,
  candidates: ReadonlyArray<RankableArticle>,
  negatives: NegativeSignalSet = EMPTY_NEGATIVE,
  alreadyReadArticleIds: ReadonlySet<string> = new Set(),
  opts: PersonalizedRankerOptions = {},
): RankResult {
  const limit = Math.max(1, opts.limit ?? 50);
  const halfLife = opts.freshnessHalfLifeHours ?? 12;
  const maxSrc = Math.max(1, opts.maxConsecutiveSameSource ?? 3);
  const maxCat = Math.max(1, opts.maxConsecutiveSameCategory ?? 3);
  const explorationRatio = Math.min(0.5, Math.max(0, opts.explorationRatio ?? 0.1));
  const repetitionPenaltyPerHit = Math.max(0, opts.repetitionPenaltyPerHit ?? 0.2);
  const reliability = opts.sourceReliability ?? new Map<string, number>();
  const engagementBonusMap = opts.engagementBonus ?? new Map<string, number>();
  const fatigueMap = opts.sourceFatigue ?? new Map<string, number>();
  const now = (opts.now ?? (() => new Date()))();
  const rand = opts.random ?? Math.random;

  // ---- 1) Suppression layer ------------------------------------------------
  let suppressedCount = 0;
  const surviving: Array<{
    article: RankableArticle;
    affW: number;
    fresh: number;
    engB: number;
    fatigue: number;
    baseScore: number;
    isFastScroll: boolean;
  }> = [];

  for (const a of candidates) {
    if (alreadyReadArticleIds.has(a.articleId)) {
      suppressedCount += 1;
      continue;
    }
    if (negatives.hiddenArticleIds.has(a.articleId)) {
      suppressedCount += 1;
      continue;
    }
    if (negatives.dislikedArticleIds.has(a.articleId)) {
      suppressedCount += 1;
      continue;
    }
    if (a.sourceId && negatives.blockedSourceIds.has(a.sourceId)) {
      suppressedCount += 1;
      continue;
    }
    if (a.categoryId && negatives.mutedCategoryIds.has(a.categoryId)) {
      suppressedCount += 1;
      continue;
    }
    const affW = affinityWeight(a, user);
    const fresh = freshnessBonus(toDate(a.publishedAt), now, halfLife);
    const engB = engagementBonusMap.get(a.articleId) ?? 0;
    const fatigue = a.sourceId ? fatigueMap.get(a.sourceId) ?? 0 : 0;
    const rel = a.sourceId ? reliability.get(a.sourceId) ?? 0.8 : 0.8;
    const isFastScroll = negatives.fastScrollArticleIds.has(a.articleId);
    // fast-scroll is soft: cuts the affinity weight in half but does not
    // remove the article. The user might still want it later.
    const effAffW = isFastScroll ? affW * 0.5 : affW;
    const baseScore =
      a.globalScore * effAffW * (0.5 + 0.5 * rel) + fresh + engB;
    surviving.push({
      article: a,
      affW: effAffW,
      fresh,
      engB,
      fatigue,
      baseScore,
      isFastScroll,
    });
  }

  // ---- 2) Sort by base score (descending) ----------------------------------
  surviving.sort((x, y) => y.baseScore - x.baseScore);

  // ---- 3) Exploration pool -------------------------------------------------
  // Items from a source/category the user has *never* interacted with.
  // We score these via the same baseScore but mark them so the picker
  // alternates them in at `explorationRatio` cadence.
  const explorationPool: typeof surviving = [];
  const mainPool: typeof surviving = [];
  for (const s of surviving) {
    const knownCat = s.article.categoryId
      ? user.categoryAffinity.has(s.article.categoryId)
      : true;
    const knownSrc = s.article.sourceId
      ? user.sourceAffinity.has(s.article.sourceId)
      : true;
    if (!knownCat && !knownSrc) explorationPool.push(s);
    else mainPool.push(s);
  }

  // ---- 4) Diversity-aware picker ------------------------------------------
  let diversityRotations = 0;
  const out: RankedSlot[] = [];
  const sourceCounts = new Map<string, number>();
  let consecutiveSource: string | null = null;
  let consecutiveSourceCount = 0;
  let consecutiveCategory: string | null = null;
  let consecutiveCategoryCount = 0;
  const explorationTargets = Math.floor(limit * explorationRatio);
  let explorationPlaced = 0;
  const mainCursor = { i: 0 };
  const deferred: typeof surviving = [];

  function canPlace(item: (typeof surviving)[number]): boolean {
    const src = item.article.sourceId ?? '__nosrc__';
    const cat = item.article.categoryId ?? '__nocat__';
    if (src === consecutiveSource && consecutiveSourceCount >= maxSrc) return false;
    if (cat === consecutiveCategory && consecutiveCategoryCount >= maxCat) return false;
    return true;
  }

  function placeItem(item: (typeof surviving)[number], isExploration: boolean): void {
    const src = item.article.sourceId ?? '__nosrc__';
    const cat = item.article.categoryId ?? '__nocat__';
    if (src === consecutiveSource) consecutiveSourceCount += 1;
    else {
      consecutiveSource = src;
      consecutiveSourceCount = 1;
    }
    if (cat === consecutiveCategory) consecutiveCategoryCount += 1;
    else {
      consecutiveCategory = cat;
      consecutiveCategoryCount = 1;
    }
    const repCount = sourceCounts.get(src) ?? 0;
    sourceCounts.set(src, repCount + 1);
    const repetitionPenalty = repCount * repetitionPenaltyPerHit;
    const fatiguePenalty = item.fatigue * 0.05;
    const personalizedScore =
      item.baseScore - repetitionPenalty - fatiguePenalty;
    out.push({
      rankPosition: out.length + 1,
      articleId: item.article.articleId,
      sourceId: item.article.sourceId,
      categoryId: item.article.categoryId,
      personalizedScore: round4(personalizedScore),
      globalScore: round4(item.article.globalScore),
      affinityWeight: round4(item.affW),
      freshnessBonus: round4(item.fresh),
      engagementBonus: round4(item.engB),
      repetitionPenalty: round4(repetitionPenalty),
      fatiguePenalty: round4(fatiguePenalty),
      isExploration,
    });
  }

  function takeFromMain(): (typeof surviving)[number] | null {
    while (mainCursor.i < mainPool.length) {
      const item = mainPool[mainCursor.i];
      mainCursor.i += 1;
      if (canPlace(item)) return item;
      // Defer when diversity rule blocks it; we'll try later.
      deferred.push(item);
      diversityRotations += 1;
    }
    // Drain deferred queue if main pool exhausted.
    while (deferred.length > 0) {
      const item = deferred.shift()!;
      if (canPlace(item)) return item;
      // re-defer to end — eventually streak breaks.
      deferred.push(item);
      diversityRotations += 1;
      if (deferred.length > 50 && deferred.every((d) => !canPlace(d))) {
        // No item ever satisfies → emit the head anyway (graceful escape).
        return deferred.shift()!;
      }
    }
    return null;
  }

  function takeFromExploration(): (typeof surviving)[number] | null {
    // Probabilistic pick weighted by score — deterministic when `random` is.
    while (explorationPool.length > 0) {
      // pick highest-score that satisfies diversity; fall back to head.
      const idx = explorationPool.findIndex((x) => canPlace(x));
      if (idx >= 0) {
        const [picked] = explorationPool.splice(idx, 1);
        return picked;
      }
      const head = explorationPool.shift();
      if (head) return head;
    }
    return null;
  }

  const explorationIds = new Set(explorationPool.map((s) => s.article.articleId));

  while (out.length < limit) {
    // Decide exploration vs main using a deterministic cadence so the
    // injection rate converges on `explorationRatio`.
    const needExploration =
      explorationPool.length > 0 &&
      explorationPlaced < explorationTargets &&
      // pure ratio gate + jitter from `rand` so order isn't predictable
      rand() < explorationRatio + 0.02;
    let item: (typeof surviving)[number] | null = null;
    let chosenIsExploration = false;
    if (needExploration) {
      item = takeFromExploration();
      if (item) {
        explorationPlaced += 1;
        chosenIsExploration = true;
      }
    }
    if (!item) item = takeFromMain();
    if (!item) {
      item = takeFromExploration();
      if (item) chosenIsExploration = true;
    }
    if (!item) break;
    // Final flag — an item drawn from the exploration pool is always
    // exploration, irrespective of which `take*` path produced it.
    placeItem(item, chosenIsExploration || explorationIds.has(item.article.articleId));
  }

  const distinctSources = new Set(
    out.map((s) => s.sourceId ?? '__nosrc__'),
  ).size;
  const distinctCategories = new Set(
    out.map((s) => s.categoryId ?? '__nocat__'),
  ).size;
  const explorationCount = out.filter((s) => s.isExploration).length;

  return {
    slots: out,
    suppressedCount,
    diversityRotations,
    explorationRatio: out.length > 0 ? explorationCount / out.length : 0,
    distinctSources,
    distinctCategories,
  };
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10_000) / 10_000;
}
