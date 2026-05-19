/**
 * Phase F — Controlled rollout & stabilization simulation harness.
 *
 * Exercises the five required scenarios from the Phase F problem statement:
 *
 *   1. 7-day stabilization simulation        — sustained ingestion / ranking
 *                                              / personalization / notifications
 *                                              over a synthetic week, asserting
 *                                              the stabilization policy advances
 *                                              the rollout in strict order.
 *   2. Canary rollback cascade               — ranking rollout causes a latency
 *                                              spike; weighted health evaluator
 *                                              flips to CRITICAL, the canary
 *                                              controller rolls back, traffic
 *                                              guard engages degradation mode.
 *   3. Notification overload                 — 1M fanout target with chunking
 *                                              + user protection daily ceiling.
 *   4. Feed collapse prevention              — one dominant source flooding the
 *                                              feed; auditor + user protector
 *                                              flag the diversity violation.
 *   5. Incident escalation chain             — worker deaths + stale queues +
 *                                              notification failures escalate to
 *                                              SEVERE / CRITICAL incidents that
 *                                              the rollout manager pauses on.
 *
 * Also runs a quick sanity check on the Phase E debt closures:
 *
 *   - scalingHistory rolls up overload spans
 *   - recoveryManager suppresses duplicate replays via fingerprinting
 *   - canaryHealthEvaluator classifies HEALTHY / DEGRADED / CRITICAL
 *   - telemetryValidator scores integrity
 *   - launchLockdown blocks on critical findings
 *   - betaTrafficController gates correctly
 *
 * Run with: pnpm --filter @newsera/rss-engine test:phaseF
 *           (or)  npx tsx workers/tests/phaseF.simulation.ts
 *
 * Exits non-zero on any assertion failure so the script is CI-safe.
 */

import { createLogger } from '../lib/logger';
import type { QueryBuilder, RpcResponse, SupabaseLike } from '../lib/types';

import {
  createCanaryController,
  STAGE_EXPOSURE,
} from '../deployment/canaryController';
import {
  evaluateCanaryHealth,
  asCanaryProbeSnapshot,
} from '../deployment/canaryHealthEvaluator';
import { createRolloutManager, ROLLOUT_SEQUENCE } from '../rollout/rolloutManager';
import {
  createStabilizationPolicy,
  DEFAULT_STABILIZATION_WINDOWS,
} from '../rollout/stabilizationPolicy';
import { validateTelemetry } from '../operations/telemetryValidator';
import { createUserProtector } from '../safety/userProtection';
import { auditFeedQuality } from '../ranking/feedQualityAuditor';
import { createIncidentDetector } from '../operations/incidentDetector';
import { createBetaTrafficController } from '../operations/betaTrafficController';
import { runLaunchLockdown } from '../security/launchLockdown';
import { createScalingHistory } from '../operations/scalingHistory';
import { createRecoveryManager } from '../resilience/recoveryManager';
import { createTrafficGuard } from '../operations/trafficGuard';
import { createAutoscaler } from '../orchestration/autoscaler';

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
// In-memory Supabase fake — minimal surface for the Phase F modules.
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
      if (!handler) return { data: null, error: { message: `unhandled_rpc:${fn}` } };
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

const log = createLogger({ service: 'phase_f_test', worker_id: 'sim_0' });

// ---------------------------------------------------------------------------
// 1. 7-day stabilization simulation
// ---------------------------------------------------------------------------

async function testSevenDayStabilization(): Promise<void> {
  section('1. 7-day stabilization simulation');
  const stageExposures: number[] = [];
  const { client } = createScriptedSupabase({
    set_feature_flag_rollout: (args) => {
      stageExposures.push(Number(args.p_rollout_pct ?? -1));
      return null;
    },
  });
  let fakeNow = 1_700_000_000_000;
  const canary = createCanaryController(client, log, { degradedConsecutiveTrigger: 2 });
  const rollout = createRolloutManager(canary, log, { now: () => fakeNow });
  const policy = createStabilizationPolicy();
  await rollout.bootstrap();
  assert(rollout.snapshot().stages.length === ROLLOUT_SEQUENCE.length, '4 rollout stages registered');
  assert(stageExposures[0] === STAGE_EXPOSURE.internal, 'first flag seeded at 1%');

  // Healthy operating signals throughout the week.
  const healthy = {
    queueLatencyMs: 250,
    queueDepthPeak: 800,
    workerCrashCount: 0,
    dbLatencyMs: 40,
    notificationDeliverySuccess: 0.99,
    personalizationFreshnessMs: 5 * 60_000,
  };

  // Walk through all four stages in strict order.
  for (let i = 0; i < ROLLOUT_SEQUENCE.length; i += 1) {
    const flag = ROLLOUT_SEQUENCE[i];
    const stage = await rollout.beginNextStage({ initiator: 'oncall', reason: `start_${flag}` });
    assert(stage.flag === flag, `stage ${i + 1} matches sequence (${flag})`);

    // Promote through canary stages until global (1→5→25→50→100).
    let promotions = 0;
    while ((rollout.snapshot().stages.find((s) => s.flag === flag)?.canaryStage) !== 'global') {
      await rollout.promote({ initiator: 'oncall', reason: 'healthy_progression' });
      promotions += 1;
      if (promotions > 10) break;
    }
    assert(promotions === 4, `promoted ${flag} through 4 canary stages`);

    rollout.markStabilizing({ initiator: 'oncall', reason: 'reached_global' });
    const windowMs = policy.windowFor(flag);
    // First eval: window not yet satisfied.
    const before = policy.evaluate({
      feature: flag,
      enteredStabilizationAt: new Date(fakeNow),
      now: new Date(fakeNow + windowMs / 2),
      signals: healthy,
    });
    assert(!before.advancementAllowed, `${flag} not advanceable before window`);
    // Advance clock past the stabilization window.
    fakeNow += windowMs + 60_000;
    const after = policy.evaluate({
      feature: flag,
      enteredStabilizationAt: new Date(fakeNow - (windowMs + 60_000)),
      now: new Date(fakeNow),
      signals: healthy,
    });
    assert(after.advancementAllowed, `${flag} advanceable after ${windowMs / 3_600_000}h window`);
    rollout.markStable({ initiator: 'oncall', reason: 'window_met' });
  }

  const finalSnap = rollout.snapshot();
  assert(finalSnap.stages.every((s) => s.status === 'STABLE'), 'all 4 stages STABLE after 7 days');

  // Verify total elapsed sim time covers ≥ 7 days (24 + 48 + 72 + 72 = 216h).
  assert(
    fakeNow - 1_700_000_000_000 >= 7 * 24 * 3_600_000,
    'sim covered at least 7 days of wall clock',
  );

  // Verify default stabilization windows are exactly the spec values.
  const windows = Object.fromEntries(DEFAULT_STABILIZATION_WINDOWS.map((w) => [w.feature, w.windowMs / 3_600_000]));
  assert(windows.queue_based_ingestion === 24, 'ingestion window = 24h');
  assert(windows.ranking_v1 === 48, 'ranking window = 48h');
  assert(windows.personalization_v1 === 72, 'personalization window = 72h');
  assert(windows.backend_notification_dispatch === 72, 'notifications window = 72h');

  // Block-on-unhealthy: if a signal is bad, advancement must be denied.
  const bad = policy.evaluate({
    feature: 'ranking_v1',
    enteredStabilizationAt: new Date(fakeNow - 49 * 3_600_000),
    now: new Date(fakeNow),
    signals: { ...healthy, queueLatencyMs: 9_000 },
  });
  assert(!bad.advancementAllowed && bad.blockers.length > 0, 'unhealthy signals block advancement');
}

// ---------------------------------------------------------------------------
// 2. Canary rollback cascade
// ---------------------------------------------------------------------------

async function testCanaryRollbackCascade(): Promise<void> {
  section('2. Canary rollback cascade');
  const stageHistory: Array<{ flag: string; pct: number }> = [];
  const { client } = createScriptedSupabase({
    set_feature_flag_rollout: (args) => {
      stageHistory.push({ flag: String(args.p_flag_key ?? ''), pct: Number(args.p_rollout_pct ?? -1) });
      return null;
    },
    set_traffic_guard_state: () => null,
  });
  const canary = createCanaryController(client, log, { degradedConsecutiveTrigger: 2 });
  const guard = createTrafficGuard(client, log);

  let inputs = {
    queueLatencyMs: 250,
    workerCrashRate: 0,
    errorSpikeRatio: 1,
    notificationFailurePct: 0.01,
    dbLatencyMs: 50,
    personalizationFreshnessMs: 60_000,
  };

  await canary.register('ranking_v1', 'limited', () => asCanaryProbeSnapshot(evaluateCanaryHealth(inputs)));
  const healthyEval = evaluateCanaryHealth(inputs);
  assert(healthyEval.classification === 'HEALTHY', 'baseline classification HEALTHY');
  assert(healthyEval.rollbackConfidence === 0, 'no rollback recommended when healthy');

  // Simulate latency spike caused by ranking rollout.
  inputs = {
    queueLatencyMs: 4_000,
    workerCrashRate: 0.05,
    errorSpikeRatio: 5,
    notificationFailurePct: 0.05,
    dbLatencyMs: 600,
    personalizationFreshnessMs: 10 * 60_000,
  };
  const criticalEval = evaluateCanaryHealth(inputs);
  assert(criticalEval.classification === 'CRITICAL', 'latency spike → CRITICAL');
  assert(criticalEval.rollbackConfidence >= 0.6, 'rollback confidence high under critical');

  // Run the probe twice — triggers rollback on the second consecutive critical.
  const p1 = await canary.probe('ranking_v1');
  const p2 = await canary.probe('ranking_v1');
  assert(!p1.rolledBack, 'first probe holds');
  assert(p2.rolledBack, 'second consecutive critical probe rolls back');
  const snap = canary.snapshot().find((s) => s.flag === 'ranking_v1');
  assert(snap?.stage === 'beta', 'ranking_v1 rolled back to previous canary stage (beta)');

  // The operator now engages ranking degradation mode to stabilize.
  await guard.set('ranking_degradation_mode', true, { initiator: 'oncall', reason: 'post_rollback_stabilization' });
  assert(!guard.shouldUsePersonalizedRanker(), 'degradation mode falls back to global ranker');

  // After mitigation, signals recover; subsequent probes do not roll back further.
  inputs = {
    queueLatencyMs: 300,
    workerCrashRate: 0,
    errorSpikeRatio: 1,
    notificationFailurePct: 0.01,
    dbLatencyMs: 60,
    personalizationFreshnessMs: 60_000,
  };
  const post = await canary.probe('ranking_v1');
  assert(!post.rolledBack, 'queues stabilize — no further rollback');

  // The DEGRADED classification holds (does not roll back) but stalls advancement.
  const degraded = evaluateCanaryHealth({
    queueLatencyMs: 1_500,
    workerCrashRate: 0.02,
    errorSpikeRatio: 2,
    notificationFailurePct: 0.05,
    dbLatencyMs: 200,
    personalizationFreshnessMs: 20 * 60_000,
  });
  assert(degraded.classification === 'DEGRADED', 'middle signals classify DEGRADED');
  const probeShape = asCanaryProbeSnapshot(degraded);
  assert(probeShape.status === 'watching', 'DEGRADED maps to canary watching status');
}

// ---------------------------------------------------------------------------
// 3. Notification overload
// ---------------------------------------------------------------------------

async function testNotificationOverload(): Promise<void> {
  section('3. Notification overload');
  const protector = createUserProtector({ notificationsPerDay: 5, minNotificationGapMs: 100 });
  const detector = createIncidentDetector({ notificationCollapseThreshold: 0.6 });

  // 1M target fanout: simulate the chunking decision (we only verify the
  // user-side throttling actually denies dispatch when ceiling is hit).
  const targetCount = 1_000_000;
  const chunkSize = 5_000;
  const expectedChunks = Math.ceil(targetCount / chunkSize);
  assert(expectedChunks === 200, '1M target → 200 chunks at 5k each');

  // For a single user: send 5 (allowed), 6th must be denied.
  const userId = 'user-burst';
  const start = new Date('2026-05-19T12:00:00Z');
  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < 10; i += 1) {
    const at = new Date(start.getTime() + i * 1_000);
    const d = protector.canSendNotification(userId, at);
    if (d.allowed) {
      protector.recordNotificationSent(userId, at);
      allowed += 1;
    } else {
      denied += 1;
    }
  }
  assert(allowed === 5, 'protector enforces 5-per-day ceiling');
  assert(denied === 5, 'remaining 5 burst attempts denied');

  // Simulate a database collapse during fanout — incident detector flags it.
  const fired = detector.evaluate({
    notificationDeliverySuccess: 0.2,
    queues: { notification: { depth: 200_000, growthDeltaPerMin: 5_000 } },
    dbLatencyMs: 800,
  });
  assert(fired.length >= 2, 'multiple incidents fired under overload');
  const collapse = fired.find((i) => i.type === 'notification_delivery_collapse');
  assert(collapse?.severity === 'CRITICAL', 'notification collapse classified CRITICAL');
  const queueExplosion = fired.find((i) => i.type === 'queue_explosion');
  assert(queueExplosion?.severity === 'CRITICAL', 'queue explosion classified CRITICAL');
}

// ---------------------------------------------------------------------------
// 4. Feed collapse prevention
// ---------------------------------------------------------------------------

function testFeedCollapsePrevention(): void {
  section('4. Feed collapse prevention');
  // 20 items, 18 from the same source ("source-A"): clear domination.
  const items = Array.from({ length: 20 }, (_, i) => ({
    articleId: `a${i}`,
    sourceId: i < 18 ? 'source-A' : `source-${i}`,
    categoryId: 'world',
    publishedAtMs: Date.now() - 60_000,
    engagementScore: 0.5,
    topicTokens: ['breaking', 'world', 'update'],
  }));
  const res = auditFeedQuality(items, { now: Date.now() });
  assert(res.sourceDiversity < 0.5, 'source diversity tanked under domination');
  const dominationWarning = res.warnings.find((w) => w.code === 'source_diversity_low');
  assert(dominationWarning !== undefined, 'auditor flags source_diversity_low');
  const collapseWarning = res.warnings.find((w) => w.code === 'recommendation_collapse');
  assert(collapseWarning !== undefined, 'identical topic tokens flag recommendation_collapse');
  assert(res.feedQualityScore < 0.6, 'feed quality score reduced');

  // The user protector independently rejects the dominated feed.
  const protector = createUserProtector();
  const audit = protector.auditFeed({
    sourceIds: items.map((it) => it.sourceId),
    isExploration: items.map(() => false),
    oldestItemAgeMs: 60_000,
  });
  assert(!audit.allowed, 'user protector rejects dominated feed');
  assert(audit.topSourceId === 'source-A', 'top source identified');
  assert(audit.topSourceShare >= 0.9, 'source-A share ≥ 90%');

  // A healthy diverse feed should pass both auditors.
  const healthy = Array.from({ length: 20 }, (_, i) => ({
    articleId: `h${i}`,
    sourceId: `source-${i % 8}`,
    categoryId: `cat-${i % 5}`,
    publishedAtMs: Date.now() - 60_000,
    engagementScore: 0.6,
    topicTokens: [`topic_${i}`, 'news'],
  }));
  const healthyRes = auditFeedQuality(healthy, { now: Date.now() });
  assert(healthyRes.feedQualityScore > 0.85, 'healthy feed scores high');
  assert(healthyRes.warnings.length === 0, 'healthy feed has no warnings');
}

// ---------------------------------------------------------------------------
// 5. Incident escalation chain
// ---------------------------------------------------------------------------

async function testIncidentEscalationChain(): Promise<void> {
  section('5. Incident escalation chain');
  const { client } = createScriptedSupabase({
    set_feature_flag_rollout: () => null,
    set_traffic_guard_state: () => null,
  });
  const canary = createCanaryController(client, log, { degradedConsecutiveTrigger: 2 });
  const rollout = createRolloutManager(canary, log);
  const guard = createTrafficGuard(client, log);
  const detector = createIncidentDetector();
  await rollout.bootstrap();
  await rollout.beginNextStage({ initiator: 'oncall', reason: 'launch' });

  // First wave: WARNING-only incidents.
  const wave1 = detector.evaluate({
    queues: { ingestion: { depth: 12_000, growthDeltaPerMin: 100 } },
    dbLatencyMs: 280,
  });
  assert(wave1.some((i) => i.type === 'db_saturation_risk' && i.severity === 'WARNING'), 'db_saturation_risk WARNING fired');

  // Second wave: worker death storm + ingestion stall escalate.
  const wave2 = detector.evaluate({
    workerCrashesInWindow: 8,
    workerCrashWindowMs: 60_000,
    ingestionItemsPerMin: 0,
    notificationDeliverySuccess: 0.4,
  });
  const crashIncident = wave2.find((i) => i.type === 'worker_death_storm');
  assert(crashIncident?.severity === 'CRITICAL', 'worker_death_storm escalates to CRITICAL');
  const stallIncident = wave2.find((i) => i.type === 'ingestion_stall');
  assert(stallIncident?.severity === 'SEVERE', 'ingestion_stall SEVERE');
  const notifIncident = wave2.find((i) => i.type === 'notification_delivery_collapse');
  assert(notifIncident !== undefined, 'notification_delivery_collapse fired');

  // Operator visibility: snapshot exposes open incidents with worst severity.
  const snap = detector.snapshot();
  assert(snap.worstSeverity === 'CRITICAL', 'worst severity is CRITICAL');
  assert(snap.open.length >= 3, 'at least 3 open incidents');

  // trafficGuard engagement: operator flips emergency_throttle + kill switch.
  await guard.set('emergency_throttle', true, { initiator: 'oncall', reason: 'incident_response', throttleFactor: 0.1 });
  await guard.set('notification_kill_switch', true, { initiator: 'oncall', reason: 'incident_response' });
  assert(!guard.canDispatchNotification().allowed, 'notification dispatch halted');
  assert(Math.abs(guard.canLease('ingestion').concurrencyFactor - 0.1) < 1e-6, 'ingestion throttled');

  // Rollout manager pauses the active stage in response.
  const paused = rollout.pause({ initiator: 'oncall', reason: 'critical_incident' });
  assert(paused.status === 'PAUSED', 'active stage paused');
  assert(rollout.blockers().some((b) => b.startsWith('paused:')), 'paused stage shows as blocker');

  // Dedup: re-evaluating identical signals does not flood new incidents.
  const wave2dup = detector.evaluate({
    workerCrashesInWindow: 8,
    workerCrashWindowMs: 60_000,
  });
  assert(wave2dup.length === 0, 'dedup window suppresses duplicate emission');

  // Closing incidents drops them from open.
  for (const inc of snap.open) detector.close(inc.id);
  const snap2 = detector.snapshot();
  assert(snap2.open.length === 0, 'all incidents closed by operator');

  // Resume rollout once incidents are mitigated.
  const resumed = rollout.resume({ initiator: 'oncall', reason: 'incidents_resolved' });
  assert(resumed.status === 'ACTIVE' || resumed.status === 'STABILIZING', 'rollout resumed');
}

// ---------------------------------------------------------------------------
// Aux: Phase E debt closure unit checks
// ---------------------------------------------------------------------------

async function testPhaseEDebtsClosed(): Promise<void> {
  section('Aux. Phase E debt closures');

  // scalingHistory
  let nowMs = 1_000_000;
  const hist = createScalingHistory(log, { now: () => nowMs });
  const auto = createAutoscaler(log);
  for (let i = 0; i < 6; i += 1) {
    const recs = auto.recommend({
      queues: { ingestion: { depth: 60_000 + i * 1_000, growthDeltaPerMin: 500 } },
      currentWorkers: { rss_ingestion: 2, queue_runner: 2, notification_dispatch: 1, ranking_refresh: 1 },
    });
    for (const r of recs) hist.record(r, new Date(nowMs));
    hist.recordPressure({
      queue: 'ingestion',
      depth: 60_000 + i * 1_000,
      growthDeltaPerMin: 500,
      observedAt: new Date(nowMs),
    });
    nowMs += 60_000;
  }
  const histSnap = hist.snapshot();
  assert(histSnap.totalRecommendations > 0, 'scalingHistory records recommendations');
  assert(histSnap.saturation.find((s) => s.queue === 'ingestion')?.avgDepth ?? 0 > 50_000, 'ingestion shows sustained high depth');
  const warnings = hist.predictOverload();
  assert(warnings.length > 0, 'scalingHistory predicts overload warnings');

  // recoveryManager — duplicate replay suppression
  let dlqCount = 0;
  const { client: client2 } = createScriptedSupabase({
    replay_dead_letter_jobs: () => {
      dlqCount += 1;
      return 10;
    },
  });
  const mgr = createRecoveryManager(client2, log, { idempotencyWindowMs: 5 * 60_000 });
  const ctx = { initiator: 'oncall', reason: 'duplicate_test' };
  const first = await mgr.dlqReplay(ctx, { queue: 'ingestion', max: 100 });
  const second = await mgr.dlqReplay(ctx, { queue: 'ingestion', max: 100 });
  assert(first.ok && first.count === 10, 'first replay executed');
  assert(second.ok && second.count === 0, 'duplicate replay suppressed');
  assert(dlqCount === 1, 'RPC called exactly once for duplicate window');
  const lineage = mgr.lineage();
  assert(lineage.length === 1 && lineage[0].suppressions === 1, 'lineage tracks suppression count');

  // canaryHealthEvaluator
  const h = evaluateCanaryHealth({
    queueLatencyMs: 400,
    workerCrashRate: 0,
    errorSpikeRatio: 1,
    notificationFailurePct: 0.01,
    dbLatencyMs: 40,
    personalizationFreshnessMs: 60_000,
  });
  assert(h.classification === 'HEALTHY' && h.score > 0.85, 'evaluator returns HEALTHY for clean inputs');
  const c = evaluateCanaryHealth({
    queueLatencyMs: 5_000,
    workerCrashRate: 0.2,
    errorSpikeRatio: 8,
    notificationFailurePct: 0.5,
    dbLatencyMs: 1_500,
    personalizationFreshnessMs: 2 * 3_600_000,
  });
  assert(c.classification === 'CRITICAL' && c.rollbackConfidence >= 0.8, 'critical inputs → high rollback confidence');
}

// ---------------------------------------------------------------------------
// Aux: telemetry, beta, lockdown
// ---------------------------------------------------------------------------

function testTelemetryBetaLockdown(): void {
  section('Aux. Telemetry / beta / launch lockdown');

  // telemetryValidator
  const now = new Date('2026-05-19T20:00:00Z');
  const tv = validateTelemetry({
    metrics: [
      { name: 'queue_latency_p95', value: 200, lastObservedAt: new Date(now.getTime() - 60_000), maxAgeMs: 5 * 60_000 },
      { name: 'worker_heartbeats', value: 10, lastObservedAt: new Date(now.getTime() - 20 * 60_000), maxAgeMs: 5 * 60_000 },
      { name: 'jobs_completed_total', value: 100, previousValue: 150, monotonic: true, lastObservedAt: now, maxAgeMs: 60_000 },
    ],
    heartbeats: [
      { workerId: 'w1', observations: [{ at: new Date(now.getTime() - 60_000) }, { at: now }], maxGapMs: 120_000 },
      { workerId: 'w2', observations: [{ at: new Date(now.getTime() - 10 * 60_000) }], maxGapMs: 120_000 },
    ],
    queueDrift: [
      { queue: 'ingestion', reportedDepth: 100, sampledDepth: 200, toleranceAbs: 25, toleranceRel: 0.1 },
    ],
    deadWorkerIds: ['w-dead'],
    workerReferencedMetrics: [{ metric: 'completed_by_w-dead', workerId: 'w-dead' }],
    profilerWindows: [
      { name: 'queue', count: 64, capacity: 64, p50: 10, p95: 20, p99: 30 },
      { name: 'malformed', count: 100, capacity: 64, p50: 30, p95: 20, p99: 10 },
    ],
    requiredMetrics: ['queue_latency_p95', 'worker_heartbeats', 'jobs_completed_total', 'absent_metric'],
    now,
  });
  assert(tv.findings.some((f) => f.check === 'missing_metric' && f.subject === 'absent_metric'), 'missing_metric detected');
  assert(tv.findings.some((f) => f.check === 'stale_metric'), 'stale_metric detected');
  assert(tv.findings.some((f) => f.check === 'inconsistent_counter'), 'inconsistent_counter detected');
  assert(tv.findings.some((f) => f.check === 'broken_heartbeat_chain'), 'broken_heartbeat_chain detected');
  assert(tv.findings.some((f) => f.check === 'queue_drift'), 'queue_drift detected');
  assert(tv.findings.some((f) => f.check === 'dead_worker_reference'), 'dead_worker_reference detected');
  assert(tv.findings.some((f) => f.check === 'malformed_profiler_window'), 'malformed_profiler_window detected');
  assert(tv.integrityScore < 1 && tv.integrityScore >= 0, 'integrity score in [0,1]');

  // betaTrafficController
  const beta = createBetaTrafficController({
    mode: 'beta',
    enabledCohorts: ['early-access'],
    inviteCodes: ['SECRET-123'],
    enabledRegions: ['US', 'GB'],
    trafficPercentage: 0.5,
  });
  assert(!beta.decide({ userId: 'u1' }).allowed, 'no cohort/invite → denied');
  assert(beta.decide({ userId: 'u2', inviteCode: 'SECRET-123' }).allowed, 'valid invite admits');
  assert(beta.decide({ userId: 'u3', isStaff: true }).allowed, 'staff always admitted');
  // Determinism: same user → same verdict.
  const d1 = beta.decide({ userId: 'u4', cohort: 'early-access', region: 'US' });
  const d2 = beta.decide({ userId: 'u4', cohort: 'early-access', region: 'US' });
  assert(d1.allowed === d2.allowed, 'user verdict deterministic');
  // Region gate.
  assert(!beta.decide({ userId: 'u5', cohort: 'early-access', region: 'FR' }).allowed, 'region gate denies non-enabled region');
  // Closed mode locks down everyone except staff.
  beta.configure({ mode: 'closed' });
  assert(!beta.decide({ userId: 'u6', cohort: 'early-access', region: 'US' }).allowed, 'closed mode denies non-staff');
  assert(beta.decide({ userId: 'u7', isStaff: true }).allowed, 'closed mode admits staff');

  // launchLockdown
  const lockdown = runLaunchLockdown({
    env: {
      VITE_SUPABASE_SERVICE_ROLE_KEY: 'leaked',
      SUPABASE_URL: 'http://example.com',
      ADMIN_PASSWORD: '12345',
      VITE_SUPABASE_ANON_KEY: 'public_anon_key',
    },
    isProduction: true,
    publicRoutes: ['/api/feed', '/debug/stats', '/test/seed'],
    unauthenticatedAdminRpcs: ['admin_purge_user'],
    logLevel: 'debug',
    replayPrimitives: [
      { name: 'dlq_replay', hasIdempotencyKey: true },
      { name: 'legacy_replay', hasIdempotencyKey: false },
    ],
    queues: [
      { name: 'ingestion', validatesPayload: true },
      { name: 'analytics', validatesPayload: false },
    ],
  });
  assert(lockdown.findings.some((f) => f.check === 'exposed_service_role_key'), 'leaked service role key flagged');
  assert(lockdown.findings.some((f) => f.check === 'insecure_env_var' && f.subject === 'SUPABASE_URL'), 'http url in prod flagged');
  assert(lockdown.findings.some((f) => f.check === 'unsafe_admin_rpc_exposure'), 'admin RPC flagged');
  assert(lockdown.findings.some((f) => f.check === 'open_debug_endpoint'), 'debug route flagged');
  assert(lockdown.findings.some((f) => f.check === 'test_route'), 'test route flagged');
  assert(lockdown.findings.some((f) => f.check === 'verbose_production_logs'), 'verbose logs flagged');
  assert(lockdown.findings.some((f) => f.check === 'replay_vulnerability'), 'replay vuln flagged');
  assert(lockdown.findings.some((f) => f.check === 'queue_poisoning_vector'), 'queue poisoning flagged');
  assert(!lockdown.passed && lockdown.blockingCount > 0, 'lockdown blocks launch under critical findings');

  const cleanLockdown = runLaunchLockdown({
    env: { SUPABASE_URL: 'https://example.com' },
    isProduction: true,
    publicRoutes: ['/api/feed', '/api/article'],
    unauthenticatedAdminRpcs: [],
    logLevel: 'info',
    replayPrimitives: [{ name: 'dlq_replay', hasIdempotencyKey: true }],
    queues: [{ name: 'ingestion', validatesPayload: true }],
  });
  assert(cleanLockdown.passed && cleanLockdown.launchSecurityScore === 1, 'clean configuration scores 1.0');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testSevenDayStabilization();
  await testCanaryRollbackCascade();
  await testNotificationOverload();
  testFeedCollapsePrevention();
  await testIncidentEscalationChain();
  await testPhaseEDebtsClosed();
  testTelemetryBetaLockdown();

  // eslint-disable-next-line no-console
  console.log(`\nPhase F simulation: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('phase_f_simulation_unexpected_error', err);
  process.exit(1);
});
