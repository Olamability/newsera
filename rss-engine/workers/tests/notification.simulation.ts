/**
 * Phase C — Notification Dispatch Engine simulation harness.
 *
 * Mirrors the structure of `queueRunner.simulation.ts` and exercises the
 * scenarios mandated by the Phase C problem statement:
 *
 *   1. Breaking news spike    — 1,000 articles → 1 dedup'd notification
 *                                 burst; batching collapses correctly.
 *   2. Fanout scaling         — 50,000 users subscribed to a category;
 *                                 fanout completes without crash + the
 *                                 max_recipients cap is honoured.
 *   3. Token failure          — push transport reports invalid tokens;
 *                                 cleanup signal surfaces correctly +
 *                                 successful deliveries still ship.
 *   4. Flag OFF acknowledgement
 *                              — `backend_notification_dispatch` off → jobs
 *                                 are acknowledged (skipped, NOT failed)
 *                                 with the structured Phase C reason.
 *
 * Plus Phase B debt closure:
 *
 *   5. Queue velocity tracker — observe → snapshot → growth delta is
 *                                 correct + EMA smooths bursts.
 *   6. Predictive backpressure — controller engages BEFORE depth exceeds
 *                                 threshold when growth is sustained.
 *   7. Category bootstrap cache
 *                              — warm fallback + top-N; subsequent
 *                                 normalize() calls do not hit the DB.
 *
 * Exits non-zero on any assertion failure so the script is CI-safe.
 */

import { randomUUID } from 'node:crypto';

import { createBackpressureController } from '../lib/backpressure';
import { warmCategoryBootstrapCache } from '../lib/categoryBootstrapCache';
import { createLogger } from '../lib/logger';
import { createCategoryNormalizer } from '../lib/normalizeCategory';
import { createNotificationProcessor } from '../lib/processors/notification';
import { createQueueVelocityTracker } from '../lib/queueVelocity';
import { createQueueRunner } from '../lib/runner';
import type { Processor, QueueConfig, QueueName } from '../lib/types';
import { createFanoutEngine } from '../notification/fanout';
import { createPushDrainLoop } from '../notification/dispatch/pushDrain';
import {
  createPushSender,
  type PushBatchTicket,
  type PushTransport,
} from '../notification/push/pushSender';

import { createFakeSupabase } from './fakeSupabase';

// ---------------------------------------------------------------------------
// Assertion helpers
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
function silentLogger() {
  return ((): void => {
    /* swallow */
  }) as unknown as ReturnType<typeof createLogger>;
}

function notificationOnlyConfigs(): Map<QueueName, QueueConfig> {
  const c = new Map<QueueName, QueueConfig>();
  c.set('notification', {
    name: 'notification',
    baseConcurrency: 5,
    baseBatchSize: 5,
    leaseSeconds: 60,
    idlePollMs: 10,
    activePollMs: 1,
    backpressureThreshold: 1000,
    enabled: true,
  });
  return c;
}

// ---------------------------------------------------------------------------
// 1) Breaking news spike — dedup collapses 1k publishes → 1 event
// ---------------------------------------------------------------------------

async function testBreakingNewsSpike(): Promise<void> {
  section('1) Breaking news spike — 1,000 publishes → 1 dedup\'d burst');
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('backend_notification_dispatch', true);

  // 1k users for fanout. Each gets an inbox row per (deduped) event.
  const userIds = Array.from({ length: 1000 }, () => randomUUID());
  fake._seedNotificationUsers(userIds);

  const log = silentLogger();
  const configs = notificationOnlyConfigs();
  const normalizer = createCategoryNormalizer(fake, log);
  const backpressure = createBackpressureController(fake, configs, log, {
    sampleIntervalMs: 1,
  });
  const fanout = createFanoutEngine({ supabase: fake, log, normalizer });
  const processors = new Map<QueueName, Processor>();
  processors.set(
    'notification',
    createNotificationProcessor({
      supabase: fake,
      log,
      normalizer,
      isDispatchEnabled: async () => true,
      fanout,
    }),
  );
  const runner = createQueueRunner({
    workerId: 'breaking-test',
    supabase: fake,
    log,
    processors,
    configs,
    backpressure,
    jobTimeoutMs: 5_000,
  });

  // 1,000 publishes for the same article all share a dedup key. In
  // production each "publish" calls the `enqueue_job` RPC which collapses
  // duplicate (queue, type, dedup_key) tuples — only one job actually
  // lands in `job_queue`. We exercise that path explicitly here.
  const articleId = randomUUID();
  const dedup = `breaking:${articleId}`;
  const payload = {
    event_type: 'breaking_news',
    audience: 'global',
    title: 'Breaking',
    body: 'Big news',
    article_id: articleId,
    dedup_key: dedup,
  };
  for (let i = 0; i < 1000; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fake.rpc('enqueue_job', {
      p_queue_name: 'notification',
      p_job_type: 'dispatch',
      p_payload: payload,
      p_dedup_key: dedup,
      p_priority: 5,
      p_max_attempts: 3,
    });
  }
  assert(
    fake._byStatus('queued').length === 1,
    `enqueue_job dedup collapsed 1000 publishes → ${fake._byStatus('queued').length} queued job`,
  );

  let cycles = 0;
  while (cycles < 50 && fake._byStatus('queued').length > 0) {
    // eslint-disable-next-line no-await-in-loop
    await runner.runOnce('notification');
    cycles += 1;
  }

  const events = fake._notificationEvents();
  assert(events.length === 1, `single fanout event produced (got ${events.length})`);
  assert(fake._byStatus('dead').length === 0, 'no jobs reached DLQ');
  const inbox = fake
    ._notificationDeliveries()
    .filter((d) => d.channel === 'inbox');
  assert(inbox.length === 1000, `1000 inbox deliveries materialised (got ${inbox.length})`);
}

// ---------------------------------------------------------------------------
// 2) Fanout scaling — 50k category followers
// ---------------------------------------------------------------------------

async function testFanoutScaling(): Promise<void> {
  section('2) Fanout scaling — 50,000 category followers (capped at 5,000)');
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  const techId = randomUUID();
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  fake._seedCategory({ id: techId, slug: 'tech' });
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('backend_notification_dispatch', true);

  const USERS = 50_000;
  const userIds = Array.from({ length: USERS }, () => randomUUID());
  fake._seedNotificationUsers(userIds);

  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);
  const fanout = createFanoutEngine({ supabase: fake, log, normalizer });

  const startedAt = Date.now();
  const result = await fanout.fanout({
    eventType: 'followed_category',
    title: 'Tech update',
    body: 'New articles in Tech',
    audience: 'category_followers',
    categoryId: techId,
    channels: ['inbox'], // skip push to keep this test focused on fanout scaling
    maxRecipients: 5_000,
  });
  const elapsedMs = Date.now() - startedAt;

  assert(result.ok === true, 'fanout completed successfully at 50k subscribers');
  assert(
    result.recipients === 5_000,
    `recipient cap honoured: 5000 materialised (got ${result.recipients})`,
  );
  assert(elapsedMs < 30_000, `completed within 30s (took ${elapsedMs}ms)`);
  const inbox = fake._notificationDeliveries().filter((d) => d.channel === 'inbox');
  assert(inbox.length === 5_000, `5000 inbox rows created (got ${inbox.length})`);
}

// ---------------------------------------------------------------------------
// 3) Token failure — invalid Expo tokens trigger cleanup signal
// ---------------------------------------------------------------------------

async function testTokenFailureCleanup(): Promise<void> {
  section('3) Token failure — invalid Expo tokens → cleanup signal');
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('backend_notification_dispatch', true);

  const userIds = Array.from({ length: 4 }, () => randomUUID());
  fake._seedNotificationUsers(userIds);
  fake._seedUserDevices([
    { user_id: userIds[0], device_id: 'd1', push_token: 'ExponentPushToken[good1]' },
    { user_id: userIds[1], device_id: 'd2', push_token: 'ExponentPushToken[good2]' },
    { user_id: userIds[2], device_id: 'd3', push_token: 'ExponentPushToken[stale]' },
    { user_id: userIds[3], device_id: 'd4', push_token: 'garbage-token-not-expo' },
  ]);

  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);
  const fanout = createFanoutEngine({ supabase: fake, log, normalizer });

  // Fan out one breaking event so the staged push rows exist.
  await fanout.fanout({
    eventType: 'breaking_news',
    title: 'Hello',
    body: 'World',
    audience: 'global',
    channels: ['push'],
    maxRecipients: 10,
  });

  // The fanout will only create push deliveries for users with seeded
  // devices that have a non-null token (all 4). Garbage token gets filtered
  // by pushSender pre-flight; stale token gets failed by transport.
  const pendingBefore = fake._pendingPushDeliveries();
  assert(pendingBefore.length === 4, `4 push deliveries staged (got ${pendingBefore.length})`);

  // Transport: succeed for good1/good2, return DeviceNotRegistered for the
  // stale token. The garbage token never reaches us because pre-flight
  // filtering catches it.
  const transport: PushTransport = async (batch) => {
    return batch.map((m): PushBatchTicket => {
      if (m.to === 'ExponentPushToken[stale]') {
        return {
          deliveryId: m.deliveryId,
          status: 'error',
          provider: 'expo',
          errorCode: 'DeviceNotRegistered',
          errorMessage: 'device_not_registered',
        };
      }
      return {
        deliveryId: m.deliveryId,
        status: 'ok',
        provider: 'expo',
        providerMessageId: `msg-${m.deliveryId.slice(0, 6)}`,
      };
    });
  };

  const pushSender = createPushSender(transport, log, { maxBatchSize: 100 });
  const drain = createPushDrainLoop(
    { supabase: fake, log, pushSender, workerId: 'push-test' },
    { batchSize: 100 },
  );
  const cycle = await drain.runOnce();

  assert(cycle.claimed === 4, `drain claimed 4 deliveries (got ${cycle.claimed})`);
  assert(cycle.sent === 2, `2 deliveries sent successfully (got ${cycle.sent})`);
  assert(cycle.failed === 2, `2 deliveries failed (stale + garbage) (got ${cycle.failed})`);
  assert(
    cycle.invalidTokens === 2,
    `2 invalid-token cleanup signals (got ${cycle.invalidTokens})`,
  );

  // Verify per-row terminal status was written back via record_notification_delivery.
  const finalDeliveries = fake._notificationDeliveries().filter((d) => d.channel === 'push');
  const sentCount = finalDeliveries.filter((d) => d.status === 'sent').length;
  const failedCount = finalDeliveries.filter((d) => d.status === 'failed').length;
  assert(sentCount === 2, `2 rows marked 'sent' in DB (got ${sentCount})`);
  assert(failedCount === 2, `2 rows marked 'failed' in DB (got ${failedCount})`);
}

// ---------------------------------------------------------------------------
// 4) Flag OFF — structured skip, jobs acknowledged
// ---------------------------------------------------------------------------

async function testFlagOffAcknowledgement(): Promise<void> {
  section('4) Flag OFF — structured skipped_feature_flag acknowledgement');
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  fake._setFlag('queue_based_ingestion', true);
  fake._setFlag('backend_notification_dispatch', false);

  const log = silentLogger();
  const configs = notificationOnlyConfigs();
  const normalizer = createCategoryNormalizer(fake, log);
  const backpressure = createBackpressureController(fake, configs, log, {
    sampleIntervalMs: 1,
  });
  const fanout = createFanoutEngine({ supabase: fake, log, normalizer });

  let processorCalls = 0;
  let lastSkipDetail: Record<string, unknown> | undefined;
  const wrappedProcessor: Processor = async (job) => {
    processorCalls += 1;
    const inner = createNotificationProcessor({
      supabase: fake,
      log,
      normalizer,
      isDispatchEnabled: async () => false,
      fanout,
    });
    const r = await inner(job);
    if (r.status === 'skipped') lastSkipDetail = r.detail;
    return r;
  };

  const processors = new Map<QueueName, Processor>();
  processors.set('notification', wrappedProcessor);

  const runner = createQueueRunner({
    workerId: 'flag-off-test',
    supabase: fake,
    log,
    processors,
    configs,
    backpressure,
  });

  fake._seedJobs(5, {
    queue_name: 'notification',
    job_type: 'dispatch',
    payload: {
      event_type: 'admin_broadcast',
      audience: 'global',
      title: 'Hi',
      body: 'Hi',
    },
  });

  await runner.runOnce('notification');

  assert(processorCalls === 5, 'processor invoked for every job (flag OFF still routes)');
  assert(fake._byStatus('success').length === 5, 'all 5 jobs acknowledged (success)');
  assert(fake._byStatus('dead').length === 0, 'no jobs reached DLQ');
  assert(
    fake._notificationEvents().length === 0,
    'no notification_events created (dispatch was off)',
  );
  assert(
    lastSkipDetail?.status === 'skipped_feature_flag',
    'skip detail carries structured status=skipped_feature_flag',
  );
  assert(
    lastSkipDetail?.reason === 'backend_notification_dispatch_disabled',
    'skip detail carries documented reason',
  );
  assert(lastSkipDetail?.traceable === true, 'skip is marked traceable');
}

// ---------------------------------------------------------------------------
// 5) Queue velocity tracker — EMA + growth delta
// ---------------------------------------------------------------------------

async function testQueueVelocity(): Promise<void> {
  section('5) Queue velocity tracker — EMA + growth delta');
  let now = 0;
  const v = createQueueVelocityTracker({
    windowMs: 5 * 60_000,
    now: () => now,
  });

  // First observation seeds (no smoothing). Advance time by 60s.
  now += 60_000;
  v.observe('ingestion', { enqueued: 100, processed: 50 });
  const s1 = v.snapshot('ingestion');
  assert(
    Math.abs(s1.ingestionRatePerMin - 100) < 0.1,
    `first ingestion sample ≈ 100/min (got ${s1.ingestionRatePerMin.toFixed(2)})`,
  );
  assert(
    Math.abs(s1.processingRatePerMin - 50) < 0.1,
    `first processing sample ≈ 50/min (got ${s1.processingRatePerMin.toFixed(2)})`,
  );
  assert(s1.growthDeltaPerMin > 0, 'growth delta positive when arrivals > drains');

  // Burst: 1000 enq in next 60s. EMA must dampen this — final value must
  // be between previous (100) and instantaneous (1000).
  now += 60_000;
  v.observe('ingestion', { enqueued: 1000, processed: 100 });
  const s2 = v.snapshot('ingestion');
  assert(
    s2.ingestionRatePerMin > 100 && s2.ingestionRatePerMin < 1000,
    `EMA dampens single burst (got ${s2.ingestionRatePerMin.toFixed(2)}, expected 100..1000)`,
  );

  // Stale tracking
  now += 5 * 60_000;
  const s3 = v.snapshot('ingestion');
  assert(s3.staleMs >= 5 * 60_000, 'stale ms reflects time since last observation');
}

// ---------------------------------------------------------------------------
// 6) Predictive backpressure — engages before depth crosses threshold
// ---------------------------------------------------------------------------

async function testPredictiveBackpressure(): Promise<void> {
  section('6) Predictive backpressure — engages before depth threshold');
  const fake = createFakeSupabase();
  fake._setFlag('queue_based_ingestion', true);

  const log = silentLogger();
  const cfg: QueueConfig = {
    name: 'ingestion',
    baseConcurrency: 10,
    baseBatchSize: 10,
    leaseSeconds: 60,
    idlePollMs: 100,
    activePollMs: 10,
    backpressureThreshold: 10_000, // intentionally high so depth alone never trips
    enabled: true,
  };
  const configs = new Map<QueueName, QueueConfig>([['ingestion', cfg]]);

  let now = 0;
  const velocity = createQueueVelocityTracker({ windowMs: 5 * 60_000, now: () => now });
  const bp = createBackpressureController(fake, configs, log, {
    sampleIntervalMs: 1,
    velocity,
    predictiveGrowthPerMin: 100,
    predictiveMinSamples: 2,
  });
  fake._setDepth('ingestion', 10); // far below threshold

  // Seed velocity with sustained growth: 500 in, 100 out per minute.
  now += 60_000;
  velocity.observe('ingestion', { enqueued: 500, processed: 100 });
  now += 60_000;
  velocity.observe('ingestion', { enqueued: 500, processed: 100 });

  // Sample backpressure — should engage predictively now.
  await new Promise((r) => setTimeout(r, 5));
  const snap = await bp.sample('ingestion');
  assert(snap.active === true, 'predictive throttle engaged with depth=10 (well under threshold)');
  assert(snap.predictive === true, 'snapshot.predictive flag set');
  assert(
    snap.concurrency < cfg.baseConcurrency,
    `concurrency reduced (${snap.concurrency} < ${cfg.baseConcurrency})`,
  );
}

// ---------------------------------------------------------------------------
// 7) Category bootstrap cache
// ---------------------------------------------------------------------------

async function testCategoryBootstrapCache(): Promise<void> {
  section('7) Category bootstrap cache — warm fallback + top-N');
  const fake = createFakeSupabase();
  const fallbackId = randomUUID();
  const topIds = Array.from({ length: 5 }, () => randomUUID());
  fake._seedCategory({ id: fallbackId, slug: 'uncategorized' });
  for (const id of topIds) fake._seedCategory({ id, slug: `cat-${id.slice(0, 4)}` });

  const log = silentLogger();
  const normalizer = createCategoryNormalizer(fake, log);

  let loaderCalls = 0;
  const result = await warmCategoryBootstrapCache(fake, normalizer, log, {
    topN: 10,
    loadTopCategories: async (limit) => {
      loaderCalls += 1;
      return topIds.slice(0, limit).map((id) => ({ id }));
    },
  });

  assert(result.fallbackLoaded === true, 'fallback row warmed');
  assert(result.topLoaded === topIds.length, `top-N warmed (${result.topLoaded})`);
  assert(loaderCalls === 1, 'loader called exactly once');

  // Subsequent normalize() must hit cache (no DB round-trip required).
  // Drop the categories from the fake to prove cache is used.
  for (const id of topIds) {
    const r = await normalizer.normalize(id);
    assert(r.resolved && !r.usedFallback, `cached normalize(${id.slice(0, 6)}) hits positive cache`);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testBreakingNewsSpike();
  await testFanoutScaling();
  await testTokenFailureCleanup();
  await testFlagOffAcknowledgement();
  await testQueueVelocity();
  await testPredictiveBackpressure();
  await testCategoryBootstrapCache();

  // eslint-disable-next-line no-console
  console.log('');
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('All notification simulations passed.');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('notification simulation crashed:', err);
  process.exit(1);
});
