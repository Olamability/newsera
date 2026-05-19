/**
 * Phase D — Personalization & Ranking simulation harness.
 *
 * Mirrors the structure of `queueRunner.simulation.ts` and
 * `notification.simulation.ts`. Exercises every scenario from the
 * Phase D testing matrix plus the Phase C operational-debt closures:
 *
 *   1. Signal taxonomy + decay + noise reduction
 *   2. User interest adaptation (sports reads → sports affinity rises)
 *   3. Diversity enforcement (no more than 3 consecutive same source)
 *   4. Exploration injection at the configured rate
 *   5. Negative-feedback suppression (hidden / disliked vanish fast)
 *   6. Personalized refresh scaling at 100k users (selective only)
 *   7. Notification-open feedback loop (opened boosts, ignored decays)
 *   8. Fanout chunker — ≤1k recipients per chunk, lineage preserved
 *   9. Push retry tiers (immediate / +30s / +5min / DLQ)
 *  10. Analytics delivery health emit / accept / drop / fail
 *  11. Feedback-loop session scoring + tuning suggestion
 *  12. Flag OFF — personalization processors structured-skip safely
 *
 * Exits non-zero on any assertion failure.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../lib/logger';
import { createCategoryNormalizer } from '../lib/normalizeCategory';
import { createAnalyticsProcessor } from '../lib/processors/analytics';
import { createRankingProcessor } from '../lib/processors/ranking';
import { createDeliveryHealthRecorder } from '../notification/analyticsDeliveryHealth';
import { createFanoutChunker, FANOUT_CHUNK_SIZE } from '../notification/fanoutChunker';
import {
  decideRetry,
  MAX_PUSH_ATTEMPTS,
  PUSH_DEAD_LETTER_REASONS,
  RETRY_DELAYS_SEC,
} from '../notification/push/pushRetryPolicy';
import {
  buildInterestVector,
  diffInterestVectors,
} from '../personalization/interestGraph';
import {
  scoreSession,
  suggestWeightAdjustments,
} from '../personalization/feedbackLoop';
import {
  aggregateSignals,
  decayFactor,
  normalizeSignals,
  weightForDwell,
  type RawSignal,
} from '../personalization/signals';
import {
  EMPTY_NEGATIVE,
  rankForUser,
  type RankableArticle,
} from '../ranking/personalizedRanker';
import type { LeasedJob } from '../lib/types';

import { createFakeSupabase } from './fakeSupabase';

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${label}`);
  }
}
function section(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${title} ===`);
}
function silentLogger() {
  return ((): void => {
    /* swallow */
  }) as unknown as ReturnType<typeof createLogger>;
}

/** Deterministic xorshift32 PRNG seeded for reproducible tests. */
function seededRandom(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

// ---------------------------------------------------------------------------
// 1) Signal taxonomy + decay + noise reduction
// ---------------------------------------------------------------------------
async function testSignalsAndDecay(): Promise<void> {
  section('1) Signal taxonomy — weights, decay, noise reduction');
  const userId = 'u1';
  const articleA = 'a1';
  const articleB = 'a2';
  const now = new Date('2026-05-18T12:00:00Z');

  // Dwell adaptive weight
  assert(weightForDwell(0, 3000) === 0, 'dwell 0 → weight 0');
  assert(weightForDwell(2000, 3000) === 0, 'dwell 2s under 3s threshold → weight 0');
  assert(weightForDwell(10_000, 3000) > 1, 'dwell 10s → weight > 1');
  assert(weightForDwell(60 * 60 * 1000, 3000) <= 10, 'dwell 1h capped at 10');

  // Decay: half-life 14d → 14d-old event has decay 0.5
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000);
  const d = decayFactor(fourteenDaysAgo, now, 14);
  assert(Math.abs(d - 0.5) < 0.001, `14d decay ≈ 0.5 (got ${d.toFixed(4)})`);

  // Noise reduction — accidental open, repeat cooldown, spam burst
  const raws: RawSignal[] = [];
  // Accidental open: dwell 1s — rejected
  raws.push({
    kind: 'article_click',
    userId,
    articleId: articleA,
    happenedAt: new Date(now.getTime() - 60_000),
    dwellMs: 1000,
  });
  // Same article click within cooldown — rejected as repeat
  raws.push({
    kind: 'article_click',
    userId,
    articleId: articleB,
    happenedAt: new Date(now.getTime() - 50_000),
    dwellMs: 5000,
  });
  raws.push({
    kind: 'article_click',
    userId,
    articleId: articleB,
    happenedAt: new Date(now.getTime() - 49_000),
    dwellMs: 5000,
  });
  // Spam clicks — many clicks on the same article in <60s. Disable the
  // repeat cooldown for this case so the spam-specific guard fires
  // (production has both layers; we exercise the spam path explicitly).
  const spamRaws: RawSignal[] = [];
  for (let i = 0; i < 15; i += 1) {
    spamRaws.push({
      kind: 'article_click',
      userId,
      articleId: 'spam-article',
      happenedAt: new Date(now.getTime() - 5_000 + i * 100),
      dwellMs: 4000,
    });
  }
  const spamRes = normalizeSignals(spamRaws, { repeatCooldownMs: 0 });
  assert(spamRes.stats.rejectedSpam >= 4, `spam burst rejected (got ${spamRes.stats.rejectedSpam})`);

  const { stats } = normalizeSignals(raws);
  assert(stats.rejectedAccidental >= 1, `accidental opens rejected (got ${stats.rejectedAccidental})`);
  assert(stats.rejectedRepeat >= 1, `repeat-cooldown rejected (got ${stats.rejectedRepeat})`);
  assert(stats.accepted < stats.total, 'pipeline rejects at least some noise');
}

// ---------------------------------------------------------------------------
// 2) User interest adaptation
// ---------------------------------------------------------------------------
async function testInterestAdaptation(): Promise<void> {
  section('2) Interest adaptation — repeated sports reads bias affinity');
  const userId = 'u2';
  const sportsCat = 'cat-sports';
  const politicsCat = 'cat-politics';
  const espn = 'src-espn';
  const wapo = 'src-wapo';
  const now = new Date('2026-05-18T12:00:00Z');

  const raws: RawSignal[] = [];
  // 10 sports reads (different articles, different hours so cooldown OK)
  for (let i = 0; i < 10; i += 1) {
    raws.push({
      kind: 'article_read_complete',
      userId,
      articleId: `sports-${i}`,
      sourceId: espn,
      categoryId: sportsCat,
      happenedAt: new Date(now.getTime() - i * 3_600_000),
      dwellMs: 30_000,
    });
  }
  // 1 politics click only (low signal)
  raws.push({
    kind: 'article_click',
    userId,
    articleId: 'politics-1',
    sourceId: wapo,
    categoryId: politicsCat,
    happenedAt: new Date(now.getTime() - 5 * 86_400_000),
    dwellMs: 8000,
  });

  const vec = buildInterestVector(userId, raws, { now: () => now });
  const sportsAffinity = vec.categoryAffinity.get(sportsCat) ?? 0;
  const politicsAffinity = vec.categoryAffinity.get(politicsCat) ?? 0;
  assert(sportsAffinity > 0, 'sports affinity present');
  assert(sportsAffinity > politicsAffinity * 3, `sports >> politics (sports=${sportsAffinity.toFixed(3)}, politics=${politicsAffinity.toFixed(3)})`);
  assert((vec.sourceAffinity.get(espn) ?? 0) > (vec.sourceAffinity.get(wapo) ?? 0), 'espn source affinity dominates');
  assert(vec.engagementDepthSec > 0, 'engagement depth populated from dwell');
  assert(vec.readingConsistency > 0, 'reading consistency > 0 over active days');
}

// ---------------------------------------------------------------------------
// 3) Diversity enforcement
// ---------------------------------------------------------------------------
async function testDiversityEnforcement(): Promise<void> {
  section('3) Diversity enforcement — no more than 3 consecutive same source');
  const userId = 'u3';
  const sportsCat = 'cat-sports';
  const espn = 'src-espn';
  const wapo = 'src-wapo';
  const bbc = 'src-bbc';
  const now = new Date('2026-05-18T12:00:00Z');

  // User has affinity across all three categories — ensures bbc/wapo
  // candidates end up in the main pool where the diversity rotation
  // actually exercises. (Items the user has zero affinity for go into
  // the exploration pool, which is gated by explorationRatio.)
  const vec = buildInterestVector(
    userId,
    [
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'seed-s',
        sourceId: espn,
        categoryId: sportsCat,
        happenedAt: now,
        dwellMs: 30_000,
      },
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'seed-t',
        sourceId: bbc,
        categoryId: 'cat-tech',
        happenedAt: now,
        dwellMs: 30_000,
      },
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'seed-b',
        sourceId: wapo,
        categoryId: 'cat-business',
        happenedAt: now,
        dwellMs: 30_000,
      },
    ],
    { now: () => now },
  );

  const cands: RankableArticle[] = [];
  // 10 high-score ESPN-sports articles + 4 BBC-tech + 4 WAPO-business.
  // The user has affinity for sports, but realistic feeds carry mixed
  // categories — diversity must rotate sources AND categories.
  for (let i = 0; i < 10; i += 1) {
    cands.push({
      articleId: `espn-${i}`,
      sourceId: espn,
      categoryId: sportsCat,
      globalScore: 100 - i,
      publishedAt: now,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    cands.push({
      articleId: `bbc-${i}`,
      sourceId: bbc,
      categoryId: 'cat-tech',
      globalScore: 50 - i,
      publishedAt: now,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    cands.push({
      articleId: `wapo-${i}`,
      sourceId: wapo,
      categoryId: 'cat-business',
      globalScore: 40 - i,
      publishedAt: now,
    });
  }

  const result = rankForUser(vec, cands, EMPTY_NEGATIVE, new Set(), {
    limit: 12,
    maxConsecutiveSameSource: 3,
    explorationRatio: 0,
    random: seededRandom(42),
    now: () => now,
  });

  // Walk the slice and ensure no run > 3 of the same source.
  let maxRun = 0;
  let run = 0;
  let prev = '';
  for (const s of result.slots) {
    const src = s.sourceId ?? '';
    if (src === prev) {
      run += 1;
    } else {
      run = 1;
      prev = src;
    }
    if (run > maxRun) maxRun = run;
  }
  assert(maxRun <= 3, `no source streak > 3 (max run = ${maxRun})`);
  assert(result.distinctSources >= 2, `distinct sources ≥ 2 in slice (got ${result.distinctSources})`);
  assert(result.diversityRotations > 0, 'diversity rotations happened');
}

// ---------------------------------------------------------------------------
// 4) Exploration injection
// ---------------------------------------------------------------------------
async function testExplorationInjection(): Promise<void> {
  section('4) Exploration injection at controlled rate');
  const userId = 'u4';
  const sports = 'cat-sports';
  const espn = 'src-espn';
  const wapo = 'src-wapo';
  const unknownCat = 'cat-cooking';
  const unknownSrc = 'src-foodtv';
  const now = new Date('2026-05-18T12:00:00Z');

  // User has affinity only for sports/espn.
  const vec = buildInterestVector(
    userId,
    [
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'seed-1',
        sourceId: espn,
        categoryId: sports,
        happenedAt: now,
        dwellMs: 30_000,
      },
    ],
    { now: () => now },
  );

  const cands: RankableArticle[] = [];
  // Plenty of known content
  for (let i = 0; i < 30; i += 1) {
    cands.push({
      articleId: `espn-${i}`,
      sourceId: espn,
      categoryId: sports,
      globalScore: 100 - i,
      publishedAt: now,
    });
  }
  for (let i = 0; i < 10; i += 1) {
    cands.push({
      articleId: `wapo-${i}`,
      sourceId: wapo,
      categoryId: sports,
      globalScore: 50 - i,
      publishedAt: now,
    });
  }
  // Unknown content (different category + different source — counts as exploration)
  for (let i = 0; i < 20; i += 1) {
    cands.push({
      articleId: `cooking-${i}`,
      sourceId: unknownSrc,
      categoryId: unknownCat,
      globalScore: 30 - i,
      publishedAt: now,
    });
  }

  const result = rankForUser(vec, cands, EMPTY_NEGATIVE, new Set(), {
    limit: 20,
    maxConsecutiveSameSource: 4,
    explorationRatio: 0.2,
    random: seededRandom(7),
    now: () => now,
  });

  const explorationCount = result.slots.filter((s) => s.isExploration).length;
  // Allow generous tolerance because the picker uses jitter; but must be > 0
  // and within (0.05, 0.45) of 0.2.
  const ratio = explorationCount / result.slots.length;
  assert(explorationCount > 0, `at least one exploration injection (got ${explorationCount})`);
  assert(ratio >= 0.05 && ratio <= 0.45, `exploration ratio within tolerance (got ${ratio.toFixed(2)})`);

  // Exploration items must come from the unknown category/source.
  const explorationItems = result.slots.filter((s) => s.isExploration);
  const allUnknown = explorationItems.every(
    (s) => s.categoryId === unknownCat || s.sourceId === unknownSrc,
  );
  assert(allUnknown, 'all exploration items come from unfamiliar source/category');
}

// ---------------------------------------------------------------------------
// 5) Negative feedback suppression
// ---------------------------------------------------------------------------
async function testNegativeFeedbackSuppression(): Promise<void> {
  section('5) Negative feedback — hidden/blocked/disliked disappear fast');
  const userId = 'u5';
  const sportsCat = 'cat-sports';
  const espn = 'src-espn';
  const wapo = 'src-wapo';
  const now = new Date('2026-05-18T12:00:00Z');
  const vec = buildInterestVector(
    userId,
    [
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'seed',
        sourceId: espn,
        categoryId: sportsCat,
        happenedAt: now,
        dwellMs: 30_000,
      },
    ],
    { now: () => now },
  );

  const cands: RankableArticle[] = [
    { articleId: 'a-hidden', sourceId: espn, categoryId: sportsCat, globalScore: 100, publishedAt: now },
    { articleId: 'a-disliked', sourceId: espn, categoryId: sportsCat, globalScore: 90, publishedAt: now },
    { articleId: 'a-blocked-src', sourceId: wapo, categoryId: sportsCat, globalScore: 80, publishedAt: now },
    { articleId: 'a-ok', sourceId: espn, categoryId: sportsCat, globalScore: 70, publishedAt: now },
    { articleId: 'a-fast-scroll', sourceId: espn, categoryId: sportsCat, globalScore: 95, publishedAt: now },
  ];

  const negatives = {
    hiddenArticleIds: new Set(['a-hidden']),
    blockedSourceIds: new Set([wapo]),
    mutedCategoryIds: new Set<string>(),
    dislikedArticleIds: new Set(['a-disliked']),
    fastScrollArticleIds: new Set(['a-fast-scroll']),
  };

  const result = rankForUser(vec, cands, negatives, new Set(), {
    limit: 10,
    explorationRatio: 0,
    random: seededRandom(1),
    now: () => now,
  });

  const ids = result.slots.map((s) => s.articleId);
  assert(!ids.includes('a-hidden'), 'hidden article suppressed');
  assert(!ids.includes('a-disliked'), 'disliked article suppressed');
  assert(!ids.includes('a-blocked-src'), 'blocked-source article suppressed');
  assert(ids.includes('a-ok'), 'unaffected article surfaces');
  // Fast-scroll is soft: still present but its affinity weight halves.
  const fast = result.slots.find((s) => s.articleId === 'a-fast-scroll');
  const ok = result.slots.find((s) => s.articleId === 'a-ok');
  assert(!!fast, 'fast-scroll article still surfaces (soft signal)');
  assert(
    fast && ok && fast.affinityWeight <= ok.affinityWeight,
    'fast-scroll article got reduced affinity weight',
  );
  assert(result.suppressedCount === 3, `3 articles hard-suppressed (got ${result.suppressedCount})`);
}

// ---------------------------------------------------------------------------
// 6) Selective refresh scaling (100k users — no global storm)
// ---------------------------------------------------------------------------
async function testSelectivePersonalizedRefresh(): Promise<void> {
  section('6) Selective personalized refresh at 100k users — no global storm');
  const fake = createFakeSupabase();
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('personalization_v1', true);
  fake._setFlag('ranking_v1', true);
  fake._seedCategory({ id: randomUUID(), slug: 'uncategorized' });

  // Seed 100k users + a small global candidate set.
  const USERS = 100_000;
  const userIds = Array.from({ length: USERS }, () => randomUUID());
  const globalArticles = Array.from({ length: 50 }, (_, i) => ({
    article_id: `g-${i}`,
    source_id: i % 5 === 0 ? 'src-a' : 'src-b',
    category_id: i % 3 === 0 ? 'cat-x' : 'cat-y',
    global_score: 100 - i,
    published_at: new Date(),
  }));
  fake._seedPersonalizationData({ globalArticles, affinities: [
    // Only the FIRST user gets an affinity row and a refresh trigger;
    // the other 99,999 must NOT be touched.
    { user_id: userIds[0], category_id: 'cat-x', score: 0.8 },
    { user_id: userIds[0], source_id: 'src-a', score: 0.6 },
  ] });

  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);
  const processor = createRankingProcessor({
    supabase: fake,
    log,
    normalizer,
    isPersonalizationEnabled: async () => true,
    isRankingEnabled: async () => true,
  });

  // Drive ONE refresh job for ONE user.
  const job: LeasedJob = {
    id: randomUUID(),
    job_type: 'refresh_personalized_feed',
    payload: { user_id: userIds[0], limit: 20 },
    attempts: 1,
    lease_token: 'tok',
    leased_until: new Date().toISOString(),
  };
  const t0 = Date.now();
  const res = await processor(job);
  const elapsedMs = Date.now() - t0;

  assert(res.status === 'success', 'single-user refresh succeeded');
  const sliceForUser0 = fake._personalizedFeedRows(userIds[0]);
  assert(sliceForUser0.length === 20, `user 0 got slice of 20 (got ${sliceForUser0.length})`);
  const totalRows = fake._personalizedFeedRows().length;
  assert(totalRows === 20, `total personalized rows == 20 (got ${totalRows}) — no other user touched`);
  assert(elapsedMs < 5_000, `selective refresh completed quickly (${elapsedMs}ms)`);

  // Sanity: an untouched user has no slice.
  const sliceForOther = fake._personalizedFeedRows(userIds[1000]);
  assert(sliceForOther.length === 0, 'untouched user has no personalized slice');
}

// ---------------------------------------------------------------------------
// 7) Notification-open feedback loop
// ---------------------------------------------------------------------------
async function testNotificationOpenFeedback(): Promise<void> {
  section('7) Notification-open feedback loop — opens boost, ignores decay');
  const userId = 'u7';
  const cat = 'cat-news';
  const src = 'src-newsera';
  const now = new Date('2026-05-18T12:00:00Z');

  const openOnly: RawSignal[] = Array.from({ length: 6 }, (_, i) => ({
    kind: 'notification_open' as const,
    userId,
    articleId: `art-${i}`,
    sourceId: src,
    categoryId: cat,
    happenedAt: new Date(now.getTime() - i * 3_600_000),
  }));
  const ignoreOnly: RawSignal[] = Array.from({ length: 6 }, (_, i) => ({
    kind: 'notification_ignore' as const,
    userId,
    articleId: `art-${i}`,
    sourceId: src,
    categoryId: cat,
    happenedAt: new Date(now.getTime() - i * 3_600_000),
  }));

  const opens = buildInterestVector(userId, openOnly, { now: () => now, normalize: false });
  const ignores = buildInterestVector(userId, ignoreOnly, { now: () => now, normalize: false });

  const openScore = opens.categoryAffinity.get(cat) ?? 0;
  const ignoreScore = ignores.categoryAffinity.get(cat) ?? 0;
  assert(openScore > 0, `notification_open contributes positive affinity (got ${openScore.toFixed(3)})`);
  assert(ignoreScore < 0, `notification_ignore decays affinity (got ${ignoreScore.toFixed(3)})`);
  assert(openScore > ignoreScore, 'opened > ignored across same article set');
}

// ---------------------------------------------------------------------------
// 8) Fanout chunker — ≤1k recipients per chunk, trace_id preserved
// ---------------------------------------------------------------------------
async function testFanoutChunker(): Promise<void> {
  section('8) Fanout chunker — splits ≤1,000 per chunk, preserves trace_id');
  const fake = createFakeSupabase();
  const log = silentLogger();
  const chunker = createFanoutChunker({ supabase: fake, log });

  // 2,750 recipients → 3 chunks (1000 + 1000 + 750).
  const recipients = Array.from({ length: 2_750 }, () => randomUUID());
  const traceId = 'trace-fanout-test';
  const r = await chunker.chunkAndEmit({
    eventType: 'breaking_news',
    audience: 'category_followers',
    title: 'Big',
    body: 'News',
    recipientUserIds: recipients,
    parentDedupKey: 'dedup-key-x',
    traceId,
  });

  assert(r.ok, 'chunker reports success');
  assert(r.chunkTotal === 3, `3 chunks emitted (got ${r.chunkTotal})`);
  assert(r.jobsEnqueued === 3, `3 jobs enqueued (got ${r.jobsEnqueued})`);
  assert(r.traceId === traceId, 'caller trace_id preserved');

  const chunks = fake._fanoutChunks();
  assert(chunks.length === 3, `3 lineage rows recorded (got ${chunks.length})`);
  assert(
    chunks.every((c) => c.trace_id === traceId),
    'every lineage row carries the same trace_id',
  );
  const sizes = chunks.map((c) => c.recipient_count).sort((a, b) => a - b);
  assert(sizes[0] === 750 && sizes[1] === 1000 && sizes[2] === 1000, `chunk sizes 750/1000/1000 (got ${sizes.join(',')})`);
  assert(
    chunks.every((c) => c.recipient_count <= FANOUT_CHUNK_SIZE),
    'no chunk exceeds FANOUT_CHUNK_SIZE',
  );

  // Re-running with the SAME dedup_key collapses to existing jobs.
  const r2 = await chunker.chunkAndEmit({
    eventType: 'breaking_news',
    audience: 'category_followers',
    title: 'Big',
    body: 'News',
    recipientUserIds: recipients,
    parentDedupKey: 'dedup-key-x',
    traceId,
  });
  assert(r2.ok, 're-run also succeeds');
  // Same chunk dedup keys → enqueue_job returns the same id → no new jobs.
  const totalQueued = fake._byStatus('queued').length;
  assert(totalQueued === 3, `dedup prevented duplicate jobs (queued=${totalQueued})`);
}

// ---------------------------------------------------------------------------
// 9) Push retry tiers
// ---------------------------------------------------------------------------
async function testPushRetryTiers(): Promise<void> {
  section('9) Push retry tiers — immediate / +30s / +5min / dead-letter');
  assert(RETRY_DELAYS_SEC[0] === 0, 'tier 1 = immediate');
  assert(RETRY_DELAYS_SEC[1] === 30, 'tier 2 = +30s');
  assert(RETRY_DELAYS_SEC[2] === 300, 'tier 3 = +5min');
  assert(MAX_PUSH_ATTEMPTS === 3, 'hard cap = 3 attempts');

  const now = new Date('2026-05-18T12:00:00Z');
  const justFailedAt = new Date(now.getTime() - 1_000);

  // After 0 attempts → send immediately.
  const d1 = decideRetry({ deliveryId: 'd', attemptsSoFar: 0 }, now);
  assert(d1.action === 'send' && d1.nextAttempt === 1, 'attempt 1: immediate send');

  // After 1 attempt, 1s ago → wait until +30s.
  const d2 = decideRetry({ deliveryId: 'd', attemptsSoFar: 1, lastAttemptAt: justFailedAt }, now);
  assert(d2.action === 'wait' && d2.nextEligibleAt instanceof Date, 'attempt 2 deferred to +30s');

  // After 1 attempt, 31s ago → eligible.
  const d2b = decideRetry({
    deliveryId: 'd',
    attemptsSoFar: 1,
    lastAttemptAt: new Date(now.getTime() - 31_000),
  }, now);
  assert(d2b.action === 'send' && d2b.nextAttempt === 2, 'attempt 2: eligible after 30s');

  // After 2 attempts, 31s ago → still waiting (needs 5min).
  const d3 = decideRetry({
    deliveryId: 'd',
    attemptsSoFar: 2,
    lastAttemptAt: new Date(now.getTime() - 31_000),
  }, now);
  assert(d3.action === 'wait', 'attempt 3 still waiting at 31s');

  // After 2 attempts, 6min ago → eligible.
  const d3b = decideRetry({
    deliveryId: 'd',
    attemptsSoFar: 2,
    lastAttemptAt: new Date(now.getTime() - 6 * 60_000),
  }, now);
  assert(d3b.action === 'send' && d3b.nextAttempt === 3, 'attempt 3 eligible after 5min');

  // After 3 attempts → dead-letter.
  const d4 = decideRetry({
    deliveryId: 'd',
    attemptsSoFar: 3,
    lastAttemptAt: new Date(now.getTime() - 6 * 60_000),
    lastErrorCode: 'TransportFailure',
  }, now);
  assert(d4.action === 'dead_letter', 'max attempts → dead-letter');
  assert(
    d4.reasonCode === PUSH_DEAD_LETTER_REASONS.TRANSPORT_FAILURE,
    `dead-letter reason carries structured code (got ${d4.reasonCode})`,
  );

  // Invalid token after 3 attempts → distinct reason code.
  const d4b = decideRetry({
    deliveryId: 'd',
    attemptsSoFar: 3,
    lastErrorCode: 'DeviceNotRegistered',
  }, now);
  assert(
    d4b.reasonCode === PUSH_DEAD_LETTER_REASONS.INVALID_TOKEN,
    'invalid-token dead-letter has its own reason code',
  );
}

// ---------------------------------------------------------------------------
// 10) Analytics delivery health sink
// ---------------------------------------------------------------------------
async function testAnalyticsDeliveryHealth(): Promise<void> {
  section('10) Analytics delivery health — emit/accept/drop/fail visibility');
  const fake = createFakeSupabase();
  const log = silentLogger();
  const sink = createDeliveryHealthRecorder(fake, log);

  await sink.record('notification_fanout', 'emitted', 10);
  await sink.record('notification_fanout', 'accepted', 9);
  await sink.record('notification_fanout', 'dropped', 1, 'recipient_cap');
  await sink.record('notification_push', 'failed', 2, 'invalid_token');
  await sink.record('notification_push', 'emitted', 100);

  const snap = await sink.snapshot(60);
  const fanout = snap.find((r) => r.sink === 'notification_fanout');
  const push = snap.find((r) => r.sink === 'notification_push');
  assert(fanout && fanout.emitted === 10, `fanout.emitted = 10 (got ${fanout?.emitted})`);
  assert(fanout && fanout.accepted === 9, `fanout.accepted = 9 (got ${fanout?.accepted})`);
  assert(fanout && fanout.dropped === 1, `fanout.dropped = 1 (got ${fanout?.dropped})`);
  assert(push && push.failed === 2, `push.failed = 2 (got ${push?.failed})`);
  assert(push && push.emitted === 100, `push.emitted = 100 (got ${push?.emitted})`);
}

// ---------------------------------------------------------------------------
// 11) Feedback loop session scoring
// ---------------------------------------------------------------------------
async function testFeedbackLoop(): Promise<void> {
  section('11) Feedback loop — session quality + tuning suggestion');
  const t0 = new Date('2026-05-18T12:00:00Z').getTime();
  const goodSession = scoreSession({
    userId: 'u11a',
    sessionId: 's-good',
    feedVariant: 'personalized_v2',
    events: [
      { kind: 'view', dwellMs: 20_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 },
      { kind: 'read_complete', dwellMs: 80_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 20_000 },
      { kind: 'bookmark', dwellMs: 1_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 100_000 },
      { kind: 'view', dwellMs: 10_000, sourceId: 'b', categoryId: 'tech', occurredAt: t0 + 101_000 },
      { kind: 'share', dwellMs: 1_000, sourceId: 'b', categoryId: 'tech', occurredAt: t0 + 110_000 },
      { kind: 'session_end', occurredAt: t0 + 112_000 },
    ],
  });
  assert(!goodSession.bounce, 'long engaged session NOT a bounce');
  assert(goodSession.qualityScore > 0.5, `quality > 0.5 (got ${goodSession.qualityScore.toFixed(3)})`);
  assert(goodSession.diversityScore > 0, 'diversity > 0 across multiple sources');

  const bounce = scoreSession({
    userId: 'u11b',
    sessionId: 's-bounce',
    feedVariant: 'personalized_v2',
    events: [
      { kind: 'view', dwellMs: 1_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 },
      { kind: 'session_end', occurredAt: t0 + 1_000 },
    ],
  });
  assert(bounce.bounce, 'sub-5s session is a bounce');
  assert(bounce.qualityScore < goodSession.qualityScore, 'bounce session scores lower');

  // Negative-heavy session
  const bad = scoreSession({
    userId: 'u11c',
    sessionId: 's-bad',
    feedVariant: 'personalized_v2',
    events: [
      { kind: 'view', dwellMs: 4_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 },
      { kind: 'hide', sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 4_000 },
      { kind: 'view', dwellMs: 3_000, sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 5_000 },
      { kind: 'reaction_dislike', sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 8_000 },
      { kind: 'fast_scroll', sourceId: 'a', categoryId: 'sports', occurredAt: t0 + 9_000 },
      { kind: 'session_end', occurredAt: t0 + 10_000 },
    ],
  });
  assert(bad.qualityScore < 0.4, `negative-heavy session scores low (got ${bad.qualityScore.toFixed(3)})`);

  // Suggestion engine — high-bounce batch should propose freshness ↓
  const samples = [bounce, bounce, bounce, bad, bad, bounce, goodSession];
  const suggestion = suggestWeightAdjustments(samples);
  assert(suggestion.freshnessHalfLifeHoursDelta <= 0, 'high-bounce → freshness half-life down');
  assert(suggestion.reason.includes('bounce_rate'), 'suggestion reason mentions bounce rate');
}

// ---------------------------------------------------------------------------
// 12) Flag OFF — structured skip
// ---------------------------------------------------------------------------
async function testFlagOffStructuredSkip(): Promise<void> {
  section('12) Flag OFF — personalization processors structured-skip safely');
  const fake = createFakeSupabase();
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('personalization_v1', false);
  fake._setFlag('ranking_v1', false);
  fake._seedCategory({ id: randomUUID(), slug: 'uncategorized' });
  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);

  const processor = createRankingProcessor({
    supabase: fake,
    log,
    normalizer,
    isPersonalizationEnabled: async () => false,
    isRankingEnabled: async () => false,
  });

  const affJob: LeasedJob = {
    id: randomUUID(),
    job_type: 'recompute_user_affinity',
    payload: { user_id: 'u12' },
    attempts: 1,
    lease_token: 't',
    leased_until: new Date().toISOString(),
  };
  const refreshJob: LeasedJob = {
    id: randomUUID(),
    job_type: 'refresh_personalized_feed',
    payload: { user_id: 'u12' },
    attempts: 1,
    lease_token: 't',
    leased_until: new Date().toISOString(),
  };

  const rAff = await processor(affJob);
  const rRef = await processor(refreshJob);
  assert(rAff.status === 'skipped', 'recompute_user_affinity skipped when flag off');
  assert(
    rAff.status === 'skipped' && rAff.detail?.status === 'skipped_feature_flag',
    'structured skip detail on affinity job',
  );
  assert(rRef.status === 'skipped', 'refresh_personalized_feed skipped when ranking flag off');
  assert(
    rRef.status === 'skipped' && rRef.detail?.flag === 'ranking_v1',
    'skip detail names the ranking_v1 flag',
  );

  // Analytics processor — unknown job types still degrade to phase B stub.
  const analytics = createAnalyticsProcessor({ log, supabase: fake });
  const unknownJob: LeasedJob = {
    id: randomUUID(),
    job_type: 'unknown_job',
    payload: {},
    attempts: 1,
    lease_token: 't',
    leased_until: new Date().toISOString(),
  };
  const rUnk = await analytics(unknownJob);
  assert(rUnk.status === 'skipped', 'unknown analytics job acknowledged (no DLQ pressure)');
}

// ---------------------------------------------------------------------------
// 13) Interest shift detection
// ---------------------------------------------------------------------------
async function testInterestShiftDetection(): Promise<void> {
  section('13) Interest shift detection drives selective refresh');
  const userId = 'u13';
  const now = new Date('2026-05-18T12:00:00Z');
  const prev = buildInterestVector(
    userId,
    [
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'a',
        sourceId: 's1',
        categoryId: 'cat-old',
        happenedAt: now,
        dwellMs: 30_000,
      },
    ],
    { now: () => now },
  );
  // Big shift — different category dominates
  const nextVec = buildInterestVector(
    userId,
    [
      {
        kind: 'article_read_complete',
        userId,
        articleId: 'b',
        sourceId: 's2',
        categoryId: 'cat-new',
        happenedAt: now,
        dwellMs: 30_000,
      },
      {
        kind: 'share',
        userId,
        articleId: 'c',
        sourceId: 's2',
        categoryId: 'cat-new',
        happenedAt: now,
        dwellMs: 0,
      },
    ],
    { now: () => now },
  );
  const shift = diffInterestVectors(prev, nextVec, 0.35);
  assert(shift.isStrong, 'strong interest shift detected');
  // No shift case
  const same = diffInterestVectors(prev, prev, 0.35);
  assert(!same.isStrong, 'identical vectors → no strong shift');
  // Null previous → strong shift (cold start)
  const cold = diffInterestVectors(null, nextVec, 0.35);
  assert(cold.isStrong, 'cold-start counted as strong shift');
}

// ---------------------------------------------------------------------------
// 14) Aggregation: weights → buckets sanity
// ---------------------------------------------------------------------------
async function testAggregateSanity(): Promise<void> {
  section('14) Signal aggregation produces deterministic bucket scores');
  const now = new Date('2026-05-18T12:00:00Z');
  const userId = 'agg-user';
  const { signals } = normalizeSignals(
    [
      { kind: 'share', userId, articleId: 'x', sourceId: 's', categoryId: 'c', happenedAt: now, dwellMs: 0 },
      { kind: 'bookmark', userId, articleId: 'y', sourceId: 's', categoryId: 'c', happenedAt: now, dwellMs: 0 },
    ],
    { now: () => now },
  );
  const agg = aggregateSignals(signals, { now: () => now, halfLifeDays: 14 });
  assert((agg.byCategory.get('c') ?? 0) > 0, 'category bucket populated');
  assert((agg.bySource.get('s') ?? 0) > 0, 'source bucket populated');
  // share=6 + bookmark=4 → 10
  assert(
    Math.abs((agg.byCategory.get('c') ?? 0) - 10) < 0.01,
    `share + bookmark today → score ≈ 10 (got ${(agg.byCategory.get('c') ?? 0).toFixed(3)})`,
  );
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await testSignalsAndDecay();
  await testInterestAdaptation();
  await testDiversityEnforcement();
  await testExplorationInjection();
  await testNegativeFeedbackSuppression();
  await testSelectivePersonalizedRefresh();
  await testNotificationOpenFeedback();
  await testFanoutChunker();
  await testPushRetryTiers();
  await testAnalyticsDeliveryHealth();
  await testFeedbackLoop();
  await testFlagOffStructuredSkip();
  await testInterestShiftDetection();
  await testAggregateSanity();

  // eslint-disable-next-line no-console
  console.log('');
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('All personalization simulations passed.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('personalization simulation crashed:', err);
  process.exit(1);
});
