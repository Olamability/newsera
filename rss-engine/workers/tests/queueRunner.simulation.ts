/**
 * Phase B — Queue runner simulation harness.
 *
 * Runs the four scenarios mandated by the problem statement:
 *
 *   1. Queue flood test           — 10,000 queued jobs, system stays up,
 *                                   backpressure must activate.
 *   2. Mixed job execution test   — ingestion + ranking + stub notifications
 *                                   route to the right processor.
 *   3. Failure recovery test      — forced processor failure → retry +
 *                                   eventual DLQ via `fail_job`.
 *   4. Category normalization     — missing/invalid category inputs always
 *                                   resolve safely (or surface failure when
 *                                   even the fallback is missing).
 *
 * Run with:  pnpm --filter @newsera/rss-engine test:queue
 *            (or)  npx tsx workers/tests/queueRunner.simulation.ts
 *
 * Exits non-zero on any assertion failure so the script is CI-safe.
 */

import { randomUUID } from 'node:crypto';

import { createBackpressureController, deriveBackpressure } from '../lib/backpressure';
import { createLogger } from '../lib/logger';
import { createCategoryNormalizer } from '../lib/normalizeCategory';
import { createAnalyticsProcessor } from '../lib/processors/analytics';
import { createIngestionProcessor } from '../lib/processors/ingestion';
import { createNotificationProcessor } from '../lib/processors/notification';
import { createRankingProcessor } from '../lib/processors/ranking';
import { createQueueRunner } from '../lib/runner';
import type { Processor, QueueConfig, QueueName } from '../lib/types';

import { createFakeSupabase } from './fakeSupabase';

// ---------------------------------------------------------------------------
// Tiny assertion helpers — keep this script free of test-framework deps.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Silent logger — tests are noisy enough already.
// ---------------------------------------------------------------------------

function silentLogger() {
  return ((): void => {
    /* swallow */
  }) as unknown as ReturnType<typeof createLogger>;
}

// Use a config tuned for the flood test — small thresholds so we see
// backpressure engage quickly with realistic numbers.
function testConfigs(): Map<QueueName, QueueConfig> {
  const c = new Map<QueueName, QueueConfig>();
  c.set('ingestion', {
    name: 'ingestion',
    baseConcurrency: 5,
    baseBatchSize: 5,
    leaseSeconds: 60,
    idlePollMs: 10,
    activePollMs: 1,
    backpressureThreshold: 100,
    enabled: true,
  });
  c.set('ranking', {
    name: 'ranking',
    baseConcurrency: 10,
    baseBatchSize: 10,
    leaseSeconds: 60,
    idlePollMs: 10,
    activePollMs: 1,
    backpressureThreshold: 100,
    enabled: true,
  });
  c.set('notification', {
    name: 'notification',
    baseConcurrency: 20,
    baseBatchSize: 20,
    leaseSeconds: 60,
    idlePollMs: 10,
    activePollMs: 1,
    backpressureThreshold: 1000,
    enabled: true, // turn ON for routing test (flag still gates real send)
  });
  c.set('analytics', {
    name: 'analytics',
    baseConcurrency: 2,
    baseBatchSize: 2,
    leaseSeconds: 60,
    idlePollMs: 10,
    activePollMs: 1,
    backpressureThreshold: 1000,
    enabled: false,
  });
  return c;
}

// ---------------------------------------------------------------------------
// Shared bootstrap
// ---------------------------------------------------------------------------

interface Harness {
  fake: ReturnType<typeof createFakeSupabase>;
  runner: ReturnType<typeof createQueueRunner>;
}

function buildHarness(opts: {
  seedCategory?: boolean;
  notificationFlagOn?: boolean;
} = {}): Harness {
  const fake = createFakeSupabase();
  const categoryId = randomUUID();
  if (opts.seedCategory !== false) {
    fake._seedCategory({ id: categoryId, slug: 'uncategorized' });
  }
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('backend_notification_dispatch', Boolean(opts.notificationFlagOn));

  const log = silentLogger();
  const configs = testConfigs();
  const normalizer = createCategoryNormalizer(fake, log);
  const backpressure = createBackpressureController(fake, configs, log, {
    sampleIntervalMs: 1,
  });

  const processors = new Map<QueueName, Processor>();
  processors.set('ingestion', createIngestionProcessor({ supabase: fake, log, normalizer }));
  processors.set('ranking', createRankingProcessor({ supabase: fake, log, normalizer }));
  processors.set(
    'notification',
    createNotificationProcessor({
      supabase: fake,
      log,
      normalizer,
      isDispatchEnabled: async () => Boolean(opts.notificationFlagOn),
    }),
  );
  processors.set('analytics', createAnalyticsProcessor({ log }));

  const runner = createQueueRunner({
    workerId: 'test-runner',
    supabase: fake,
    log,
    processors,
    configs,
    backpressure,
    jobTimeoutMs: 5_000,
    heartbeatIntervalMs: 1_000,
  });

  return { fake, runner };
}

// ---------------------------------------------------------------------------
// 1) Queue flood test
// ---------------------------------------------------------------------------

async function testQueueFlood(): Promise<void> {
  section('1) Queue flood — 10,000 ingestion jobs');
  const { fake, runner } = buildHarness();

  // Seed 10k jobs of a known-good type.
  const FLOOD = 10_000;
  fake._seedJobs(FLOOD, {
    queue_name: 'ingestion',
    job_type: 'reingest_feed',
    payload: { feed_id: randomUUID() },
  });
  // Make `reset_feed_for_reingest` instantaneous.
  fake._setOverrides({
    reset_feed_for_reingest: async () => ({ data: null, error: null }),
  });

  assert(fake._byStatus('queued').length === FLOOD, `seeded ${FLOOD} jobs`);

  // Force depth to 10k so backpressure controller sees the flood.
  fake._setDepth('ingestion', FLOOD);

  // Drive a single runOnce — verify backpressure engaged and concurrency
  // collapsed to the drain-mode value (=1) without crashing.
  const first = await runner.runOnce('ingestion');
  assert(first.leased > 0, 'leased at least one job under backpressure');

  // Inspect controller snapshot post-sample.
  const policy = deriveBackpressure(
    {
      name: 'ingestion',
      baseConcurrency: 5,
      baseBatchSize: 5,
      leaseSeconds: 60,
      idlePollMs: 10,
      activePollMs: 1,
      backpressureThreshold: 100,
      enabled: true,
    },
    FLOOD,
  );
  assert(policy.active === true, 'backpressure marked active at depth 10000');
  assert(policy.concurrency === 1, 'concurrency collapsed to 1 in drain mode');
  assert(policy.pollIntervalMs >= 80, 'poll interval widened in drain mode');

  // Drain the queue and confirm no crash + every job terminates.
  let cycles = 0;
  const cycleCap = FLOOD + 500;
  while (cycles < cycleCap && fake._byStatus('queued').length > 0) {
    // Reduce reported depth as we drain so backpressure eventually releases.
    fake._setDepth('ingestion', fake._byStatus('queued').length);
    // eslint-disable-next-line no-await-in-loop
    await runner.runOnce('ingestion');
    cycles += 1;
  }

  const successes = fake._byStatus('success').length;
  const dead = fake._byStatus('dead').length;
  assert(successes + dead === FLOOD, `all ${FLOOD} jobs terminated (success+dead)`);
  assert(dead === 0, 'no jobs escaped to DLQ on the happy path');
  assert(fake._byStatus('queued').length === 0, 'queue fully drained');
}

// ---------------------------------------------------------------------------
// 2) Mixed job execution test
// ---------------------------------------------------------------------------

async function testMixedRouting(): Promise<void> {
  section('2) Mixed job routing — ingestion + ranking + notification(off)');
  const { fake, runner } = buildHarness({ notificationFlagOn: false });

  let rankingCalls = 0;
  let recategorizeCalls = 0;
  fake._setOverrides({
    refresh_ranked_feeds: async () => {
      rankingCalls += 1;
      return { data: null, error: null };
    },
    apply_article_categorization: async () => {
      recategorizeCalls += 1;
      return { data: null, error: null };
    },
  });

  // Mix of three.
  fake._seedJobs(3, {
    queue_name: 'ingestion',
    job_type: 'recategorize_article',
    payload: { article_id: randomUUID() }, // no suggested category → uses fallback
  });
  fake._seedJobs(2, {
    queue_name: 'ranking',
    job_type: 'refresh_ranked_feeds',
    payload: { trace_id: 'trace-mixed' },
  });
  fake._seedJobs(4, {
    queue_name: 'notification',
    job_type: 'send_push',
    payload: { user_id: randomUUID() },
  });

  await runner.runOnce('ingestion');
  await runner.runOnce('ranking');
  await runner.runOnce('notification');

  assert(recategorizeCalls === 3, 'ingestion processor invoked 3 times');
  assert(rankingCalls === 2, 'ranking processor invoked 2 times');
  assert(
    fake._byStatus('success').length === 9,
    'all 9 jobs marked success (notifications skipped → complete)',
  );
  assert(fake._byStatus('dead').length === 0, 'no jobs reached DLQ');
  // Notification jobs should have been completed (skipped status) not failed.
  const notifications = fake._jobs().filter((j) => j.queue_name === 'notification');
  assert(
    notifications.every((j) => j.status === 'success'),
    'notification jobs acknowledged (flag-off skip path)',
  );
}

// ---------------------------------------------------------------------------
// 3) Failure recovery test
// ---------------------------------------------------------------------------

async function testFailureRecovery(): Promise<void> {
  section('3) Failure recovery — retry + exponential backoff + DLQ');
  const { fake, runner } = buildHarness();

  let calls = 0;
  fake._setOverrides({
    refresh_ranked_feeds: async () => {
      calls += 1;
      // Always fail. Should bounce through retries (max_attempts=3) then DLQ.
      return { data: null, error: { message: 'simulated_failure' } };
    },
  });

  const [job] = fake._seedJobs(1, {
    queue_name: 'ranking',
    job_type: 'refresh_ranked_feeds',
    max_attempts: 3,
    payload: {},
  });

  // First cycle — attempt 1 fails, job goes back to 'queued' with backoff.
  await runner.runOnce('ranking');
  const afterFirst = fake._jobs().find((j) => j.id === job.id);
  assert(afterFirst?.status === 'queued', 'job re-queued after first failure');
  assert((afterFirst?.attempts ?? 0) === 1, 'attempts counter incremented to 1');
  assert(
    (afterFirst?.next_attempt_at ?? 0) > Date.now(),
    'next_attempt_at set in the future (backoff)',
  );

  // Bypass backoff by yanking next_attempt_at into the past.
  function flush(): void {
    for (const j of fake._jobs()) j.next_attempt_at = Date.now() - 1;
  }

  // Second attempt → still failing → re-queued (attempt 2).
  flush();
  await runner.runOnce('ranking');
  const afterSecond = fake._jobs().find((j) => j.id === job.id);
  assert(afterSecond?.status === 'queued', 'job re-queued after second failure');
  assert((afterSecond?.attempts ?? 0) === 2, 'attempts counter incremented to 2');

  // Third attempt → max_attempts reached → DLQ.
  flush();
  await runner.runOnce('ranking');
  const afterThird = fake._jobs().find((j) => j.id === job.id);
  assert(afterThird?.status === 'dead', 'job dead-lettered after max attempts');
  assert(fake._dlq().length === 1, 'DLQ row created');
  assert(fake._dlq()[0].original_job_id === job.id, 'DLQ row references original job');
  assert(calls === 3, 'processor invoked exactly max_attempts times');
}

// ---------------------------------------------------------------------------
// 4) Category normalization test
// ---------------------------------------------------------------------------

async function testCategoryNormalization(): Promise<void> {
  section('4) Category normalization — fallback always safe');
  // Build with seeded uncategorized.
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  const realId = randomUUID();
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  fake._seedCategory({ id: realId, slug: 'tech' });

  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);

  // 4a) null
  const a = await normalizer.normalize(null);
  assert(a.categoryId === fallbackId, 'null → fallback id');
  assert(a.usedFallback === true && a.reason === 'fallback_missing_input', 'null reason correct');

  // 4b) empty string
  const b = await normalizer.normalize('');
  assert(b.categoryId === fallbackId, 'empty → fallback id');

  // 4c) garbage
  const c = await normalizer.normalize('not-a-uuid');
  assert(c.categoryId === fallbackId, 'garbage → fallback id');
  assert(c.reason === 'fallback_invalid_input', 'garbage reason correct');

  // 4d) valid uuid that does not exist in `categories`
  const d = await normalizer.normalize(randomUUID());
  assert(d.categoryId === fallbackId, 'unknown uuid → fallback id');
  assert(d.reason === 'fallback_invalid_input', 'unknown uuid reason correct');

  // 4e) valid known uuid
  const e = await normalizer.normalize(realId);
  assert(e.categoryId === realId, 'valid known uuid passes through');
  assert(e.usedFallback === false && e.reason === 'valid', 'valid reason correct');

  // 4f) cache hit on second call (no DB error path)
  const f = await normalizer.normalize(realId);
  assert(f.categoryId === realId && f.resolved, 'cache hit on second valid call');

  // 4g) when fallback itself missing → resolved=false
  const fake2 = createFakeSupabase();
  const norm2 = createCategoryNormalizer(fake2, log);
  const g = await norm2.normalize(null);
  assert(g.resolved === false && g.reason === 'fallback_unavailable', 'fallback_unavailable surfaced');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testQueueFlood();
  await testMixedRouting();
  await testFailureRecovery();
  await testCategoryNormalization();

  // eslint-disable-next-line no-console
  console.log('');
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('All simulations passed.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('simulation crashed:', err);
  process.exit(1);
});
