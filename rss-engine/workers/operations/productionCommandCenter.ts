/**
 * Phase G — Production command center.
 *
 * Aggregates every live observability signal into a single snapshot the
 * operator dashboard can render. Sits ABOVE the individual monitors —
 * queues, workers, incidents, rollout stages, feature flags, traffic
 * guards, notification health, ranking freshness, personalization
 * freshness, DB latency, cron health, delivery health, feed quality,
 * autoscaler pressure, mobile API health.
 *
 * Pure compute. The host pushes individual subsystem snapshots in; the
 * command center composes them and runs the system health score.
 */

import { computeSystemHealthScore } from './systemHealthScore';
import type { SubsystemSignal, SystemHealthScore } from './systemHealthScore';

export interface QueueSnapshot {
  name: string;
  depth: number;
  oldestPendingAgeMs: number;
  inflight: number;
  errorRate: number; // 0..1
}

export interface WorkerSnapshot {
  workerId: string;
  alive: boolean;
  lastHeartbeatMs: number;
  crashCount24h: number;
}

export interface RolloutStageSnapshot {
  flag: string;
  status: string;
  exposurePct: number;
  startedAtMs: number;
}

export interface FeatureFlagSnapshot {
  key: string;
  enabled: boolean;
  rolloutPct: number;
}

export interface TrafficGuardSnapshot {
  mode: 'normal' | 'degraded' | 'emergency_throttle';
  reason?: string;
}

export interface NotificationHealthSnapshot {
  deliverySuccess: number; // 0..1
  fanoutBacklog: number;
  failingProviders: string[];
}

export interface RankingFreshnessSnapshot {
  lastRefreshAgeMs: number;
  staleCategories: string[];
}

export interface PersonalizationFreshnessSnapshot {
  recomputeLagMs: number;
  staleUserCount: number;
}

export interface DbLatencySnapshot {
  p95Ms: number;
  p99Ms: number;
  saturationPct: number; // 0..1
}

export interface CronHealthSnapshot {
  failedJobs24h: number;
  skippedJobs24h: number;
}

export interface DeliveryHealthSnapshot {
  totalAttempts: number;
  successRate: number;
}

export interface FeedQualitySnapshot {
  diversityScore: number; // 0..1
  topSourceShare: number;
}

export interface AutoscalerPressureSnapshot {
  saturationPct: number; // 0..1
  consecutiveOverloadCycles: number;
}

export interface MobileApiHealthSnapshot {
  errorRate: number;
  p95LatencyMs: number;
  unsupportedAppVersions: string[];
}

export interface CommandCenterInput {
  queues: QueueSnapshot[];
  workers: WorkerSnapshot[];
  rolloutStages: RolloutStageSnapshot[];
  featureFlags: FeatureFlagSnapshot[];
  trafficGuard: TrafficGuardSnapshot;
  notifications: NotificationHealthSnapshot;
  ranking: RankingFreshnessSnapshot;
  personalization: PersonalizationFreshnessSnapshot;
  db: DbLatencySnapshot;
  cron: CronHealthSnapshot;
  delivery: DeliveryHealthSnapshot;
  feedQuality: FeedQualitySnapshot;
  autoscaler: AutoscalerPressureSnapshot;
  mobile: MobileApiHealthSnapshot;
  openSevereIncidents: number;
  openWarningIncidents: number;
  rolloutPaused: boolean;
  backupsFresh: boolean;
  productionFreeze: boolean;
}

export interface CommandCenterSnapshot {
  generatedAt: string;
  health: SystemHealthScore;
  subsystems: Record<string, { score: number; detail: Record<string, unknown> }>;
  trafficGuard: TrafficGuardSnapshot;
  productionFreeze: boolean;
  rolloutPaused: boolean;
  openSevereIncidents: number;
  openWarningIncidents: number;
}

function score01(value: number, ok: number, bad: number, invert = false): number {
  if (ok === bad) return 1;
  const ratio = (value - ok) / (bad - ok);
  const raw = 1 - Math.max(0, Math.min(1, ratio));
  return invert ? 1 - raw : raw;
}

function queueScore(qs: QueueSnapshot[]): { score: number; detail: Record<string, unknown> } {
  if (qs.length === 0) return { score: 1, detail: { queues: 0 } };
  const depthScore = qs.map((q) => score01(q.depth, 100, 5_000));
  const ageScore = qs.map((q) => score01(q.oldestPendingAgeMs, 30_000, 600_000));
  const errScore = qs.map((q) => 1 - Math.min(1, q.errorRate * 4));
  const all = [...depthScore, ...ageScore, ...errScore];
  const score = all.reduce((s, v) => s + v, 0) / all.length;
  return {
    score,
    detail: {
      queues: qs.length,
      max_depth: Math.max(...qs.map((q) => q.depth)),
      max_oldest_age_ms: Math.max(...qs.map((q) => q.oldestPendingAgeMs)),
    },
  };
}

function workerScore(ws: WorkerSnapshot[]): { score: number; detail: Record<string, unknown> } {
  if (ws.length === 0) return { score: 0, detail: { workers: 0 } };
  const aliveRatio = ws.filter((w) => w.alive).length / ws.length;
  const crashes = ws.reduce((s, w) => s + w.crashCount24h, 0);
  const heartbeatPenalty =
    ws.reduce((s, w) => s + Math.min(1, w.lastHeartbeatMs / 600_000), 0) / ws.length;
  const score = Math.max(0, aliveRatio - crashes * 0.02 - heartbeatPenalty * 0.3);
  return {
    score: Math.min(1, score),
    detail: { workers: ws.length, alive_ratio: aliveRatio, crashes_24h: crashes },
  };
}

export function composeCommandCenterSnapshot(
  input: CommandCenterInput,
  now: () => Date = () => new Date(),
): CommandCenterSnapshot {
  const subsystems: Record<string, { score: number; detail: Record<string, unknown> }> = {};

  subsystems.queues = queueScore(input.queues);
  subsystems.workers = workerScore(input.workers);
  subsystems.db_latency = {
    score: score01(input.db.p95Ms, 80, 800) * (1 - input.db.saturationPct * 0.5),
    detail: { p95_ms: input.db.p95Ms, p99_ms: input.db.p99Ms, sat: input.db.saturationPct },
  };
  subsystems.ranking_freshness = {
    score: score01(input.ranking.lastRefreshAgeMs, 60_000, 30 * 60_000),
    detail: {
      last_refresh_ms: input.ranking.lastRefreshAgeMs,
      stale_categories: input.ranking.staleCategories.length,
    },
  };
  subsystems.personalization_freshness = {
    score: score01(input.personalization.recomputeLagMs, 5 * 60_000, 60 * 60_000),
    detail: {
      recompute_lag_ms: input.personalization.recomputeLagMs,
      stale_users: input.personalization.staleUserCount,
    },
  };
  subsystems.notification_health = {
    score: Math.max(0, input.notifications.deliverySuccess - 0.05 * input.notifications.failingProviders.length),
    detail: {
      success: input.notifications.deliverySuccess,
      backlog: input.notifications.fanoutBacklog,
      failing_providers: input.notifications.failingProviders,
    },
  };
  subsystems.delivery_health = {
    score: input.delivery.successRate,
    detail: { attempts: input.delivery.totalAttempts },
  };
  subsystems.cron_health = {
    score: score01(input.cron.failedJobs24h, 0, 20) * (1 - Math.min(1, input.cron.skippedJobs24h / 50)),
    detail: { failed: input.cron.failedJobs24h, skipped: input.cron.skippedJobs24h },
  };
  subsystems.feed_quality = {
    score: input.feedQuality.diversityScore * (1 - Math.max(0, input.feedQuality.topSourceShare - 0.3)),
    detail: input.feedQuality as unknown as Record<string, unknown>,
  };
  subsystems.autoscaler_pressure = {
    score:
      (1 - Math.min(1, input.autoscaler.saturationPct)) *
      (1 - Math.min(1, input.autoscaler.consecutiveOverloadCycles / 10)),
    detail: {
      saturation: input.autoscaler.saturationPct,
      overload_cycles: input.autoscaler.consecutiveOverloadCycles,
    },
  };
  subsystems.mobile_api_health = {
    score:
      score01(input.mobile.p95LatencyMs, 200, 2_000) *
      (1 - Math.min(1, input.mobile.errorRate * 5)) *
      (input.mobile.unsupportedAppVersions.length > 0 ? 0.85 : 1),
    detail: {
      p95_ms: input.mobile.p95LatencyMs,
      error_rate: input.mobile.errorRate,
      unsupported_versions: input.mobile.unsupportedAppVersions,
    },
  };
  subsystems.feature_flags = {
    score: input.featureFlags.length === 0 ? 1 : 1,
    detail: { count: input.featureFlags.length },
  };
  subsystems.traffic_guards = {
    score: input.trafficGuard.mode === 'normal' ? 1 : input.trafficGuard.mode === 'degraded' ? 0.6 : 0.2,
    detail: { mode: input.trafficGuard.mode, reason: input.trafficGuard.reason ?? null },
  };

  const signals: SubsystemSignal[] = Object.entries(subsystems).map(([k, v]) => ({
    key: k,
    score: v.score,
    detail: v.detail,
  }));

  const health = computeSystemHealthScore({
    signals,
    openSevereIncidents: input.openSevereIncidents,
    openWarningIncidents: input.openWarningIncidents,
    trafficGuardEngaged: input.trafficGuard.mode !== 'normal',
    rolloutPaused: input.rolloutPaused,
    backupsFresh: input.backupsFresh,
    productionFreeze: input.productionFreeze,
  });

  return {
    generatedAt: now().toISOString(),
    health,
    subsystems,
    trafficGuard: input.trafficGuard,
    productionFreeze: input.productionFreeze,
    rolloutPaused: input.rolloutPaused,
    openSevereIncidents: input.openSevereIncidents,
    openWarningIncidents: input.openWarningIncidents,
  };
}
