/**
 * Phase F — Production feed quality auditor.
 *
 * Sits between the ranker and the feed renderer. Takes a prepared feed
 * (already personalised, exploration-mixed, freshness-filtered) and
 * computes a quality score plus warnings before it goes to the user.
 *
 * Checks:
 *
 *   - duplicate_articles           — same article appears multiple times
 *   - source_diversity             — Gini-like spread across sources
 *   - category_diversity           — spread across categories
 *   - stale_feed_percentage        — fraction of items older than `staleAgeMs`
 *   - low_engagement_saturation    — fraction of items below `engagementFloor`
 *   - recommendation_collapse      — top-K items share too many tokens
 *
 * Outputs a `feedQualityScore` in [0..1] and a list of degradation
 * warnings.
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O.
 *   - DETERMINISTIC. Same input → same output.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FeedItem {
  articleId: string;
  sourceId: string;
  categoryId: string;
  /** Publish time, ms-since-epoch. */
  publishedAtMs: number;
  /** Expected engagement score in [0..1] (engagement model output). */
  engagementScore?: number;
  /**
   * Tokenised title or summary. Used for collapse detection — the auditor
   * does not tokenise on its own to keep it deterministic & cheap.
   */
  topicTokens?: string[];
}

export interface FeedQualityThresholds {
  /** Item is "stale" past this age, ms. Default 24h. */
  staleAgeMs?: number;
  /** Engagement floor below which an item is "low-engagement". Default 0.2. */
  engagementFloor?: number;
  /** Source diversity floor (Simpson's 1-D ≥ this). Default 0.6. */
  minSourceDiversity?: number;
  /** Category diversity floor (Simpson's 1-D ≥ this). Default 0.5. */
  minCategoryDiversity?: number;
  /** Max stale fraction tolerated. Default 0.25. */
  maxStaleFraction?: number;
  /** Max low-engagement fraction tolerated. Default 0.4. */
  maxLowEngagementFraction?: number;
  /** Top-K window for collapse detection. Default 10. */
  collapseTopK?: number;
  /** Jaccard similarity above this in top-K is "collapse". Default 0.5. */
  collapseSimilarityThreshold?: number;
  /** Wall clock for staleness computation. */
  now?: number;
}

export const DEFAULT_FEED_QUALITY_THRESHOLDS: Required<Omit<FeedQualityThresholds, 'now'>> = {
  staleAgeMs: 24 * 3_600_000,
  engagementFloor: 0.2,
  minSourceDiversity: 0.6,
  minCategoryDiversity: 0.5,
  maxStaleFraction: 0.25,
  maxLowEngagementFraction: 0.4,
  collapseTopK: 10,
  collapseSimilarityThreshold: 0.5,
};

export interface FeedQualityWarning {
  code:
    | 'duplicate_articles'
    | 'source_diversity_low'
    | 'category_diversity_low'
    | 'stale_feed'
    | 'low_engagement_saturation'
    | 'recommendation_collapse';
  severity: 'info' | 'warning' | 'critical';
  detail: Record<string, unknown>;
}

export interface FeedQualityResult {
  totalItems: number;
  duplicateCount: number;
  sourceDiversity: number;
  categoryDiversity: number;
  staleFraction: number;
  lowEngagementFraction: number;
  topKCollapseSimilarity: number;
  feedQualityScore: number;
  warnings: FeedQualityWarning[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function simpsonsDiversity(values: Iterable<number>, total: number): number {
  if (total <= 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    const p = v / total;
    sumSq += p * p;
  }
  return 1 - sumSq;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function auditFeedQuality(
  items: ReadonlyArray<FeedItem>,
  opts: FeedQualityThresholds = {},
): FeedQualityResult {
  const cfg = {
    ...DEFAULT_FEED_QUALITY_THRESHOLDS,
    ...opts,
  };
  const now = opts.now ?? Date.now();

  const totalItems = items.length;
  const warnings: FeedQualityWarning[] = [];
  if (totalItems === 0) {
    return {
      totalItems: 0,
      duplicateCount: 0,
      sourceDiversity: 0,
      categoryDiversity: 0,
      staleFraction: 0,
      lowEngagementFraction: 0,
      topKCollapseSimilarity: 0,
      feedQualityScore: 0,
      warnings: [{ code: 'stale_feed', severity: 'critical', detail: { reason: 'empty_feed' } }],
    };
  }

  // Duplicates
  const seen = new Map<string, number>();
  for (const it of items) seen.set(it.articleId, (seen.get(it.articleId) ?? 0) + 1);
  let duplicateCount = 0;
  for (const count of seen.values()) {
    if (count > 1) duplicateCount += count - 1;
  }
  if (duplicateCount > 0) {
    warnings.push({
      code: 'duplicate_articles',
      severity: duplicateCount > totalItems * 0.1 ? 'critical' : 'warning',
      detail: { duplicate_count: duplicateCount },
    });
  }

  // Source diversity
  const sourceCounts = new Map<string, number>();
  for (const it of items) sourceCounts.set(it.sourceId, (sourceCounts.get(it.sourceId) ?? 0) + 1);
  const sourceDiversity = simpsonsDiversity(sourceCounts.values(), totalItems);
  if (sourceDiversity < cfg.minSourceDiversity) {
    warnings.push({
      code: 'source_diversity_low',
      severity: sourceDiversity < cfg.minSourceDiversity / 2 ? 'critical' : 'warning',
      detail: { observed: sourceDiversity, min: cfg.minSourceDiversity },
    });
  }

  // Category diversity
  const categoryCounts = new Map<string, number>();
  for (const it of items) categoryCounts.set(it.categoryId, (categoryCounts.get(it.categoryId) ?? 0) + 1);
  const categoryDiversity = simpsonsDiversity(categoryCounts.values(), totalItems);
  if (categoryDiversity < cfg.minCategoryDiversity) {
    warnings.push({
      code: 'category_diversity_low',
      severity: 'warning',
      detail: { observed: categoryDiversity, min: cfg.minCategoryDiversity },
    });
  }

  // Stale fraction
  let staleCount = 0;
  for (const it of items) {
    if (now - it.publishedAtMs > cfg.staleAgeMs) staleCount += 1;
  }
  const staleFraction = staleCount / totalItems;
  if (staleFraction > cfg.maxStaleFraction) {
    warnings.push({
      code: 'stale_feed',
      severity: staleFraction > cfg.maxStaleFraction * 2 ? 'critical' : 'warning',
      detail: { stale_fraction: staleFraction, max: cfg.maxStaleFraction },
    });
  }

  // Low engagement saturation
  let lowEngagementCount = 0;
  let scoredCount = 0;
  for (const it of items) {
    if (typeof it.engagementScore === 'number') {
      scoredCount += 1;
      if (it.engagementScore < cfg.engagementFloor) lowEngagementCount += 1;
    }
  }
  const lowEngagementFraction = scoredCount > 0 ? lowEngagementCount / scoredCount : 0;
  if (lowEngagementFraction > cfg.maxLowEngagementFraction) {
    warnings.push({
      code: 'low_engagement_saturation',
      severity: 'warning',
      detail: {
        low_engagement_fraction: lowEngagementFraction,
        max: cfg.maxLowEngagementFraction,
        scored_count: scoredCount,
      },
    });
  }

  // Top-K collapse similarity (avg pairwise Jaccard).
  const topK = items.slice(0, Math.min(cfg.collapseTopK, items.length));
  let pairCount = 0;
  let simSum = 0;
  for (let i = 0; i < topK.length; i += 1) {
    const a = new Set(topK[i].topicTokens ?? []);
    for (let j = i + 1; j < topK.length; j += 1) {
      const b = new Set(topK[j].topicTokens ?? []);
      simSum += jaccard(a, b);
      pairCount += 1;
    }
  }
  const collapseSim = pairCount > 0 ? simSum / pairCount : 0;
  if (collapseSim > cfg.collapseSimilarityThreshold) {
    warnings.push({
      code: 'recommendation_collapse',
      severity: collapseSim > 0.8 ? 'critical' : 'warning',
      detail: {
        avg_top_k_jaccard: collapseSim,
        threshold: cfg.collapseSimilarityThreshold,
        top_k: topK.length,
      },
    });
  }

  // Composite score: penalise per warning, weighted by severity.
  let score = 1;
  for (const w of warnings) {
    score -= w.severity === 'critical' ? 0.25 : w.severity === 'warning' ? 0.10 : 0.03;
  }
  // Add small bonuses for above-threshold diversity (cap at 1).
  if (sourceDiversity > 0.8) score += 0.05;
  if (categoryDiversity > 0.7) score += 0.03;
  score = Math.max(0, Math.min(1, score));

  return {
    totalItems,
    duplicateCount,
    sourceDiversity,
    categoryDiversity,
    staleFraction,
    lowEngagementFraction,
    topKCollapseSimilarity: collapseSim,
    feedQualityScore: score,
    warnings,
  };
}
