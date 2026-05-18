/**
 * Phase D — Feedback loop engine.
 *
 * Closes the personalization → engagement → ranking-weight loop.
 *
 * Tracks four signals per session/per-user that determine whether the
 * personalized ranker is actually serving the user well:
 *
 *   - feed quality score        — derived score from explicit signals
 *   - engagement outcome        — share / bookmark / read-complete
 *   - bounce rate               — sessions that ended < bounceThresholdMs
 *   - long-session correlation  — sessions whose dwell exceeds
 *                                 `longSessionMs` get a quality multiplier
 *
 * Two outputs:
 *
 *   (a) A `FeedbackSample` row the worker writes to
 *       `ranking_feedback_metrics` via `record_ranking_feedback` (048).
 *   (b) A `WeightAdjustmentSuggestion` the operator can periodically
 *       review and bake back into ranker tunables. The suggestion is
 *       *advisory*: we never auto-mutate ranker constants in flight.
 */

export type FeedVariant =
  | 'global'
  | 'personalized_v1'
  | 'personalized_v2'
  | 'breaking';

export interface SessionEvent {
  kind:
    | 'view'
    | 'click'
    | 'read_complete'
    | 'bookmark'
    | 'share'
    | 'reaction_like'
    | 'reaction_dislike'
    | 'hide'
    | 'fast_scroll'
    | 'session_end';
  /** Dwell on this article in ms (where applicable). */
  dwellMs?: number;
  articleId?: string;
  sourceId?: string;
  categoryId?: string;
  occurredAt: Date | string | number;
  /** True if this article was marked exploration in the served slice. */
  isExploration?: boolean;
}

export interface SessionInput {
  userId: string | null;
  sessionId: string;
  feedVariant: FeedVariant;
  events: ReadonlyArray<SessionEvent>;
  metadata?: Record<string, unknown>;
}

export interface FeedbackOptions {
  /** Below this total dwell, the session is a bounce. Default 5s. */
  bounceThresholdMs?: number;
  /** Above this total dwell, the session gets a long-session bonus. Default 120s. */
  longSessionMs?: number;
  /** Quality bonus applied when total dwell exceeds `longSessionMs`. Default 0.25. */
  longSessionBonus?: number;
  /** Quality score floor. Default 0. */
  qualityFloor?: number;
}

export interface FeedbackSample {
  userId: string | null;
  sessionId: string;
  feedVariant: FeedVariant;
  sessionDwellMs: number;
  bounce: boolean;
  qualityScore: number;
  diversityScore: number;
  explorationRatio: number;
  metadata: Record<string, unknown>;
}

const POSITIVE_KINDS = new Set<SessionEvent['kind']>([
  'read_complete',
  'bookmark',
  'share',
  'reaction_like',
]);

const NEGATIVE_KINDS = new Set<SessionEvent['kind']>([
  'hide',
  'reaction_dislike',
  'fast_scroll',
]);

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

/**
 * Compute a feedback sample for a single session.
 *
 * Quality score is a bounded `[0, 1]` linear combination of:
 *   - read_complete  / view   ratio        (weight 0.4)
 *   - positive       / total  ratio        (weight 0.3)
 *   - 1 − negative   / total  ratio        (weight 0.2)
 *   - long-session bonus                   (weight 0.1)
 * Then floored / clamped.
 */
export function scoreSession(
  session: SessionInput,
  opts: FeedbackOptions = {},
): FeedbackSample {
  const bounceMs = opts.bounceThresholdMs ?? 5_000;
  const longMs = opts.longSessionMs ?? 120_000;
  const longBonus = opts.longSessionBonus ?? 0.25;
  const floor = opts.qualityFloor ?? 0;

  let totalDwellMs = 0;
  let views = 0;
  let reads = 0;
  let positives = 0;
  let negatives = 0;
  let explorationViews = 0;
  const distinctSources = new Set<string>();
  const distinctCategories = new Set<string>();

  for (const e of session.events) {
    totalDwellMs += Math.max(0, e.dwellMs ?? 0);
    if (e.kind === 'view') {
      views += 1;
      if (e.isExploration) explorationViews += 1;
    }
    if (e.kind === 'read_complete') reads += 1;
    if (POSITIVE_KINDS.has(e.kind)) positives += 1;
    if (NEGATIVE_KINDS.has(e.kind)) negatives += 1;
    if (e.sourceId) distinctSources.add(e.sourceId);
    if (e.categoryId) distinctCategories.add(e.categoryId);
  }

  const interactionTotal = Math.max(positives + negatives, 1);
  const readRatio = views > 0 ? reads / views : 0;
  const positiveRatio = positives / interactionTotal;
  const negativePenalty = 1 - Math.min(1, negatives / interactionTotal);
  const longBonusComponent = totalDwellMs >= longMs ? longBonus : 0;

  const rawQuality =
    0.4 * readRatio +
    0.3 * positiveRatio +
    0.2 * negativePenalty +
    longBonusComponent;
  const qualityScore = Math.min(1, Math.max(floor, rawQuality));

  const bounce = totalDwellMs < bounceMs && positives === 0;
  // Diversity proxy: distinct sources / views (clamped). Captures
  // "Are we serving the same source over and over?" without needing
  // the original served slice.
  const diversityScore =
    views > 0 ? Math.min(1, distinctSources.size / Math.max(views, 1)) : 0;
  const explorationRatio = views > 0 ? explorationViews / views : 0;

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    feedVariant: session.feedVariant,
    sessionDwellMs: totalDwellMs,
    bounce,
    qualityScore,
    diversityScore,
    explorationRatio,
    metadata: {
      ...(session.metadata ?? {}),
      views,
      reads,
      positives,
      negatives,
      distinct_sources: distinctSources.size,
      distinct_categories: distinctCategories.size,
    },
  };
}

export interface WeightAdjustmentSuggestion {
  freshnessHalfLifeHoursDelta: number;
  explorationRatioDelta: number;
  repetitionPenaltyDelta: number;
  reason: string;
}

/**
 * Aggregate a batch of recent samples and recommend (advisory) weight
 * deltas. Used by the `ranking_feedback_analysis` queue processor to
 * surface tuning signals to the admin dashboard. The function is pure
 * and never mutates ranker constants.
 */
export function suggestWeightAdjustments(
  samples: ReadonlyArray<FeedbackSample>,
): WeightAdjustmentSuggestion {
  if (samples.length === 0) {
    return {
      freshnessHalfLifeHoursDelta: 0,
      explorationRatioDelta: 0,
      repetitionPenaltyDelta: 0,
      reason: 'no_samples',
    };
  }
  const avgQuality =
    samples.reduce((a, s) => a + s.qualityScore, 0) / samples.length;
  const bounceRate =
    samples.reduce((a, s) => a + (s.bounce ? 1 : 0), 0) / samples.length;
  const avgDiversity =
    samples.reduce((a, s) => a + s.diversityScore, 0) / samples.length;
  const avgExploration =
    samples.reduce((a, s) => a + s.explorationRatio, 0) / samples.length;

  const reasons: string[] = [
    `avg_quality=${avgQuality.toFixed(3)}`,
    `bounce_rate=${bounceRate.toFixed(3)}`,
    `avg_diversity=${avgDiversity.toFixed(3)}`,
    `avg_exploration=${avgExploration.toFixed(3)}`,
  ];

  // High bounce → freshen feed; nudge half-life down (more fresh content).
  let freshDelta = 0;
  if (bounceRate > 0.35) freshDelta = -2;
  else if (bounceRate < 0.1 && avgQuality > 0.6) freshDelta = +1;

  // Low diversity → bump exploration ratio.
  let exploreDelta = 0;
  if (avgDiversity < 0.3) exploreDelta = +0.05;
  else if (avgDiversity > 0.7) exploreDelta = -0.02;

  // Low quality with high repetition exposure → bump repetition penalty.
  let repetitionDelta = 0;
  if (avgQuality < 0.3 && avgDiversity < 0.4) repetitionDelta = +0.05;

  return {
    freshnessHalfLifeHoursDelta: freshDelta,
    explorationRatioDelta: exploreDelta,
    repetitionPenaltyDelta: repetitionDelta,
    reason: reasons.join('; '),
  };
}
