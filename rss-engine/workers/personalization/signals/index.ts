/**
 * Phase D — Personalization signal taxonomy, weighting & noise reduction.
 *
 * This module is the single source of truth for what "behavior" means to
 * the ranking engine. It does *not* talk to the database; it is a pure
 * functional layer the worker pipelines use to:
 *
 *   1. Normalize raw engagement rows into a canonical `Signal` shape
 *      (ingestion-time noise reduction lives here).
 *   2. Score signals with stable, configurable weights.
 *   3. Apply time decay (exponential, configurable half-life).
 *   4. Aggregate per (category, source) so downstream consumers
 *      (interestGraph, personalizedRanker, feedbackLoop) operate on a
 *      tiny, well-typed surface.
 *
 * Design rationale: keeping signal math pure makes the simulation suite
 * trivial — we drive it with synthetic rows and assert deterministic
 * scores. The real worker that calls into this module is a thin shell
 * that fetches rows via the existing RPC layer and feeds them in.
 */

export type SignalKind =
  | 'article_click'
  | 'article_read_complete'
  | 'bookmark'
  | 'reaction_like'
  | 'share'
  | 'notification_open'
  | 'notification_ignore'
  | 'source_follow'
  | 'category_follow'
  | 'dwell_time';

/**
 * Default weights — tuned to match the matrix in the Phase D problem
 * statement (low / medium / high / adaptive). These are *base* weights:
 * `dwell_time` is adaptive and is computed per-signal from `dwellMs`.
 */
export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = {
  article_click: 1,
  article_read_complete: 3,
  bookmark: 4,
  reaction_like: 3,
  share: 6,
  notification_open: 6,
  notification_ignore: -1,
  source_follow: 8,
  category_follow: 8,
  dwell_time: 0, // adaptive; computed in `weightFor`
};

export interface RawSignal {
  kind: SignalKind;
  userId: string;
  articleId?: string | null;
  sourceId?: string | null;
  categoryId?: string | null;
  /** When the user produced the signal. */
  happenedAt: Date | string | number;
  /** Dwell milliseconds — required for kind='dwell_time', optional otherwise. */
  dwellMs?: number;
  /** Free-form metadata (kept opaque). */
  metadata?: Record<string, unknown>;
}

export interface NormalizedSignal {
  kind: SignalKind;
  userId: string;
  articleId: string | null;
  sourceId: string | null;
  categoryId: string | null;
  happenedAt: Date;
  dwellMs: number;
  rawWeight: number;
  /** True when a noise-reduction filter rejected this signal. */
  rejected: boolean;
  rejectReason?: string;
}

export interface SignalScoringOptions {
  /** Half-life (in days) for exponential decay. Default 14 days. */
  halfLifeDays?: number;
  /** Weights override; falls back to DEFAULT_SIGNAL_WEIGHTS. */
  weights?: Partial<Record<SignalKind, number>>;
  /**
   * Minimum dwell milliseconds for a signal to count. Anything below
   * is treated as an accidental open (Phase D noise reduction rule:
   * "accidental opens <3 sec"). Default 3000.
   */
  accidentalOpenThresholdMs?: number;
  /**
   * Per-(user, article, kind) cool-down. Repeat interactions inside
   * the window are dropped (Phase D noise reduction rule: "repeated
   * same-article interactions"). Default 30 seconds.
   */
  repeatCooldownMs?: number;
  /**
   * Spam click cap. More than N clicks of the same article in
   * `spamWindowMs` are flagged as spam and dropped. Default 10 / 60s.
   */
  spamClickThreshold?: number;
  spamWindowMs?: number;
  /** Now-clock injection point for deterministic tests. */
  now?: () => Date;
}

/**
 * Public stats — surfaced into the simulation harness so observability
 * dashboards can be wired up without re-implementing the math.
 */
export interface SignalPipelineStats {
  total: number;
  accepted: number;
  rejectedAccidental: number;
  rejectedRepeat: number;
  rejectedSpam: number;
  rejectedUnknown: number;
}

function toDate(v: Date | string | number): Date {
  if (v instanceof Date) return v;
  return new Date(v);
}

/**
 * Adaptive weight: dwell-time scales sub-linearly. Cap at 10 to prevent
 * a single 60-minute idle session from dominating the rest of the
 * affinity vector. Below `accidentalOpenThresholdMs` returns 0; above
 * returns `1 + log10(dwellSec)`.
 */
export function weightForDwell(
  dwellMs: number,
  accidentalThresholdMs: number,
): number {
  if (!Number.isFinite(dwellMs) || dwellMs < accidentalThresholdMs) return 0;
  const dwellSec = Math.max(dwellMs / 1000, 1);
  return Math.min(10, 1 + Math.log10(dwellSec));
}

/**
 * Resolve the base weight for a signal. `dwell_time` is adaptive;
 * everything else uses the configured weight table.
 */
export function weightFor(
  kind: SignalKind,
  dwellMs: number,
  weights: Record<SignalKind, number>,
  accidentalThresholdMs: number,
): number {
  if (kind === 'dwell_time') {
    return weightForDwell(dwellMs, accidentalThresholdMs);
  }
  return weights[kind] ?? 0;
}

/**
 * Exponential decay factor for an event observed at `happenedAt`,
 * relative to `now`. Half-life in days. Always in (0, 1].
 */
export function decayFactor(
  happenedAt: Date,
  now: Date,
  halfLifeDays: number,
): number {
  const ageMs = Math.max(now.getTime() - happenedAt.getTime(), 0);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-(Math.LN2 / Math.max(halfLifeDays, 0.1)) * ageDays);
}

interface InternalKeyTracker {
  // (user|article|kind) -> last timestamp ms
  lastTs: Map<string, number>;
  // (user|article) -> array of click timestamps (rolling)
  clicks: Map<string, number[]>;
}

function makeKey(userId: string, articleId: string, kind: SignalKind): string {
  return `${userId}::${articleId}::${kind}`;
}

function makeClickKey(userId: string, articleId: string): string {
  return `${userId}::${articleId}`;
}

/**
 * Run noise reduction over a *batch* of raw signals. The function is
 * pure: it returns normalized signals with `rejected=true` when a
 * filter dropped the row, leaving counts in `stats` for observability.
 *
 * Sort order matters for cooldown/spam windows; the function will sort
 * by `happenedAt` ascending internally so callers can pass any order.
 */
export function normalizeSignals(
  raws: ReadonlyArray<RawSignal>,
  opts: SignalScoringOptions = {},
): { signals: NormalizedSignal[]; stats: SignalPipelineStats } {
  const weights = {
    ...DEFAULT_SIGNAL_WEIGHTS,
    ...(opts.weights ?? {}),
  } as Record<SignalKind, number>;
  const accidentalMs = opts.accidentalOpenThresholdMs ?? 3000;
  const cooldownMs = opts.repeatCooldownMs ?? 30_000;
  const spamThresh = opts.spamClickThreshold ?? 10;
  const spamWindow = opts.spamWindowMs ?? 60_000;

  const stats: SignalPipelineStats = {
    total: raws.length,
    accepted: 0,
    rejectedAccidental: 0,
    rejectedRepeat: 0,
    rejectedSpam: 0,
    rejectedUnknown: 0,
  };

  const tracker: InternalKeyTracker = {
    lastTs: new Map(),
    clicks: new Map(),
  };

  const sorted = [...raws].sort((a, b) => {
    return toDate(a.happenedAt).getTime() - toDate(b.happenedAt).getTime();
  });

  const out: NormalizedSignal[] = [];
  for (const r of sorted) {
    const happenedAt = toDate(r.happenedAt);
    const articleId = r.articleId ?? null;
    const sourceId = r.sourceId ?? null;
    const categoryId = r.categoryId ?? null;
    const dwellMs = Math.max(0, r.dwellMs ?? 0);
    const rawWeight = weightFor(r.kind, dwellMs, weights, accidentalMs);

    const base: NormalizedSignal = {
      kind: r.kind,
      userId: r.userId,
      articleId,
      sourceId,
      categoryId,
      happenedAt,
      dwellMs,
      rawWeight,
      rejected: false,
    };

    if (!Number.isFinite(rawWeight)) {
      stats.rejectedUnknown += 1;
      out.push({ ...base, rejected: true, rejectReason: 'non_finite_weight' });
      continue;
    }

    // Accidental open filter — only applies to dwell-bearing signals.
    if (
      (r.kind === 'article_click' || r.kind === 'dwell_time') &&
      dwellMs > 0 &&
      dwellMs < accidentalMs
    ) {
      stats.rejectedAccidental += 1;
      out.push({
        ...base,
        rejected: true,
        rejectReason: 'accidental_open_under_threshold',
      });
      continue;
    }

    if (articleId) {
      // Repeat-interaction cooldown.
      const k = makeKey(r.userId, articleId, r.kind);
      const last = tracker.lastTs.get(k);
      if (last !== undefined && happenedAt.getTime() - last < cooldownMs) {
        stats.rejectedRepeat += 1;
        out.push({
          ...base,
          rejected: true,
          rejectReason: 'repeat_interaction_cooldown',
        });
        continue;
      }
      tracker.lastTs.set(k, happenedAt.getTime());

      // Spam click guard.
      if (r.kind === 'article_click') {
        const ck = makeClickKey(r.userId, articleId);
        const arr = tracker.clicks.get(ck) ?? [];
        const cutoff = happenedAt.getTime() - spamWindow;
        while (arr.length > 0 && arr[0] < cutoff) arr.shift();
        arr.push(happenedAt.getTime());
        tracker.clicks.set(ck, arr);
        if (arr.length > spamThresh) {
          stats.rejectedSpam += 1;
          out.push({
            ...base,
            rejected: true,
            rejectReason: 'spam_click_burst',
          });
          continue;
        }
      }
    }

    stats.accepted += 1;
    out.push(base);
  }

  return { signals: out, stats };
}

export interface ScoredBuckets {
  /** category_id → decayed weighted score */
  byCategory: Map<string, number>;
  /** source_id   → decayed weighted score */
  bySource: Map<string, number>;
  /** count of accepted signals contributing to scoring */
  contributingCount: number;
  /** Most recent contributing signal */
  lastInteractionAt: Date | null;
}

/**
 * Aggregate normalized signals into per-source / per-category buckets
 * with exponential time decay. Rejected signals are skipped. Negative
 * weights (e.g. `notification_ignore`) reduce the bucket sum.
 */
export function aggregateSignals(
  signals: ReadonlyArray<NormalizedSignal>,
  opts: SignalScoringOptions = {},
): ScoredBuckets {
  const halfLife = opts.halfLifeDays ?? 14;
  const now = (opts.now ?? (() => new Date()))();

  const byCategory = new Map<string, number>();
  const bySource = new Map<string, number>();
  let count = 0;
  let lastInteractionAt: Date | null = null;

  for (const s of signals) {
    if (s.rejected) continue;
    if (s.rawWeight === 0) continue;
    const decay = decayFactor(s.happenedAt, now, halfLife);
    const value = s.rawWeight * decay;
    if (s.categoryId) {
      byCategory.set(s.categoryId, (byCategory.get(s.categoryId) ?? 0) + value);
    }
    if (s.sourceId) {
      bySource.set(s.sourceId, (bySource.get(s.sourceId) ?? 0) + value);
    }
    count += 1;
    if (!lastInteractionAt || s.happenedAt > lastInteractionAt) {
      lastInteractionAt = s.happenedAt;
    }
  }

  return { byCategory, bySource, contributingCount: count, lastInteractionAt };
}
