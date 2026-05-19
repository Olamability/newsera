/**
 * Phase E — Adaptive exploration controller (closes Phase D static-exploration debt).
 *
 * Phase D's personalized ranker exposed a fixed `explorationRatio` (default
 * 10%). That is fine as a default but two failure modes appear at scale:
 *
 *   - Echo chambers: users whose engagement is concentrated on a handful of
 *     sources/categories get *less* benefit from exploration because their
 *     interest vector is already narrow; the static 10% is insufficient to
 *     widen it.
 *
 *   - Recommendation stagnation: high-quality engagement users keep clicking
 *     the same kind of articles and a fixed 10% injection just adds noise to
 *     a feed that is already working — they want depth, not breadth.
 *
 * This controller turns the static 10% into a *function of engagement
 * quality*:
 *
 *   Engagement Quality | Exploration
 *   ------------------ | -----------
 *   High               | lower      (down to `minRatio`, default 0.04)
 *   Medium             | stable     (around `baseRatio`,  default 0.10)
 *   Low                | increase   (up   to `maxRatio`, default 0.25)
 *
 * Hard rules:
 *   - PURE FUNCTION. Determines a ratio from engagement signals — no I/O.
 *   - BOUNDED. Output always within [minRatio, maxRatio], so it can never
 *     over-randomize a feed (would look broken) or kill exploration entirely
 *     (would freeze the recommendation graph).
 *   - SMOOTHED. The controller carries a tiny EMA per user so a single bad
 *     session does not whiplash the ratio. The EMA is callerprovided so the
 *     module stays stateless — the worker persists the smoothed value in
 *     `user_recommendation_state` when it exists, or recomputes on the fly
 *     when it does not.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EngagementQuality = 'high' | 'medium' | 'low' | 'cold_start';

/**
 * The raw engagement summary the controller consumes. Mirrors the columns
 * already produced by Phase D's feedback loop (`ranking_feedback_metrics`).
 * Any field may be undefined; the controller falls back to safe defaults.
 */
export interface EngagementSummary {
  /** Fraction of served items the user actually viewed.  [0..1] */
  viewRate?: number;
  /** Fraction of viewed items that ended in a "deep" interaction (read_complete / bookmark / share). */
  deepEngagementRate?: number;
  /** Fraction of sessions that ended before `bounceThresholdMs`. */
  bounceRate?: number;
  /** Average session dwell in ms. */
  avgDwellMs?: number;
  /** Total signals contributing to this summary — gates cold-start handling. */
  signalCount?: number;
  /** Quality score (0..1) of the user's *current* exploration injections. */
  explorationAcceptanceRate?: number;
}

export interface ExplorationControllerOptions {
  /** Lower bound on injected exploration. Default 0.04 (4%). */
  minRatio?: number;
  /** Steady-state ratio for medium-quality users. Default 0.10 (10%). */
  baseRatio?: number;
  /** Upper bound for low-engagement / cold-start users. Default 0.25 (25%). */
  maxRatio?: number;
  /** Smoothing factor for the per-user EMA. Default 0.3. */
  emaAlpha?: number;
  /**
   * Minimum signal count before the controller leaves cold_start mode.
   * Default 8 — matches the interest-graph cold-start threshold.
   */
  coldStartSignalThreshold?: number;
}

export interface ExplorationDecision {
  /** Bounded ratio the ranker should pass to `rankForUser({ explorationRatio })`. */
  ratio: number;
  /** Classification used for observability. */
  quality: EngagementQuality;
  /** Raw quality score in [0..1] (pre-smoothing). */
  qualityScore: number;
  /** EMA-smoothed ratio the caller persists for the next decision. */
  smoothedRatio: number;
  /** Free-form reason string for the structured log line. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------

const DEFAULTS: Required<ExplorationControllerOptions> = {
  minRatio: 0.04,
  baseRatio: 0.1,
  maxRatio: 0.25,
  emaAlpha: 0.3,
  coldStartSignalThreshold: 8,
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Composite quality score in [0..1]. Higher = better engagement, which
 * should LOWER the exploration ratio.
 *
 * Components:
 *   - deepEngagementRate  (0.40 weight) — strong positive signal
 *   - viewRate            (0.25 weight) — moderate positive signal
 *   - (1 - bounceRate)    (0.20 weight) — bounces drag the score down
 *   - dwell saturation    (0.10 weight) — saturates at 120s dwell
 *   - explorationAcceptance (0.05 weight) — accepting exploration items is a
 *     mild positive for keeping exploration high; we therefore wire it in
 *     with a *negative* sign so accepting exploration nudges us toward MORE
 *     exploration. The small weight keeps it from dominating.
 */
export function scoreEngagementQuality(summary: EngagementSummary): number {
  const deep = clamp(summary.deepEngagementRate ?? 0, 0, 1);
  const view = clamp(summary.viewRate ?? 0, 0, 1);
  const bounce = clamp(summary.bounceRate ?? 0, 0, 1);
  const dwell = clamp((summary.avgDwellMs ?? 0) / 120_000, 0, 1);
  const expAccept = clamp(summary.explorationAcceptanceRate ?? 0, 0, 1);
  // Note the SUBTRACTION for expAccept — see header.
  const composite =
    0.4 * deep + 0.25 * view + 0.2 * (1 - bounce) + 0.1 * dwell - 0.05 * expAccept;
  return clamp(composite, 0, 1);
}

export function classifyQuality(
  summary: EngagementSummary,
  coldStartSignalThreshold: number,
): EngagementQuality {
  const signals = summary.signalCount ?? 0;
  if (signals < coldStartSignalThreshold) return 'cold_start';
  const score = scoreEngagementQuality(summary);
  if (score >= 0.65) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

/**
 * Map a quality bucket onto a target ratio. Bands intentionally overlap so
 * tests can verify monotonicity without sweeping the entire score space.
 */
function targetRatioForQuality(
  quality: EngagementQuality,
  cfg: Required<ExplorationControllerOptions>,
): number {
  switch (quality) {
    case 'high':
      return cfg.minRatio;
    case 'medium':
      return cfg.baseRatio;
    case 'low':
      return cfg.maxRatio;
    case 'cold_start':
      // Cold-start users get aggressive exploration so the interest graph
      // can learn quickly; capped at maxRatio.
      return cfg.maxRatio;
  }
}

/**
 * Decide the next exploration ratio for a user.
 *
 * @param summary  current engagement summary (typically from `ranking_feedback_metrics`)
 * @param previousSmoothed  the controller's prior smoothed ratio (NaN/null for first call)
 */
export function decideExplorationRatio(
  summary: EngagementSummary,
  previousSmoothed: number | null,
  opts: ExplorationControllerOptions = {},
): ExplorationDecision {
  const cfg: Required<ExplorationControllerOptions> = { ...DEFAULTS, ...opts };
  // Defensive bound: ensure min <= base <= max.
  const minR = Math.max(0, Math.min(cfg.minRatio, cfg.baseRatio, cfg.maxRatio));
  const maxR = Math.max(cfg.minRatio, cfg.baseRatio, cfg.maxRatio);
  const alpha = clamp(cfg.emaAlpha, 0.01, 1);

  const quality = classifyQuality(summary, cfg.coldStartSignalThreshold);
  const qualityScore = scoreEngagementQuality(summary);
  const target = clamp(targetRatioForQuality(quality, cfg), minR, maxR);

  let smoothed: number;
  if (previousSmoothed === null || !Number.isFinite(previousSmoothed)) {
    smoothed = target;
  } else {
    smoothed = clamp(
      previousSmoothed + alpha * (target - previousSmoothed),
      minR,
      maxR,
    );
  }

  return {
    ratio: smoothed,
    smoothedRatio: smoothed,
    quality,
    qualityScore,
    reason: `quality=${quality} score=${qualityScore.toFixed(3)} target=${target.toFixed(3)}`,
  };
}

// ---------------------------------------------------------------------------
// Stateless controller object — convenience wrapper
// ---------------------------------------------------------------------------

export interface ExplorationController {
  decide(summary: EngagementSummary, previousSmoothed: number | null): ExplorationDecision;
}

export function createExplorationController(
  opts: ExplorationControllerOptions = {},
): ExplorationController {
  return {
    decide(summary, prev) {
      return decideExplorationRatio(summary, prev, opts);
    },
  };
}
