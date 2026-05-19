/**
 * Phase G — Final productionization / launch-readiness simulation harness.
 *
 * Exercises the eight required scenarios from the Phase G problem
 * statement plus quick sanity checks on the four Phase F debt-closure
 * modules.
 *
 * Run with:  pnpm --filter @newsera/rss-engine test:phaseG
 *       (or) npx tsx workers/tests/phaseG.simulation.ts
 *
 * Exits non-zero on any assertion failure so the script is CI-safe.
 *
 * Target: 120+ assertions.
 */

import { createLogger } from '../lib/logger';

// Phase F debt closures.
import { createIncidentHistory } from '../operations/incidentHistory';
import { createDeploymentLineage } from '../rollout/deploymentLineage';
import { createAdaptiveFeedThresholds } from '../ranking/adaptiveFeedThresholds';
import { createBetaAnalytics } from '../operations/betaAnalytics';

// Deployment automation.
import { computeBuildFingerprint, fingerprintIsRedeploy } from '../deployment/buildFingerprint';
import { diffEnvironments, summarizeDiff } from '../deployment/environmentDiff';
import { validateRelease } from '../deployment/releaseValidator';
import { createReleaseOrchestrator } from '../deployment/releaseOrchestrator';

// Production monitoring.
import { composeCommandCenterSnapshot } from '../operations/productionCommandCenter';
import { computeSystemHealthScore } from '../operations/systemHealthScore';

// Backup & recovery.
import {
  createBackupCoordinator,
  DEFAULT_BACKUP_SCHEDULES,
} from '../resilience/backupCoordinator';
import { verifyRecovery } from '../resilience/recoveryVerification';

// Monetization.
import { createAdPlacementGuard } from '../monetization/adPlacementGuard';
import { createRevenueHealth } from '../monetization/revenueHealth';
import { createClickFraudSignals } from '../monetization/clickFraudSignals';

// SEO.
import { validateArticleSchema, detectDuplicateContent } from '../seo/schemaValidator';
import { createSitemapCoordinator } from '../seo/sitemapCoordinator';
import { createNewsIndexingMonitor } from '../seo/newsIndexingMonitor';
import { auditSeoHealth } from '../seo/seoHealthAuditor';
import { createSocialDistributionMonitor } from '../distribution/socialDistributionMonitor';

// Mobile.
import { evaluateApiCompatibility } from '../mobile/apiCompatibilityGuard';
import { createCrashCorrelation } from '../mobile/crashCorrelation';
import { evaluateMobileRelease } from '../mobile/releaseReadiness';

// Security / compliance.
import {
  evaluateRetention,
  DEFAULT_RETENTION_RULES,
} from '../security/dataRetentionPolicy';
import { createAccessBoundaryAudit } from '../security/accessBoundaryAudit';
import { auditCompliance } from '../security/complianceAudit';

// ---------------------------------------------------------------------------
// Assertion harness.
// ---------------------------------------------------------------------------

let failures = 0;
let assertions = 0;
function assert(cond: unknown, label: string): void {
  assertions += 1;
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

const log = createLogger({ service: 'phase_g_test', worker_id: 'sim_0' });

const FIXED_NOW = 1_750_000_000_000;
let fakeNow = FIXED_NOW;
const nowFn = () => new Date(fakeNow);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFp(buildId: string, gitSha: string, extra: Record<string, string> = {}) {
  return computeBuildFingerprint(
    {
      buildId,
      gitSha,
      gitBranch: 'main',
      packageHashes: { 'rss-engine': 'h1', 'admin-panel': 'h2', ...extra },
      compiledFlags: ['queue_based_ingestion', 'ranking_v1'],
      environmentMarkers: { node: '20.x' },
    },
    nowFn,
  );
}

// ---------------------------------------------------------------------------
// Phase F debt closures — sanity checks.
// ---------------------------------------------------------------------------

function testPhaseFDebts(): void {
  section('Phase F debts — incidentHistory / deploymentLineage / adaptive thresholds / beta analytics');

  // ---- incidentHistory ----
  const history = createIncidentHistory({ dedupWindowMs: 60_000, now: nowFn });
  const inc1 = history.record({
    id: 'i1',
    type: 'queue_explosion',
    severity: 'SEVERE',
    triggeredAt: new Date(fakeNow).toISOString(),
    detail: { queue: 'ingestion' },
  } as any);
  assert(inc1.occurrences === 1, 'first incident has 1 occurrence');
  const inc2 = history.record({
    id: 'i2',
    type: 'queue_explosion',
    severity: 'SEVERE',
    triggeredAt: new Date(fakeNow).toISOString(),
    detail: { queue: 'ingestion' },
  } as any);
  assert(inc2.id === inc1.id, 'dedup collapses identical incidents');
  assert(inc2.occurrences === 2, 'occurrences increment under dedup');
  // Escalate severity on existing.
  fakeNow += 1_000;
  const inc3 = history.record({
    id: 'i3',
    type: 'queue_explosion',
    severity: 'CRITICAL',
    triggeredAt: new Date(fakeNow).toISOString(),
    detail: { queue: 'ingestion' },
  } as any);
  assert(inc3.severity === 'CRITICAL', 'escalates dedup entry severity');
  const acked = history.acknowledge(inc1.id, 'oncall');
  assert(acked?.state === 'ACKED', 'acknowledge moves state to ACKED');
  fakeNow += 5 * 60_000;
  const resolved = history.resolve(inc1.id, 'queue scaled');
  assert(resolved?.state === 'RESOLVED', 'resolve moves state to RESOLVED');
  assert(typeof resolved?.durationMs === 'number' && resolved!.durationMs! > 0, 'duration tracked');
  const trend = history.trend(24 * 3_600_000);
  assert(trend.totalEntries >= 1, 'trend reports entries');
  assert(typeof trend.averageMttrMs === 'number', 'trend computes average MTTR');
  const serialized = history.serialize();
  const rehydrated = createIncidentHistory({ now: nowFn });
  rehydrated.hydrate(serialized);
  assert(rehydrated.size() === serialized.length, 'hydrate restores size');

  // ---- deploymentLineage ----
  const lineage = createDeploymentLineage({ now: nowFn });
  const sessionA = lineage.openSession({
    environment: 'production',
    build: { buildId: 'b1', gitSha: 'abc', builtAt: new Date(fakeNow).toISOString(), packages: ['rss', 'admin'] },
    migrations: [{ id: 'm1', applied: true }],
    flags: [{ key: 'queue_based_ingestion', rolloutPct: 1, enabled: true }],
    initiator: 'ci',
    reason: 'initial',
  });
  assert(sessionA.status === 'STAGED', 'session opens STAGED');
  assert(sessionA.fingerprint.length > 4, 'fingerprint computed');
  lineage.markInProgress(sessionA.sessionId);
  lineage.closeSession(sessionA.sessionId, 'COMPLETED');
  const sessionB = lineage.openSession({
    environment: 'production',
    build: { buildId: 'b2', gitSha: 'def', builtAt: new Date(fakeNow).toISOString(), packages: ['rss', 'admin'] },
    migrations: [{ id: 'm1', applied: true }, { id: 'm2', applied: true }],
    flags: [
      { key: 'queue_based_ingestion', rolloutPct: 50, enabled: true },
      { key: 'ranking_v1', rolloutPct: 5, enabled: true },
    ],
    parentSessionId: sessionA.sessionId,
    initiator: 'ci',
    reason: 'add ranking',
  });
  assert(sessionB.parentSessionId === sessionA.sessionId, 'parent session linked');
  const introducers = lineage.findByFlagIntroduction('ranking_v1');
  assert(introducers.some((s) => s.sessionId === sessionB.sessionId), 'flag introduction traceable');
  const migSessions = lineage.findByMigration('m2');
  assert(migSessions.some((s) => s.sessionId === sessionB.sessionId), 'migration → session traceable');
  lineage.rollback(sessionB.sessionId, sessionA.sessionId, 'verification failed');
  assert(lineage.get(sessionB.sessionId)?.status === 'ROLLED_BACK', 'rollback recorded');
  const ancestry = lineage.ancestry(sessionB.sessionId);
  assert(ancestry.length === 2, 'rollback ancestry is two sessions deep');

  // ---- adaptive feed thresholds ----
  const adaptive = createAdaptiveFeedThresholds({ minSamplesForRecommendation: 5 });
  for (let i = 0; i < 30; i += 1) {
    adaptive.record({
      category: 'world',
      topSourceShare: 0.18 + (i % 5) * 0.02,
      uniqueSources: 10 + (i % 4),
      engagementCtr: 0.05 + (i % 3) * 0.005,
      dwellSeconds: 22 + (i % 4),
      recordedAt: new Date(fakeNow + i * 1_000),
    });
  }
  const recAll = adaptive.recommendAll();
  assert(recAll.length === 1 && recAll[0].category === 'world', 'recommends per-category');
  const ts = recAll[0].recommendations.find((r) => r.metric === 'top_source_share');
  assert(ts?.confidence === 1, 'reaches max confidence at 5×minSamples');
  // Saturation risk under heavy dominance.
  for (let i = 0; i < 30; i += 1) {
    adaptive.record({
      category: 'sports',
      topSourceShare: 0.7,
      uniqueSources: 3,
      engagementCtr: 0.02,
      dwellSeconds: 9,
      recordedAt: new Date(fakeNow + i * 1_000),
    });
  }
  const sportsRec = adaptive.recommend('sports');
  assert(sportsRec?.saturationRisk === 'high', 'detects high saturation risk');

  // ---- beta analytics ----
  const beta = createBetaAnalytics({ crashHotspotThreshold: 0.05 });
  for (let u = 1; u <= 10; u += 1) {
    const first = new Date(fakeNow - 8 * 86_400_000);
    beta.ingest({
      cohort: 'early-access',
      userId: `u${u}`,
      occurredAt: first.toISOString(),
      active: true,
      featuresUsed: ['feed'],
      crashed: u === 1,
    });
    if (u <= 7) {
      beta.ingest({
        cohort: 'early-access',
        userId: `u${u}`,
        occurredAt: new Date(first.getTime() + 86_400_000).toISOString(),
        active: true,
        featuresUsed: ['feed', 'personalization'],
        crashed: false,
        satisfaction: u <= 5 ? 5 : 2,
      });
    }
  }
  const ret = beta.retention('early-access');
  assert(ret !== null && ret.cohortSize === 10, 'retention cohort size');
  assert((ret?.day1Retention ?? 0) >= 0.5, 'd1 retention computed');
  const adoption = beta.adoption('early-access', 'personalization');
  assert(adoption !== null && adoption.adopters === 7, 'feature adoption');
  const crash = beta.crashCorrelation('early-access');
  assert(crash?.flaggedAsHotspot === true, 'crash hotspot flagged at 10%');
  const sat = beta.satisfaction('early-access');
  assert(sat && sat.sampleSize === 7 && sat.promoterRate > 0, 'satisfaction breakdown');
  const impact = beta.incidentImpact('early-access', ['u1', 'u2']);
  assert(impact && impact.impactedUsers === 2, 'incident impact overlay');
}

// ---------------------------------------------------------------------------
// 1. Failed deployment rollback.
// ---------------------------------------------------------------------------

function testFailedDeploymentRollback(): void {
  section('1. Failed deployment rollback (migration mismatch → halt → rollback → lineage preserved)');
  const orchestrator = createReleaseOrchestrator(log, { now: nowFn });
  const lineage = createDeploymentLineage({ now: nowFn });
  const fp = buildFp('b100', 'rollbacksha');

  const session = orchestrator.plan(
    {
      build: fp,
      declaredMigrations: ['2025_add_ranking', '2025_add_personalization'],
      appliedMigrations: ['2025_add_ranking'], // personalization NOT applied → blocker
      flags: [
        {
          key: 'personalization_v1',
          enabled: true,
          rolloutPct: 25,
          dependsOn: [],
          requiresMigrations: ['2025_add_personalization'],
        },
      ],
      initiator: 'oncall',
      reason: 'deploy_personalization',
    },
    { dryRun: false },
  );
  assert(session.stage === 'PLANNED', 'plan stage = PLANNED');
  lineage.openSession({
    sessionId: session.sessionId,
    environment: 'production',
    build: {
      buildId: fp.buildId,
      gitSha: fp.gitSha,
      builtAt: fp.createdAt,
      packages: ['rss-engine'],
    },
    migrations: [
      { id: '2025_add_ranking', applied: true },
      { id: '2025_add_personalization', applied: false },
    ],
    flags: [{ key: 'personalization_v1', enabled: true, rolloutPct: 25 }],
    initiator: 'oncall',
    reason: 'deploy_personalization',
  });

  const post = orchestrator.preflight(session.sessionId);
  assert(post.stage === 'FAILED', 'preflight blocked → FAILED');
  assert(post.validation && !post.validation.ok, 'validation report not ok');
  assert(
    post.validation!.findings.some((f) => f.code === 'migration_not_applied'),
    'migration_not_applied surfaced',
  );
  assert(
    post.validation!.findings.some((f) => f.code === 'flag_requires_unapplied_migration'),
    'flag_requires_unapplied_migration surfaced',
  );

  // Lineage rollback to parent.
  lineage.rollback(session.sessionId, 'prev-session', 'preflight blocked');
  assert(lineage.get(session.sessionId)?.status === 'ROLLED_BACK', 'lineage marks ROLLED_BACK');
  assert(post.events.some((e) => e.to === 'FAILED'), 'session events captured FAILED');

  // Validator stand-alone confirms the same.
  const directReport = validateRelease({
    build: fp,
    declaredMigrations: ['m1'],
    appliedMigrations: [],
    flags: [],
    productionFreeze: false,
    dryRun: false,
    openSevereIncidentIds: [],
  });
  assert(!directReport.ok, 'validator rejects missing migration');
  assert(directReport.blockerCount >= 1, 'validator counts blockers');

  // Build fingerprint redeploy detection.
  const fp2 = buildFp('b100', 'rollbacksha');
  assert(fingerprintIsRedeploy(fp, fp2), 'identical inputs → redeploy detected');
  const fp3 = buildFp('b100', 'rollbacksha', { 'admin-panel': 'changed' });
  assert(!fingerprintIsRedeploy(fp, fp3), 'changed package hash → not redeploy');
}

// ---------------------------------------------------------------------------
// 2. Incident storm + stabilization → command center degrades correctly.
// ---------------------------------------------------------------------------

function testIncidentStormDegradesCommandCenter(): void {
  section('2. Incident storm + stabilization → command center / launch readiness blocked');

  // Healthy baseline.
  const healthy = composeCommandCenterSnapshot(
    {
      queues: [
        { name: 'ingestion', depth: 50, oldestPendingAgeMs: 5_000, inflight: 5, errorRate: 0 },
      ],
      workers: [{ workerId: 'w1', alive: true, lastHeartbeatMs: 5_000, crashCount24h: 0 }],
      rolloutStages: [],
      featureFlags: [],
      trafficGuard: { mode: 'normal' },
      notifications: { deliverySuccess: 0.99, fanoutBacklog: 0, failingProviders: [] },
      ranking: { lastRefreshAgeMs: 60_000, staleCategories: [] },
      personalization: { recomputeLagMs: 60_000, staleUserCount: 0 },
      db: { p95Ms: 80, p99Ms: 120, saturationPct: 0.1 },
      cron: { failedJobs24h: 0, skippedJobs24h: 0 },
      delivery: { totalAttempts: 1000, successRate: 0.99 },
      feedQuality: { diversityScore: 0.95, topSourceShare: 0.18 },
      autoscaler: { saturationPct: 0.2, consecutiveOverloadCycles: 0 },
      mobile: { errorRate: 0.005, p95LatencyMs: 200, unsupportedAppVersions: [] },
      openSevereIncidents: 0,
      openWarningIncidents: 0,
      rolloutPaused: false,
      backupsFresh: true,
      productionFreeze: false,
    },
    nowFn,
  );
  assert(healthy.health.classification === 'healthy', 'baseline healthy');
  assert(healthy.health.launchReadinessScore > 0.9, 'launch readiness > 0.9 baseline');

  // Storm.
  const storm = composeCommandCenterSnapshot(
    {
      queues: [
        { name: 'ingestion', depth: 8_000, oldestPendingAgeMs: 12 * 60_000, inflight: 50, errorRate: 0.3 },
        { name: 'notification', depth: 12_000, oldestPendingAgeMs: 30 * 60_000, inflight: 200, errorRate: 0.5 },
      ],
      workers: [
        { workerId: 'w1', alive: false, lastHeartbeatMs: 15 * 60_000, crashCount24h: 6 },
        { workerId: 'w2', alive: true, lastHeartbeatMs: 5 * 60_000, crashCount24h: 2 },
      ],
      rolloutStages: [],
      featureFlags: [],
      trafficGuard: { mode: 'emergency_throttle', reason: 'storm' },
      notifications: { deliverySuccess: 0.3, fanoutBacklog: 50_000, failingProviders: ['fcm', 'apns'] },
      ranking: { lastRefreshAgeMs: 60 * 60_000, staleCategories: ['world', 'sports'] },
      personalization: { recomputeLagMs: 90 * 60_000, staleUserCount: 100_000 },
      db: { p95Ms: 1_200, p99Ms: 2_500, saturationPct: 0.85 },
      cron: { failedJobs24h: 30, skippedJobs24h: 60 },
      delivery: { totalAttempts: 1000, successRate: 0.4 },
      feedQuality: { diversityScore: 0.6, topSourceShare: 0.4 },
      autoscaler: { saturationPct: 0.95, consecutiveOverloadCycles: 8 },
      mobile: { errorRate: 0.15, p95LatencyMs: 1_800, unsupportedAppVersions: ['1.0.0'] },
      openSevereIncidents: 3,
      openWarningIncidents: 5,
      rolloutPaused: true,
      backupsFresh: false,
      productionFreeze: false,
    },
    nowFn,
  );
  assert(storm.health.classification !== 'healthy', 'storm classified non-healthy');
  assert(storm.health.score < 0.6, 'storm health score < 0.6');
  assert(storm.health.risk === 'unstable', 'storm risk = unstable');
  assert(storm.health.launchReadinessScore < 0.5, 'launch readiness blocked');
  assert(
    storm.health.recommendations.some((r) => r.includes('SEVERE')),
    'recommends triaging severe incidents',
  );
  assert(storm.openSevereIncidents === 3, 'severe count surfaced');
  assert(storm.trafficGuard.mode === 'emergency_throttle', 'traffic guard mode surfaced');

  // SystemHealthScore standalone.
  const direct = computeSystemHealthScore({
    signals: [
      { key: 'queues', score: 0.2 },
      { key: 'workers', score: 0.3 },
      { key: 'db_latency', score: 0.4 },
    ],
    openSevereIncidents: 2,
    openWarningIncidents: 4,
    trafficGuardEngaged: true,
    rolloutPaused: true,
    backupsFresh: false,
    productionFreeze: true,
  });
  assert(direct.classification === 'critical', 'direct compute classifies critical');
  assert(direct.launchReadinessScore < 0.3, 'production-freeze multiplied readiness down');
}

// ---------------------------------------------------------------------------
// 3. Backup corruption scenario.
// ---------------------------------------------------------------------------

function testBackupCorruption(): void {
  section('3. Backup corruption → recovery confidence drops → CRITICAL alert');
  const coordinator = createBackupCoordinator({
    schedules: DEFAULT_BACKUP_SCHEDULES,
    now: nowFn,
  });

  // Fresh, verified daily.
  const daily = coordinator.recordBackup({
    id: 'bk-daily-1',
    tier: 'daily',
    createdAt: new Date(fakeNow - 2 * 3_600_000).toISOString(),
    sizeBytes: 1024,
    parentId: null,
  });
  coordinator.markVerified(daily.id);
  // Weekly + monthly to cover all tiers in freshnessScore averaging.
  const weekly = coordinator.recordBackup({
    id: 'bk-weekly-1',
    tier: 'weekly',
    createdAt: new Date(fakeNow - 3 * 86_400_000).toISOString(),
    sizeBytes: 4096,
    parentId: null,
  });
  coordinator.markVerified(weekly.id);
  const monthlySeed = coordinator.recordBackup({
    id: 'bk-monthly-1',
    tier: 'monthly',
    createdAt: new Date(fakeNow - 10 * 86_400_000).toISOString(),
    sizeBytes: 8192,
    parentId: null,
  });
  coordinator.markVerified(monthlySeed.id);
  // Continuous backups — cont-1 is OLDEST, cont-3 is most recent.
  for (let i = 1; i <= 3; i += 1) {
    const r = coordinator.recordBackup({
      id: `bk-cont-${i}`,
      tier: 'continuous',
      createdAt: new Date(fakeNow - (4 - i) * 5 * 60_000).toISOString(),
      sizeBytes: 200,
      parentId: i === 1 ? null : `bk-cont-${i - 1}`,
    });
    coordinator.markVerified(r.id);
  }
  const baseFreshness = coordinator.freshnessScore();
  assert(baseFreshness > 0.5, 'fresh+verified backups score well');
  const lin = coordinator.lineage('bk-cont-3');
  assert(lin.length === 3, 'lineage walks parent chain');

  // Corrupt the latest continuous backup (cont-3 @ -5min).
  coordinator.markCorrupted('bk-cont-3', 'checksum_mismatch');
  const afterCorruption = coordinator.freshness().find((f) => f.tier === 'continuous');
  // After corruption, latest valid continuous = cont-2 @ -10min.
  assert(
    afterCorruption?.latestAt === new Date(fakeNow - 10 * 60_000).toISOString(),
    'corrupted excluded from latest',
  );

  // Stale schedule check — drop monthly to verify "missing tier" path.
  const coordinator2 = createBackupCoordinator({ schedules: DEFAULT_BACKUP_SCHEDULES, now: nowFn });
  const monthly = coordinator2.freshness().find((f) => f.tier === 'monthly');
  assert(monthly?.latestAt === null, 'no monthly backup recorded → null latest');
  assert(monthly?.withinRpo === false, 'no monthly backup violates RPO');

  // Recovery verification with corruption.
  const recovery = verifyRecovery({
    replay: {
      replayedEvents: 1000,
      postReplayStateChecksum: 'AAA',
      expectedStateChecksum: 'BBB',
    },
    queues: {
      preCrashPending: 100,
      postRecoveryPending: 102,
      preCrashInflight: 10,
      postRecoveryInflight: 8,
      lostJobIds: ['j99'],
    },
    notifications: {
      alreadyDeliveredIds: ['n1', 'n2'],
      attemptedIds: ['n1', 'n2', 'n3'],
      dispatchedIds: ['n3', 'n1'], // n1 duplicate → fail
    },
    rankingRebuild: {
      changedCount: 800,
      totalCount: 1000,
      averageRankDelta: 25,
      toleranceDelta: 5,
    },
    personalizationCache: {
      totalUsers: 100,
      rebuiltUsers: 50,
      failedUsers: Array.from({ length: 30 }, (_, i) => `u${i}`),
    },
    workerState: {
      expectedWorkers: ['w1', 'w2'],
      recoveredWorkers: ['w1'],
      orphanedLeases: ['lease1'],
    },
  });
  assert(recovery.status === 'fail', 'recovery overall status = fail');
  assert(recovery.confidenceScore < 0.5, 'confidence < 0.5 under corruption');
  assert(
    recovery.components.find((c) => c.component === 'replay')?.status === 'fail',
    'replay checksum mismatch fails',
  );
  assert(
    recovery.components.find((c) => c.component === 'notifications')?.status === 'fail',
    'duplicate notification dispatch fails',
  );
  assert(
    recovery.components.find((c) => c.component === 'ranking_rebuild')?.status === 'fail',
    'ranking rebuild outside tolerance fails',
  );
  assert(
    recovery.components.find((c) => c.component === 'worker_state')?.status === 'fail',
    'missing worker fails',
  );

  // Clean recovery path.
  const clean = verifyRecovery({
    replay: { replayedEvents: 100, postReplayStateChecksum: 'X', expectedStateChecksum: 'X' },
    queues: {
      preCrashPending: 100,
      postRecoveryPending: 100,
      preCrashInflight: 10,
      postRecoveryInflight: 10,
      lostJobIds: [],
    },
    notifications: { alreadyDeliveredIds: ['n1'], attemptedIds: ['n2'], dispatchedIds: ['n2'] },
    rankingRebuild: { changedCount: 10, totalCount: 1000, averageRankDelta: 2, toleranceDelta: 5 },
    personalizationCache: { totalUsers: 100, rebuiltUsers: 100, failedUsers: [] },
    workerState: { expectedWorkers: ['w1'], recoveredWorkers: ['w1'], orphanedLeases: [] },
  });
  assert(clean.status === 'pass', 'clean recovery passes');
  assert(clean.confidenceScore >= 0.95, 'clean recovery confidence ≥ 0.95');
}

// ---------------------------------------------------------------------------
// 4. SEO degradation.
// ---------------------------------------------------------------------------

function testSeoDegradation(): void {
  section('4. SEO degradation (stale sitemap, duplicate metadata, indexing drift)');

  const sitemap = createSitemapCoordinator({ now: nowFn });
  sitemap.registerSitemap({
    name: 'sitemap_news.xml',
    type: 'news',
    lastBuiltAt: new Date(fakeNow - 60 * 60_000).toISOString(), // 60min stale
    entryCount: 100,
  });
  sitemap.registerSitemap({
    name: 'sitemap_main.xml',
    type: 'standard',
    lastBuiltAt: new Date(fakeNow - 60_000).toISOString(),
    entryCount: 5000,
  });
  const sitemapHealth = sitemap.healthAll();
  assert(sitemapHealth.find((h) => h.name === 'sitemap_news.xml')?.status === 'stale', 'news sitemap stale');
  assert(sitemapHealth.find((h) => h.name === 'sitemap_main.xml')?.status === 'fresh', 'main sitemap fresh');
  assert(sitemap.overallScore() < 1, 'overall sitemap score < 1');

  // Two articles with identical title+description.
  const articles = [
    {
      url: 'https://newsera.test/a',
      canonicalUrl: 'https://newsera.test/a',
      title: 'Breaking: Test happened',
      description: 'A test occurred today.',
      ogTitle: 'Breaking: Test happened',
      ogDescription: 'A test occurred today.',
      ogImage: 'https://newsera.test/img.png',
      ogType: 'article',
      twitterCard: 'summary',
      twitterTitle: 'Breaking: Test happened',
      twitterDescription: 'A test occurred today.',
      twitterImage: null,
      jsonLd: [
        {
          '@type': 'NewsArticle',
          headline: 'Breaking: Test happened',
          datePublished: new Date(fakeNow).toISOString(),
          author: 'Reporter',
          image: 'https://newsera.test/img.png',
        },
      ],
      h1: 'Breaking: Test happened',
    },
    {
      url: 'https://newsera.test/b',
      canonicalUrl: 'https://newsera.test/b',
      title: 'Breaking: Test happened',
      description: 'A test occurred today.',
      ogTitle: 'Breaking: Test happened',
      ogDescription: 'A test occurred today.',
      ogImage: 'https://newsera.test/img.png',
      ogType: 'article',
      twitterCard: 'summary',
      twitterTitle: 'Breaking: Test happened',
      twitterDescription: 'A test occurred today.',
      twitterImage: null,
      jsonLd: [
        {
          '@type': 'NewsArticle',
          headline: 'Breaking: Test happened',
          // intentionally missing datePublished/author/image to trip validator
        },
      ],
      h1: 'Breaking: Test happened',
    },
  ];
  const schemaResults = articles.map(validateArticleSchema);
  assert(schemaResults[0].ok === true, 'complete article passes schema');
  assert(schemaResults[1].ok === false, 'incomplete JSON-LD fails schema');
  const dupes = detectDuplicateContent(articles);
  assert(dupes.length === 1 && dupes[0].urls.length === 2, 'duplicate-content detector clusters dupes');

  // Indexing drift.
  const indexer = createNewsIndexingMonitor({ now: nowFn, indexingSlaMs: 30 * 60_000 });
  indexer.recordPublication({
    url: 'https://newsera.test/a',
    publishedAt: new Date(fakeNow - 60 * 60_000).toISOString(),
    category: 'tech',
    sourceAuthority: 0.8,
  });
  indexer.recordPublication({
    url: 'https://newsera.test/b',
    publishedAt: new Date(fakeNow - 90 * 60_000).toISOString(),
    category: 'tech',
    sourceAuthority: 0.6,
  });
  // 'a' was crawled-but-not-indexed; 'b' fully missing.
  indexer.recordObservation({ url: 'https://newsera.test/a', indexer: 'google_news', observedAt: new Date(fakeNow).toISOString(), state: 'crawled' });
  const drift = indexer.drift();
  assert(drift.length === 2, 'two URLs flagged for drift');
  assert(indexer.driftScore() < 0.5, 'drift score below 0.5');
  const velocity = indexer.velocity('tech');
  assert(velocity.length === 1 && velocity[0].category === 'tech', 'velocity per category');
  assert(indexer.sourceAuthority('newsera.test') > 0, 'source authority computed');

  const seo = auditSeoHealth({
    schemaResults,
    sitemapHealth,
    recentArticles: [
      { url: 'a', publishedAt: new Date(fakeNow - 10 * 86_400_000).toISOString(), ageMs: 10 * 86_400_000 },
      { url: 'b', publishedAt: new Date(fakeNow - 1 * 86_400_000).toISOString(), ageMs: 1 * 86_400_000 },
    ],
    indexingDriftScore: indexer.driftScore(),
    sourceAuthority: { 'newsera.test': 0.7 },
    duplicateClusterCount: dupes.length,
    now: nowFn,
  });
  assert(seo.classification !== 'healthy', 'SEO classified non-healthy');
  assert(seo.overallScore < 0.9, 'SEO overall score < 0.9');
  assert(seo.topIssues.length >= 2, 'multiple top issues surfaced');

  // Social distribution monitor — simple ctr anomaly.
  const social = createSocialDistributionMonitor({ now: nowFn });
  social.recordAttempt({ channel: 'twitter', articleId: 'a', attemptedAt: new Date(fakeNow).toISOString(), ok: true });
  social.recordAttempt({ channel: 'twitter', articleId: 'b', attemptedAt: new Date(fakeNow).toISOString(), ok: false, errorCode: 'rate_limit' });
  social.recordEngagement({ channel: 'twitter', articleId: 'a', observedAt: new Date(fakeNow).toISOString(), impressions: 100, shares: 5, clicks: 10 });
  social.recordAttribution({ source: 'twitter', reportedHits: 100, servedHits: 50 });
  const ch = social.channelHealth();
  assert(ch.length === 1 && ch[0].channel === 'twitter', 'social channel health');
  assert(social.attributionAnomalies().some((a) => a.source === 'twitter'), 'attribution divergence detected');
  assert(social.shareVelocity('twitter') > 0, 'share velocity computed');
}

// ---------------------------------------------------------------------------
// 5. Ad fraud spike.
// ---------------------------------------------------------------------------

function testAdFraudSpike(): void {
  section('5. Ad fraud spike → monetization guard triggered');

  // Placement guard.
  const guard = createAdPlacementGuard({ maxAdsPerArticle: 2, maxAdsPerSession: 3, cooldownMs: 30_000 });
  const baseSlot = {
    slotId: 'inline_1',
    position: 'inline_1' as const,
    articleId: 'art-1',
    userId: 'u-1',
    sessionId: 's-1',
    requestedAt: new Date(fakeNow).toISOString(),
  };
  const v1 = guard.evaluate(baseSlot);
  assert(v1.allowed, 'first ad allowed');
  guard.confirm(baseSlot);
  // Same slot again on same article → duplicate impression first.
  const vDup = guard.evaluate({ ...baseSlot, requestedAt: new Date(fakeNow + 1_000).toISOString() });
  assert(!vDup.allowed && vDup.reason === 'duplicate_impression', 'duplicate impression blocked');
  // Different article, same slotId (and same user) within cooldown → cooldown.
  const vCool = guard.evaluate({
    ...baseSlot,
    articleId: 'art-2',
    requestedAt: new Date(fakeNow + 1_000).toISOString(),
  });
  assert(!vCool.allowed && vCool.reason === 'cooldown_active', 'cooldown blocks rapid retry');
  const v3 = guard.evaluate({
    ...baseSlot,
    slotId: 'sticky_bottom',
    position: 'sticky_bottom',
    requestedAt: new Date(fakeNow + 1_000).toISOString(),
  });
  assert(!v3.allowed && v3.reason === 'above_the_fold_spam', 'above-fold spam blocked');
  // Density per article.
  guard.confirm({ ...baseSlot, slotId: 'inline_2', position: 'inline_2', requestedAt: new Date(fakeNow + 60_000).toISOString() });
  const v4 = guard.evaluate({ ...baseSlot, slotId: 'inline_3', position: 'inline_3', requestedAt: new Date(fakeNow + 120_000).toISOString() });
  assert(!v4.allowed && v4.reason === 'density_per_article', 'density-per-article enforced');

  // Click fraud signals.
  const fraud = createClickFraudSignals({
    now: nowFn,
    burstUserThreshold: 5,
    burstIpThreshold: 10,
    ctrSpikeRatio: 4,
  });
  for (let i = 0; i < 12; i += 1) {
    fraud.ingestClick({
      userId: 'attacker',
      sessionId: 'sess-x',
      ipHash: 'ip-1',
      userAgent: 'curl/7.79',
      articleId: 'a',
      slotId: 'inline_1',
      occurredAt: new Date(fakeNow + i * 1_000).toISOString(),
    });
  }
  for (let i = 0; i < 50; i += 1) {
    fraud.ingestImpression({
      userId: 'normal',
      sessionId: 's',
      ipHash: 'ip-2',
      articleId: 'a',
      slotId: 'inline_1',
      occurredAt: new Date(fakeNow + i * 1_000).toISOString(),
    });
  }
  const findings = fraud.evaluate();
  assert(findings.some((f) => f.type === 'click_burst_user' && f.subject === 'attacker'), 'click burst per user');
  assert(findings.some((f) => f.type === 'suspicious_user_agent'), 'suspicious UA flagged');
  assert(findings.some((f) => f.type === 'duplicate_click'), 'duplicate click flagged');
  assert(findings.some((f) => f.type === 'ctr_anomaly'), 'CTR anomaly flagged');

  // Revenue health.
  const revenue = createRevenueHealth({ now: nowFn, windowMs: 60 * 60_000 });
  // Baseline (previous hour): 100 impressions, normal revenue, normal engagement.
  for (let i = 0; i < 10; i += 1) {
    revenue.ingest({
      source: 'src-a',
      impressions: 10,
      filledImpressions: 8,
      revenueMicros: 50_000,
      engagementScore: 0.4,
      occurredAt: new Date(fakeNow - 90 * 60_000 + i * 60_000).toISOString(),
    });
  }
  // Current window: same engagement, revenue collapses → anomaly.
  for (let i = 0; i < 10; i += 1) {
    revenue.ingest({
      source: 'src-a',
      impressions: 10,
      filledImpressions: 8,
      revenueMicros: 5_000,
      engagementScore: 0.4,
      occurredAt: new Date(fakeNow - 30 * 60_000 + i * 60_000).toISOString(),
    });
  }
  const snap = revenue.windowSnapshot();
  assert(snap.totalImpressions === 100, 'window aggregates impressions');
  assert(snap.fillRate > 0, 'fill rate computed');
  const breakdown = revenue.sourceBreakdown();
  assert(breakdown.length === 1 && breakdown[0].source === 'src-a', 'source breakdown');
  const trend = revenue.rpmTrend(4);
  assert(trend.length === 4, 'rpm trend bucketed');
  const anomalies = revenue.anomalies();
  assert(anomalies.some((a) => a.source === 'src-a' && a.divergence < 0), 'revenue/engagement divergence detected');
}

// ---------------------------------------------------------------------------
// 6. Mobile rollout crash spike.
// ---------------------------------------------------------------------------

function testMobileCrashSpike(): void {
  section('6. Mobile rollout crash spike → compatibility guard + rollback recommended');

  const crash = createCrashCorrelation({
    now: nowFn,
    spikeRatioThreshold: 3,
    baselineWindowMs: 6 * 3_600_000,
    observationWindowMs: 60 * 60_000,
  });
  // Baseline: 2 crashes in last 6h before observation window.
  for (let i = 0; i < 2; i += 1) {
    crash.ingest({
      appVersion: '2.4.1',
      os: 'ios',
      fingerprint: 'NPE-feed',
      occurredAt: new Date(fakeNow - (6 * 3_600_000 + 1) + i * 60_000).toISOString(),
    });
  }
  // Observation window: 20 crashes, all in the new rollout bucket.
  for (let i = 0; i < 20; i += 1) {
    crash.ingest({
      appVersion: '2.5.0',
      os: 'ios',
      fingerprint: 'NPE-feed',
      flagBucket: 'personalization_v2',
      occurredAt: new Date(fakeNow - 30 * 60_000 + i * 60_000).toISOString(),
    });
  }
  crash.registerRollout({
    flag: 'personalization_v2',
    startedAt: new Date(fakeNow - 45 * 60_000).toISOString(),
  });

  const spikes = crash.spikes();
  assert(spikes.length >= 1, 'crash spike detected');
  assert(spikes[0].suspectedRollout === 'personalization_v2', 'rollout suspected');
  assert(spikes[0].severity === 'severe', 'severe spike classification');

  const mappings = crash.rolloutMappings();
  assert(mappings.length === 1 && mappings[0].recommendsRollback, 'rollback recommended');

  // API compatibility guard.
  const schemas = [
    { endpoint: 'GET /v1/feed', version: '1', fields: [{ path: 'items[].id', type: 'string', optional: false }] },
  ];
  const previous = [
    {
      endpoint: 'GET /v1/feed',
      version: '0.9',
      fields: [
        { path: 'items[].id', type: 'string', optional: false },
        { path: 'items[].legacy', type: 'string', optional: true },
      ],
    },
    { endpoint: 'GET /v1/legacy', version: '0.9', fields: [], deprecated: true },
  ];
  const apps = [
    { version: '2.4.1', status: 'supported' as const, requiredEndpoints: ['GET /v1/feed', 'GET /v1/legacy'], releasedAt: new Date(fakeNow - 30 * 86_400_000).toISOString(), activeInstalls: 5000 },
    { version: '1.0.0', status: 'unsupported' as const, requiredEndpoints: ['GET /v1/feed'], releasedAt: new Date(fakeNow - 365 * 86_400_000).toISOString(), activeInstalls: 1500 },
  ];
  const compat = evaluateApiCompatibility(schemas, apps, previous);
  assert(!compat.ok, 'compatibility not OK');
  assert(compat.issues.some((i) => i.type === 'missing_endpoint' && i.endpoint === 'GET /v1/legacy'), 'missing endpoint detected');
  assert(compat.issues.some((i) => i.type === 'breaking_field_change'), 'breaking field removal detected');
  assert(compat.issues.some((i) => i.type === 'unsupported_version_active'), 'unsupported version active flagged');

  const readiness = evaluateMobileRelease({
    compatibility: compat,
    crashSpikes: spikes,
    rolloutMappings: mappings,
    config: {
      version: '2.5.0',
      requiredKeys: ['api_base_url', 'feature_flags'],
      values: { api_base_url: 'https://api', feature_flags: {} },
      enabledFlags: ['personalization_v2'],
      channel: 'production',
    },
    appStore: {
      hasPrivacyManifest: true,
      hasReleaseNotes: true,
      hasScreenshots: true,
      passesTosCheck: true,
      binarySigned: true,
    },
  });
  assert(!readiness.ok, 'mobile release blocked');
  assert(readiness.recommendation === 'rollback', 'recommendation = rollback');

  // Missing config → blocker.
  const missingConfig = evaluateMobileRelease({
    compatibility: { ok: true, issues: [], summary: { supportedVersions: 1, sunsetVersions: 0, unsupportedActive: 0, deprecatedEndpointsInUse: 0 } },
    crashSpikes: [],
    rolloutMappings: [],
    config: {
      version: '2.5.0',
      requiredKeys: ['api_base_url'],
      values: {},
      enabledFlags: [],
      channel: 'production',
    },
    appStore: { hasPrivacyManifest: true, hasReleaseNotes: true, hasScreenshots: true, passesTosCheck: true, binarySigned: true },
  });
  assert(!missingConfig.ok, 'missing config blocks');
  assert(missingConfig.blockers.some((b) => b.includes('api_base_url')), 'missing key surfaced');
}

// ---------------------------------------------------------------------------
// 7. Compliance breach simulation.
// ---------------------------------------------------------------------------

function testComplianceBreach(): void {
  section('7. Compliance breach (debug endpoint, stale admin, retention violation)');

  const boundary = createAccessBoundaryAudit({ now: nowFn, staleTokenMs: 30 * 86_400_000, orphanedUserMs: 30 * 86_400_000 });
  const findings = boundary.audit({
    grants: [
      { resource: 'rpc:admin_set_flag', roles: ['admin', 'anon'], adminOnly: true },
      { resource: 'rpc:public_search', roles: ['anon'], adminOnly: false },
    ],
    rolloutPermissions: [
      {
        userId: 'u-old',
        scope: 'rollout:approve',
        grantedAt: new Date(fakeNow - 60 * 86_400_000).toISOString(),
        expiresAt: new Date(fakeNow - 10 * 86_400_000).toISOString(),
      },
    ],
    tokens: [
      {
        id: 't-1',
        userId: 'admin-1',
        issuedAt: new Date(fakeNow - 100 * 86_400_000).toISOString(),
        lastUsedAt: new Date(fakeNow - 60 * 86_400_000).toISOString(),
        scopes: ['admin'],
      },
    ],
    privileged: [
      {
        userId: 'admin-2',
        roles: ['admin'],
        lastLoginAt: new Date(fakeNow - 120 * 86_400_000).toISOString(),
        deactivated: false,
      },
      { userId: 'admin-3', roles: ['admin'], lastLoginAt: null, deactivated: true },
    ],
  });
  assert(findings.some((f) => f.type === 'unsafe_admin_exposure'), 'unsafe admin exposure detected');
  assert(findings.some((f) => f.type === 'expired_rollout_permission'), 'expired permission detected');
  assert(findings.some((f) => f.type === 'stale_token' && f.severity === 'severe'), 'stale admin token severe');
  assert(findings.filter((f) => f.type === 'orphaned_privileged_user').length === 2, 'two orphaned privileged users');

  // Retention.
  const retention = evaluateRetention(DEFAULT_RETENTION_RULES, [
    { table: 'session_tokens', oldestRowAgeMs: 60 * 86_400_000, rowsExceedingAge: 100, totalRows: 200 },
    { table: 'analytics_events', oldestRowAgeMs: 30 * 86_400_000, rowsExceedingAge: 0, totalRows: 100 },
  ]);
  assert(retention.length === 1 && retention[0].table === 'session_tokens', 'only session_tokens violates');
  assert(retention[0].severity === 'severe', 'high PII → severe');

  // Compliance roll-up.
  const compliance = auditCompliance(
    {
      productionLogSamples: [
        'INFO request from user 555-12-3434',
        'DEBUG: starting handler',
        'INFO request user@example.com signed in',
      ],
      productionRoutes: ['/v1/feed', '/__debug/state', '/api/personalize'],
      isProduction: true,
      notificationTopics: [
        { topic: 'breaking', audienceSize: 500_000, requiresOptIn: false },
        { topic: 'sports', audienceSize: 50_000, requiresOptIn: true },
      ],
      queueAcceptedJobTypes: ['ingest', 'rank', 'rogue_replay'],
      queueDeclaredJobTypes: ['ingest', 'rank', 'notify'],
      mutationAuditCoverage: {
        admin_set_flag: true,
        admin_force_rollback: false,
      },
      envKeys: ['SUPABASE_URL', 'SUPABASE_KEY'],
      expectedEnvKeys: ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE'],
    },
    findings,
    retention,
  );
  assert(compliance.launchBlockers.length > 0, 'launch blockers produced');
  assert(compliance.allFindings.some((f) => f.code === 'pii_logging'), 'PII logging flagged');
  assert(compliance.allFindings.some((f) => f.code === 'debug_endpoint_exposed'), 'debug endpoint flagged');
  assert(compliance.allFindings.some((f) => f.code === 'queue_poisoning_vector'), 'queue poisoning flagged');
  assert(compliance.allFindings.some((f) => f.code === 'replay_abuse_opportunity'), 'replay sink flagged');
  assert(compliance.allFindings.some((f) => f.code === 'missing_audit_lineage'), 'missing audit lineage flagged');
  assert(compliance.allFindings.some((f) => f.code === 'excessive_notification_exposure'), 'excessive notification exposure flagged');
  assert(compliance.allFindings.some((f) => f.code === 'env_mismatch'), 'env mismatch flagged');
  assert(compliance.finalComplianceScore < 0.7, 'compliance score depressed');
}

// ---------------------------------------------------------------------------
// 8. Full production readiness simulation.
// ---------------------------------------------------------------------------

function testFullProductionReadiness(): void {
  section('8. Full production readiness — green path');

  const orchestrator = createReleaseOrchestrator(log, { now: nowFn });
  const fp = buildFp('b777', 'goldensha');

  const session = orchestrator.plan(
    {
      build: fp,
      declaredMigrations: ['m1', 'm2'],
      appliedMigrations: ['m1', 'm2'],
      flags: [
        { key: 'queue_based_ingestion', enabled: true, rolloutPct: 100, dependsOn: [], requiresMigrations: ['m1'] },
        { key: 'ranking_v1', enabled: true, rolloutPct: 100, dependsOn: ['queue_based_ingestion'], requiresMigrations: ['m2'] },
      ],
      initiator: 'launch-captain',
      reason: 'public_launch',
    },
    { dryRun: false },
  );
  assert(session.stage === 'PLANNED', 'planned');

  const after = orchestrator.preflight(session.sessionId);
  assert(after.validation?.ok, 'preflight passes');

  orchestrator.beginMigrations(session.sessionId);
  orchestrator.beginDeploy(session.sessionId);
  const verified = orchestrator.beginVerification(session.sessionId, {
    healthScore: 0.97,
    queueLatencyMs: 200,
    errorSpikeRatio: 1.0,
    notificationFailurePct: 0.005,
    rankingFreshnessMs: 60_000,
    mobileReady: true,
  });
  assert(verified.stage === 'VERIFYING', 'verifying');
  const stable = orchestrator.markStabilized(session.sessionId);
  assert(stable.stage === 'STABILIZED', 'stabilized');

  // Replay protection.
  const replayAttempt = orchestrator.plan(
    {
      build: fp,
      declaredMigrations: ['m1', 'm2'],
      appliedMigrations: ['m1', 'm2'],
      flags: [],
      initiator: 'launch-captain',
      reason: 'accidental redeploy',
    },
    { dryRun: false },
  );
  const replayEvent = replayAttempt.events[0];
  assert(replayEvent.detail?.replay_blocked === true, 'replay blocked');

  // Environment diff parity.
  const snapA = {
    environment: 'green' as const,
    build: fp,
    flags: { ranking_v1: { enabled: true, rolloutPct: 100 } },
    migrationsApplied: ['m1', 'm2'],
    cronJobsActive: ['ingest_cron'],
    markers: { region: 'us-east' },
  };
  const snapB = { ...snapA, environment: 'blue' as const };
  const diff = diffEnvironments(snapA, snapB);
  assert(diff.isParity, 'environment parity holds');
  assert(summarizeDiff(diff) === 'parity', 'summarize parity');

  const drifted = diffEnvironments(snapA, {
    ...snapA,
    flags: { ranking_v1: { enabled: false, rolloutPct: 0 } },
    migrationsApplied: ['m1'],
  });
  assert(!drifted.isParity, 'drift detected');
  assert(drifted.flagsChanged.length === 1 && drifted.migrationsBehind.length === 1, 'drift specifics');

  // Production freeze toggling.
  orchestrator.setProductionFreeze(true, 'launch-captain', 'freeze for launch');
  assert(orchestrator.isProductionFrozen(), 'freeze active');
  const frozenPlan = orchestrator.plan(
    {
      build: buildFp('b778', 'frozensha'),
      declaredMigrations: [],
      appliedMigrations: [],
      flags: [],
      initiator: 'op',
      reason: 'try while frozen',
    },
    { dryRun: false },
  );
  const frozenPre = orchestrator.preflight(frozenPlan.sessionId);
  assert(frozenPre.stage === 'FAILED', 'frozen plan fails preflight');
  orchestrator.setProductionFreeze(false, 'launch-captain', 'unfreeze');

  // Healthy command-center snapshot → launch readiness > 0.95.
  const snapshot = composeCommandCenterSnapshot(
    {
      queues: [
        { name: 'ingestion', depth: 20, oldestPendingAgeMs: 1_000, inflight: 4, errorRate: 0 },
        { name: 'ranking', depth: 5, oldestPendingAgeMs: 200, inflight: 1, errorRate: 0 },
      ],
      workers: [
        { workerId: 'w1', alive: true, lastHeartbeatMs: 1_000, crashCount24h: 0 },
        { workerId: 'w2', alive: true, lastHeartbeatMs: 1_000, crashCount24h: 0 },
      ],
      rolloutStages: [],
      featureFlags: [],
      trafficGuard: { mode: 'normal' },
      notifications: { deliverySuccess: 0.995, fanoutBacklog: 0, failingProviders: [] },
      ranking: { lastRefreshAgeMs: 30_000, staleCategories: [] },
      personalization: { recomputeLagMs: 30_000, staleUserCount: 0 },
      db: { p95Ms: 50, p99Ms: 90, saturationPct: 0.1 },
      cron: { failedJobs24h: 0, skippedJobs24h: 0 },
      delivery: { totalAttempts: 5_000, successRate: 0.995 },
      feedQuality: { diversityScore: 0.97, topSourceShare: 0.15 },
      autoscaler: { saturationPct: 0.05, consecutiveOverloadCycles: 0 },
      mobile: { errorRate: 0.001, p95LatencyMs: 100, unsupportedAppVersions: [] },
      openSevereIncidents: 0,
      openWarningIncidents: 0,
      rolloutPaused: false,
      backupsFresh: true,
      productionFreeze: false,
    },
    nowFn,
  );
  assert(snapshot.health.classification === 'healthy', 'healthy classification');
  assert(snapshot.health.launchReadinessScore > 0.95, 'launch readiness > 0.95');
  assert(snapshot.health.risk === 'stable', 'risk stable');

  // Clean compliance.
  const cleanCompliance = auditCompliance(
    {
      productionLogSamples: ['INFO request handled in 12ms', 'INFO ranking refreshed'],
      productionRoutes: ['/v1/feed', '/v1/notifications'],
      isProduction: true,
      notificationTopics: [{ topic: 'sports', audienceSize: 10_000, requiresOptIn: true }],
      queueAcceptedJobTypes: ['ingest', 'rank'],
      queueDeclaredJobTypes: ['ingest', 'rank'],
      mutationAuditCoverage: { admin_set_flag: true },
      envKeys: ['SUPABASE_URL', 'SUPABASE_KEY'],
      expectedEnvKeys: ['SUPABASE_URL', 'SUPABASE_KEY'],
    },
    [],
    [],
  );
  assert(cleanCompliance.launchBlockers.length === 0, 'no compliance blockers');
  assert(cleanCompliance.finalComplianceScore === 1, 'compliance score = 1');
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testPhaseFDebts();
  testFailedDeploymentRollback();
  testIncidentStormDegradesCommandCenter();
  testBackupCorruption();
  testSeoDegradation();
  testAdFraudSpike();
  testMobileCrashSpike();
  testComplianceBreach();
  testFullProductionReadiness();

  // eslint-disable-next-line no-console
  console.log(`\nAssertions: ${assertions}, failures: ${failures}`);
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error('Phase G simulation: FAIL');
    process.exit(1);
  }
  if (assertions < 120) {
    // eslint-disable-next-line no-console
    console.error(`Phase G simulation: assertion count ${assertions} < 120 target`);
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.log('\nPhase G simulation: OK');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
