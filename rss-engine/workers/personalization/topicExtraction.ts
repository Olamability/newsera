/**
 * Phase E — Lightweight semantic topic extraction (closes Phase D affinity debt).
 *
 * Phase D's interest graph carries a `topicAffinity` map but never had a
 * trustworthy way to fill it: the worker either inherited topics from
 * upstream feeds (sparse) or relied on the article's category (collides with
 * `categoryAffinity`).
 *
 * This module fills the gap with a *deterministic, dependency-free* topic
 * extractor that runs at ingestion time. It is intentionally NOT a
 * vectorizer — there are NO embeddings, NO external APIs, and NO learned
 * weights. The output is a small, sparse vector of normalized topic keys
 * with per-token scores in [0..1].
 *
 *   ┌──────────────────────────┐
 *   │ title + snippet + cat    │
 *   └──────────┬───────────────┘
 *              │ tokenize, lowercase, strip punctuation
 *              ▼
 *   ┌──────────────────────────┐
 *   │ stop-word filter         │
 *   └──────────┬───────────────┘
 *              │ score: tf × field weight
 *              ▼
 *   ┌──────────────────────────┐
 *   │ optional bigram boosts   │
 *   └──────────┬───────────────┘
 *              │ length cap + L2 normalize
 *              ▼
 *   ┌──────────────────────────┐
 *   │ TopicVector              │
 *   └──────────────────────────┘
 *
 * Hard rules:
 *   - DETERMINISTIC. Same input → same output every time; safe for cache
 *     keys and dedup logic.
 *   - LIGHTWEIGHT. No network calls. Pure CPU. Bounded by the input string
 *     length and `maxTopics` (default 16).
 *   - SAFE FOR PUBLIC TEXT. Strips HTML tags and collapses whitespace so a
 *     scraped snippet does not poison the topic map.
 *   - SCHEMA-COMPATIBLE. Output keys are plain lowercase ASCII tokens
 *     (and `_`-joined bigrams) — already storable in `article_topics`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TopicExtractionInput {
  title?: string | null;
  snippet?: string | null;
  /** Resolved category slug (NOT id) — used as a soft topic boost. */
  categorySlug?: string | null;
  /** Optional pre-existing topics (e.g. from RSS metadata). */
  hintedTopics?: ReadonlyArray<string>;
}

export interface TopicExtractionOptions {
  /** Max number of topics retained per article. Default 16. */
  maxTopics?: number;
  /** Minimum token length (after lowercasing). Default 3. */
  minTokenLength?: number;
  /** Per-field weights when scoring. */
  fieldWeights?: Partial<{
    title: number;
    snippet: number;
    category: number;
    hint: number;
  }>;
  /** Extra stopwords to add on top of the built-in list. */
  extraStopwords?: ReadonlyArray<string>;
  /** Enable bigram extraction. Default true. */
  enableBigrams?: boolean;
}

export interface TopicVector {
  /** Normalized topic → score (L2 normalized so vectors are comparable). */
  topics: Map<string, number>;
  /** Distinct token count BEFORE the maxTopics cap. */
  rawTokenCount: number;
  /** Bigrams emitted (subset of `topics`). */
  bigramCount: number;
}

// ---------------------------------------------------------------------------
// Stopword list — kept short on purpose, single-language (en).
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'while', 'as', 'at', 'by',
  'for', 'from', 'in', 'into', 'of', 'on', 'onto', 'to', 'with', 'over',
  'under', 'about', 'after', 'before', 'between', 'against', 'through',
  'during', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can',
  'may', 'might', 'must', 'this', 'that', 'these', 'those', 'i', 'you',
  'he', 'she', 'it', 'we', 'they', 'them', 'his', 'her', 'its', 'our',
  'their', 'me', 'my', 'mine', 'your', 'yours', 'us', 'ours', 'theirs',
  'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how',
  'not', 'no', 'nor', 'too', 'very', 'just', 'than', 'then', 'such', 'all',
  'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'only',
  'own', 'same', 'also', 'said', 'says', 'new', 'one', 'two', 'three',
]);

const DEFAULTS: Required<Omit<TopicExtractionOptions, 'extraStopwords' | 'fieldWeights'>> & {
  fieldWeights: Required<NonNullable<TopicExtractionOptions['fieldWeights']>>;
} = {
  maxTopics: 16,
  minTokenLength: 3,
  enableBigrams: true,
  fieldWeights: {
    title: 3.0,
    snippet: 1.0,
    category: 2.0,
    hint: 2.5,
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

/**
 * Conservative tokenizer:
 *   - Lowercase.
 *   - Replace anything that's not a letter, digit, hyphen or apostrophe with
 *     a space.
 *   - Collapse runs of whitespace.
 *   - Trim leading/trailing punctuation off each token.
 *
 * Numbers are preserved (e.g. "2024", "ai24") because they often disambiguate
 * topic identity ("ipcc-2024" vs "ipcc-2018"), but we drop pure-number
 * tokens shorter than the minimum length.
 */
function tokenize(input: string, minLen: number): string[] {
  if (!input) return [];
  const cleaned = stripHtml(input)
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const out: string[] = [];
  for (const raw of cleaned.split(' ')) {
    const trimmed = raw.replace(/^[-']+|[-']+$/g, '');
    if (trimmed.length < minLen) continue;
    out.push(trimmed);
  }
  return out;
}

function normalizeKey(token: string): string {
  // Collapse repeated hyphens/apostrophes that survive tokenization.
  return token.replace(/-+/g, '-').replace(/'+/g, "'");
}

function isStopword(token: string, extra?: ReadonlyArray<string>): boolean {
  if (STOPWORDS.has(token)) return true;
  if (!extra) return false;
  for (const s of extra) if (s === token) return true;
  return false;
}

function bumpScore(map: Map<string, number>, key: string, delta: number): void {
  if (delta <= 0 || !key) return;
  map.set(key, (map.get(key) ?? 0) + delta);
}

/** L2-normalize the score vector so the magnitudes are comparable across articles. */
function l2Normalize(map: Map<string, number>): void {
  let sumSq = 0;
  for (const v of map.values()) sumSq += v * v;
  if (sumSq <= 0) return;
  const norm = Math.sqrt(sumSq);
  for (const [k, v] of map) map.set(k, v / norm);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractTopics(
  input: TopicExtractionInput,
  opts: TopicExtractionOptions = {},
): TopicVector {
  const cfg = {
    ...DEFAULTS,
    ...opts,
    fieldWeights: { ...DEFAULTS.fieldWeights, ...(opts.fieldWeights ?? {}) },
  };
  const stopExtra = opts.extraStopwords;
  const scores = new Map<string, number>();
  let bigramCount = 0;
  const rawSeen = new Set<string>();

  function ingestField(text: string | null | undefined, weight: number, allowBigrams: boolean): void {
    if (!text) return;
    const tokens = tokenize(String(text), cfg.minTokenLength);
    let prevAcceptable: string | null = null;
    for (const raw of tokens) {
      const key = normalizeKey(raw);
      rawSeen.add(key);
      if (isStopword(key, stopExtra)) {
        prevAcceptable = null;
        continue;
      }
      bumpScore(scores, key, weight);
      if (allowBigrams && cfg.enableBigrams && prevAcceptable) {
        const bigram = `${prevAcceptable}_${key}`;
        // Bigrams get slightly less weight than the underlying unigrams so
        // they don't dominate; but more than a stopword-adjacent single
        // token. 0.6× the field weight is the calibration we use.
        bumpScore(scores, bigram, weight * 0.6);
        bigramCount += 1;
      }
      prevAcceptable = key;
    }
  }

  ingestField(input.title ?? '', cfg.fieldWeights.title, true);
  ingestField(input.snippet ?? '', cfg.fieldWeights.snippet, true);
  if (input.categorySlug) {
    // Category slug is treated as a single token (no bigrams) so its weight
    // applies cleanly and we don't accidentally double-count "world-news"
    // as both "world" and "news".
    const cat = normalizeKey(String(input.categorySlug).toLowerCase());
    if (cat && !isStopword(cat, stopExtra)) {
      bumpScore(scores, cat, cfg.fieldWeights.category);
      rawSeen.add(cat);
    }
  }
  if (input.hintedTopics && input.hintedTopics.length > 0) {
    for (const t of input.hintedTopics) {
      const key = normalizeKey(String(t).toLowerCase().trim());
      if (!key || isStopword(key, stopExtra)) continue;
      bumpScore(scores, key, cfg.fieldWeights.hint);
      rawSeen.add(key);
    }
  }

  // Cap and normalize.
  if (scores.size > cfg.maxTopics) {
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const capped = new Map(sorted.slice(0, cfg.maxTopics));
    scores.clear();
    for (const [k, v] of capped) scores.set(k, v);
  }
  l2Normalize(scores);

  return {
    topics: scores,
    rawTokenCount: rawSeen.size,
    bigramCount,
  };
}

/**
 * Convenience: turn a TopicVector into a plain object suitable for storing
 * in `article_topics.payload` (jsonb) without surprising key ordering.
 */
export function topicVectorToPayload(vec: TopicVector): Record<string, number> {
  const out: Record<string, number> = {};
  const sorted = [...vec.topics.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) out[k] = Math.round(v * 10_000) / 10_000;
  return out;
}
