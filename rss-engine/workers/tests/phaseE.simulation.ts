/**
 * Phase E — Production hardening simulation harness.
 *
 * Runs the six scenarios called out in the Phase E "REQUIRED TESTING"
 * section:
 *
 *   1. Worker crash storm           — 50% worker loss; coordinator marks
 *                                     them dead and reclaims their leases.
 *   2. Canary rollback              — health probe degrades and the canary
 *                                     controller rolls back automatically.
 *   3. Personalized cache cleanup   — millions of stale slices; planner
 *                                     stays bounded and enqueues a job.
 *   4. Queue flood                  — 100k pending jobs; autoscaler
 *                                     recommends scale-out; cost monitor
 *                                     flags the breach.
 *   5. Disaster replay              — replay ranking + notifications;
 *                                     dedup prevents user-visible spam.
 *   6. Notification abuse           — spam attempts throttled via traffic
 *                                     guard kill-switch.
 *
 * Run with: pnpm --filter @newsera/rss-engine test:phaseE
 *           (or)  npx tsx workers/tests/phaseE.simulation.ts
 *
 * Exits non-zero on any assertion failure so the script is CI-safe.
 */

import { createLogger } from '../lib/logger';
import type { QueryBuilder, RpcResponse, SupabaseLike } from '../lib/types';

import { decideExplorationRatio } from '../ranking/explorationController';
import { extractTopics, topicVectorToPayload } from '../personalization/topicExtraction';
import {
  createFeedCacheManager,
  planCleanup,
  DEFAULT_FEED_CACHE_RETENTION,
} from '../personalization/feedCacheManager';
import { createWorkerCoordinator } from '../orchestration/workerCoordinator';
import { createAutoscaler, computeLoadScore } from '../orchestration/autoscaler';
import {
  createCanaryController,
  STAGE_EXPOSURE,
  nextStage,
} from '../deployment/canaryController';
import { createRecoveryManager } from '../resilience/recoveryManager';
import { createCostMonitor } from '../operations/costMonitor';
import { createPerformanceProfiler } from '../observability/performanceProfiler';
import { createTrafficGuard } from '../operations/trafficGuard';

// ---------------------------------------------------------------------------
// Tiny assertion helpers.
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

function section(name: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n— ${name} —`);
}

// ---------------------------------------------------------------------------
// In-memory Supabase fake — minimal surface for the Phase E modules.
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function createScriptedSupabase(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  client: SupabaseLike;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const client: SupabaseLike = {
    async rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<RpcResponse<T>> {
      const params = args ?? {};
      calls.push({ fn, args: params });
      const handler = handlers[fn];
      if (!handler) {
        return { data: null, error: { message: `unhandled_rpc:${fn}` } };
      }
      try {
        const result = handler(params);
        return { data: (result as T) ?? null, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
    from<T = unknown>(_table: string): QueryBuilder<T> {
      const builder: QueryBuilder<T> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        async maybeSingle(): Promise<RpcResponse<T>> {
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

const log = createLogger({ service: 'phase_e_test', worker_id: 'sim_0' });

// ---------------------------------------------------------------------------
// 1. Worker crash storm
// ---------------------------------------------------------------------------

async function testWorkerCrashStorm(): Promise<void> {
  section('1. Worker crash storm');
  let reclaimed = 0;
  const { client } = createScriptedSupabase({
    reclaim_expired_leases: (args) => {
      reclaimed += 3; // pretend 3 leases per worker
      return 3;
    },
    list_stuck_jobs: () => [],
  });
  let fakeNow = 1_000_000;
  const coordinator = createWorkerCoordinator(client, log, {
    staleAfterMs: 5_000,
    deadAfterMs: 15_000,
    now: () => fakeNow,
  });

  // Register 10 queue_runner workers.
  for (let i = 0; i < 10; i += 1) {
    const reg = coordinator.register({
      workerId: `w${i}`,
      workerType: 'queue_runner',
      capabilities: ['ingestion', 'ranking'],
    });
    coordinator.heartbeat({
      workerId: reg.workerId,
      coordinatorTicket: reg.coordinatorTicket,
      activeLeases: 2,
      jobsCompletedDelta: 0,
      jobsFailedDelta: 0,
    });
  }
  assert(coordinator.listWorkers().length === 10, 'all workers registered');

  // Half the fleet stops heartbeating; the other half keeps heartbeating.
  fakeNow += 20_000; // past dead threshold
  for (let i = 5; i < 10; i += 1) {
    const rec = coordinator.listWorkers().find((w) => w.workerId === `w${i}`);
    if (!rec) continue;
    coordinator.heartbeat({
      workerId: rec.workerId,
      coordinatorTicket: rec.coordinatorTicket,
      activeLeases: 2,
      jobsCompletedDelta: 1,
      jobsFailedDelta: 0,
    });
  }
  const changed = coordinator.supervise();
  // Wait long enough for the fire-and-forget reclaim to flush.
  await new Promise((r) => setTimeout(r, 50));

  const dead = coordinator.listWorkers().filter((w) => w.state === 'dead');
  assert(dead.length === 5, '5 silent workers marked dead');
  assert(changed.length >= 5, 'supervise() surfaced the transitions');
  assert(reclaimed >= 15, 'leases reclaimed for every dead worker');

  // Lease balancing: pick a worker from those still alive.
  const picked = coordinator.pickWorker('ingestion');
  assert(picked !== null && picked.state !== 'dead', 'pickWorker returns a live worker');
}

// ---------------------------------------------------------------------------
// 2. Canary rollback
// ---------------------------------------------------------------------------

async function testCanaryRollback(): Promise<void> {
  section('2. Canary rollback');
  const stageHistory: number[] = [];
  const { client } = createScriptedSupabase({
    set_feature_flag_rollout: (args) => {
      stageHistory.push(Number(args.p_rollout_pct ?? -1));
      return null;
    },
  });
  const ctrl = createCanaryController(client, log, { degradedConsecutiveTrigger: 2 });
  await ctrl.register('new_ranker', 'internal', () => ({ status: 'healthy' }));
  assert(stageHistory[stageHistory.length - 1] === STAGE_EXPOSURE.internal, 'flag set to 1% on register');

  await ctrl.advance('new_ranker'); // → beta
  await ctrl.advance('new_ranker'); // → limited
  assert(stageHistory[stageHistory.length - 1] === STAGE_EXPOSURE.limited, 'flag advanced to 25%');

  // Now make the probe degraded.
  const probeCtrl = createCanaryController(client, log, { degradedConsecutiveTrigger: 2 });
  let probeCount = 0;
  await probeCtrl.register('flaky', 'limited', () => {
    probeCount += 1;
    return {
      status: 'degraded',
      reason: 'p95_too_high',
      metrics: { p95_ms: 2_500 },
    };
  });

  const first = await probeCtrl.probe('flaky');
  assert(!first.rolledBack, 'first degraded probe does not roll back');
  const second = await probeCtrl.probe('flaky');
  assert(second.rolledBack, 'second consecutive degraded probe triggers rollback');
  const snap = probeCtrl.snapshot().find((s) => s.flag === 'flaky');
  assert(snap?.stage === 'beta', 'rolled back to previous stage (beta)');
}

// ---------------------------------------------------------------------------
// 3. Personalized cache cleanup
// ---------------------------------------------------------------------------

async function testFeedCacheCleanup(): Promise<void> {
  section('3. Personalized cache cleanup');
  let enqueued = false;
  const { client, calls } = createScriptedSupabase({
    personalized_feed_cache_summary: () => ({
      cache_size: 5_000_000,
      stale_slice_count: 1_200_000,
      avg_feed_age_ms: 96 * 3_600_000,
    }),
    enqueue_job: () => {
      enqueued = true;
      return null;
    },
  });
  const mgr = createFeedCacheManager(client, log);
  const summary = await mgr.summarize();
  assert(summary.cacheSize === 5_000_000, 'summary surfaces cache size');
  const plan = mgr.plan(summary);
  assert(plan.recommended, 'plan recommends cleanup for huge stale cache');
  assert(plan.maxRowsPerSweep > 0 && plan.maxRowsPerSweep <= 100_000, 'plan capped to bounded sweep');
  const res = await mgr.enqueueCleanup(plan, { reason: 'sim' });
  assert(res.enqueued && enqueued, 'cleanup job enqueued');
  const enqJob = calls.find((c) => c.fn === 'enqueue_job');
  assert(enqJob?.args.p_job_type === 'cleanup_personalized_feed_cache', 'enqueued the correct job type');
  // Pure planner with healthy stats should not recommend.
  const healthyPlan = planCleanup(
    { cacheSize: 1_000, staleSliceCount: 5, avgFeedAgeMs: 60_000, sampledAt: new Date() },
    DEFAULT_FEED_CACHE_RETENTION,
  );
  assert(!healthyPlan.recommended, 'healthy cache → no cleanup recommendation');
}

// ---------------------------------------------------------------------------
// 4. Queue flood
// ---------------------------------------------------------------------------

async function testQueueFlood(): Promise<void> {
  section('4. Queue flood');
  const autoscaler = createAutoscaler(log, { scaleDownCooldownMs: 60_000 });
  const recs = autoscaler.recommend({
    queues: {
      ingestion: { depth: 100_000, growthDeltaPerMin: 800, failureRate: 0.1 },
      ranking: { depth: 25_000, growthDeltaPerMin: 200, failureRate: 0.05 },
      notification: { depth: 1_000, growthDeltaPerMin: 50, failureRate: 0 },
      analytics: { depth: 100, growthDeltaPerMin: 0, failureRate: 0 },
    },
    p95LatencyMs: { ingestion: 2_500, ranking: 1_800 },
    currentWorkers: { rss_ingestion: 2, queue_runner: 2, notification_dispatch: 1, ranking_refresh: 1 },
    resources: { cpuPct: 0.7, memoryPct: 0.6 },
  });
  const ingestionRec = recs.find((r) => r.workerType === 'rss_ingestion');
  assert(ingestionRec?.band === 'high', 'autoscaler classifies flood as high load');
  assert((ingestionRec?.recommendedWorkers ?? 0) > (ingestionRec?.currentWorkers ?? 0), 'recommends scale-out');

  const lowLoad = computeLoadScore([{ depth: 5 }], undefined, 1000, undefined);
  assert(lowLoad.score < 1.5, 'idle load below low-threshold');

  // Cost monitor should breach a low threshold under flood.
  const breaches: string[] = [];
  const monitor = createCostMonitor({
    thresholds: [
      { dimension: 'queue_cost', warnAt: 10, criticalAt: 100, unit: 'cpu_min' },
      { dimension: 'notification_volume', warnAt: 5, criticalAt: 50, unit: 'per_min' },
    ],
    onAlert: (b) => breaches.push(`${b.dimension}:${b.severity}`),
  });
  monitor.recordQueueCost('ingestion', 100_000, 50);
  monitor.recordNotification(10_000);
  const sum = monitor.summary();
  assert(sum.breaches.length >= 2, 'cost monitor records breaches under flood');
  assert(breaches.includes('queue_cost:critical'), 'critical breach emitted via onAlert');
}

// ---------------------------------------------------------------------------
// 5. Disaster replay
// ---------------------------------------------------------------------------

async function testDisasterReplay(): Promise<void> {
  section('5. Disaster replay');
  let dlqReplayed = 0;
  let notificationReplayed = 0;
  let rankingEnqueued = 0;
  const dedupKeys = new Set<string>();
  const { client } = createScriptedSupabase({
    replay_dead_letter_jobs: (args) => {
      dlqReplayed += Number(args.p_max ?? 0);
      return Number(args.p_max ?? 0);
    },
    replay_notification_events: (args) => {
      notificationReplayed = Number(args.p_max ?? 0);
      return notificationReplayed;
    },
    enqueue_job: (args) => {
      const dk = String(args.p_dedup_key ?? '');
      if (dedupKeys.has(dk)) {
        // Simulate dedup: a duplicate enqueue is a no-op success.
        return null;
      }
      dedupKeys.add(dk);
      rankingEnqueued += 1;
      return null;
    },
  });
  const mgr = createRecoveryManager(client, log);
  const ctx = { initiator: 'oncall@newsera', reason: 'sim_disaster' };

  const dlqResult = await mgr.dlqReplay(ctx, { queue: 'ingestion', max: 100 });
  assert(dlqResult.ok && dlqResult.count === 100, 'DLQ replay bounded by max');

  const nrResult = await mgr.notificationReplay(ctx, {
    since: new Date(Date.now() - 3_600_000),
    max: 50,
  });
  assert(nrResult.ok && nrResult.count === 50, 'notification replay bounded by max');

  const rrResult = await mgr.rankingRebuild(ctx, { categoryIds: ['cat-a', 'cat-b', 'cat-a'] });
  assert(rrResult.ok && rrResult.count >= 2, 'ranking rebuild enqueues per-category jobs');

  // Second call within the dedup window: should be no-ops.
  await mgr.rankingRebuild(ctx, { categoryIds: ['cat-a', 'cat-b'] });
  assert(rankingEnqueued === 2, 'second rebuild collapses by dedup_key (no user-visible spam)');

  const refused = await mgr.rankingRebuild(ctx, {});
  assert(!refused.ok && refused.error === 'global_rebuild_refused', 'global rebuild refused per spec');
}

// ---------------------------------------------------------------------------
// 6. Notification abuse
// ---------------------------------------------------------------------------

async function testNotificationAbuse(): Promise<void> {
  section('6. Notification abuse');
  const { client } = createScriptedSupabase({
    set_traffic_guard_state: () => null,
    get_traffic_guard_state: () => null,
  });
  const guard = createTrafficGuard(client, log);
  assert(guard.canDispatchNotification().allowed, 'baseline: notifications allowed');
  await guard.set('notification_kill_switch', true, { initiator: 'oncall', reason: 'spam_storm' });
  const blocked = guard.canDispatchNotification();
  assert(!blocked.allowed && blocked.reason === 'notification_kill_switch', 'kill-switch blocks dispatch');
  assert(!guard.canLease('notification').allowed, 'kill-switch also stops notification queue leasing');
  assert(guard.canLease('ingestion').allowed, 'other queues remain operational');

  await guard.set('emergency_throttle', true, { throttleFactor: 0.1 });
  const ingest = guard.canLease('ingestion');
  assert(Math.abs(ingest.concurrencyFactor - 0.1) < 1e-6, 'emergency throttle reduces ingestion concurrency');

  await guard.set('queue_freeze', true, { initiator: 'oncall', reason: 'investigating' });
  assert(!guard.canLease('ingestion').allowed, 'queue freeze halts ingestion leasing');
}

// ---------------------------------------------------------------------------
// Aux: exploration controller + topic extraction + profiler sanity
// ---------------------------------------------------------------------------

function testAuxiliaryUnits(): void {
  section('Aux. Phase D debts unit checks');
  const lowQ = decideExplorationRatio({ deepEngagementRate: 0.05, viewRate: 0.2, bounceRate: 0.8, avgDwellMs: 1_000, signalCount: 50 }, null);
  const highQ = decideExplorationRatio({ deepEngagementRate: 0.9, viewRate: 0.9, bounceRate: 0.05, avgDwellMs: 180_000, signalCount: 50 }, null);
  assert(lowQ.ratio > highQ.ratio, 'low-quality users get more exploration than high-quality');
  assert(lowQ.quality === 'low' && highQ.quality === 'high', 'classified as low / high');

  const cold = decideExplorationRatio({ signalCount: 0 }, null);
  assert(cold.quality === 'cold_start', 'cold-start detected');
  assert(cold.ratio >= 0.2, 'cold-start gets aggressive exploration');

  const topics = extractTopics({
    title: 'Global climate summit reaches agreement on emissions',
    snippet: 'World leaders signed a new pact on greenhouse gas emissions during the climate summit.',
    categorySlug: 'world',
    hintedTopics: ['climate', 'policy'],
  });
  const payload = topicVectorToPayload(topics);
  assert(topics.topics.size > 0 && topics.topics.size <= 16, 'topic vector is bounded');
  assert('climate' in payload || 'climate_summit' in payload, 'climate captured as topic');
  assert(!('the' in payload) && !('on' in payload), 'stopwords filtered');

  const prof = createPerformanceProfiler({ maxSamplesPerBucket: 64 });
  for (let i = 0; i < 200; i += 1) prof.record('queue_latency', i + 1);
  const snap = prof.snapshot('queue_latency');
  assert(snap !== null && snap.count === 64, 'profiler ring buffer bounded');
  assert(snap !== null && snap.p99 >= snap.p95 && snap.p95 >= snap.p50, 'percentiles monotone');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testWorkerCrashStorm();
  await testCanaryRollback();
  await testFeedCacheCleanup();
  await testQueueFlood();
  await testDisasterReplay();
  await testNotificationAbuse();
  testAuxiliaryUnits();

  // eslint-disable-next-line no-console
  console.log(`\nPhase E simulation: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('phase_e_simulation_unexpected_error', err);
  process.exit(1);
});
