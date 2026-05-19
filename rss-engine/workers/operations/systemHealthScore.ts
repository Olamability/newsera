/**
 * Phase G — Composite system health score.
 *
 * Single 0..1 number summarising the entire production stack, with a
 * degradation classification (`healthy` / `degraded` / `critical`), a
 * risk-prediction tag, a launch-readiness score, and operator action
 * recommendations.
 *
 * Pure compute. Weights are explicit so the operator dashboard can show
 * the contribution of each subsystem.
 */

export interface SubsystemSignal {
  /** Stable key — e.g., 'queues', 'workers', 'ranking_freshness'. */
  key: string;
  /** Subsystem self-reported health in 0..1. */
  score: number;
  /** Optional weight override; defaults to 1.0. */
  weight?: number;
  /** Free-form context — degraded_reason, last_incident, etc. */
  detail?: Record<string, unknown>;
}

export type HealthClass = 'healthy' | 'degraded' | 'critical';
export type RiskPrediction = 'stable' | 'rising' | 'unstable';

export interface SystemHealthScoreInput {
  signals: SubsystemSignal[];
  /** Number of open SEVERE+ incidents. */
  openSevereIncidents: number;
  /** Open warning-level incidents. */
  openWarningIncidents: number;
  /** True if traffic guard is in degraded/throttled mode. */
  trafficGuardEngaged: boolean;
  /** True if rollout is paused for any reason. */
  rolloutPaused: boolean;
  /** True if backup freshness is acceptable. */
  backupsFresh: boolean;
  /** True if production freeze is currently active. */
  productionFreeze: boolean;
}

export interface SystemHealthScore {
  score: number;
  classification: HealthClass;
  risk: RiskPrediction;
  launchReadinessScore: number;
  weights: Record<string, number>;
  contributions: Array<{ key: string; weighted: number; raw: number }>;
  recommendations: string[];
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  queues: 1.2,
  workers: 1.2,
  db_latency: 1.0,
  ranking_freshness: 0.9,
  personalization_freshness: 0.9,
  notification_health: 1.0,
  delivery_health: 0.8,
  cron_health: 0.7,
  feed_quality: 0.8,
  autoscaler_pressure: 0.6,
  mobile_api_health: 0.7,
  feature_flags: 0.5,
  traffic_guards: 0.5,
};

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function computeSystemHealthScore(input: SystemHealthScoreInput): SystemHealthScore {
  const weights: Record<string, number> = {};
  const contributions: SystemHealthScore['contributions'] = [];
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const s of input.signals) {
    const w = s.weight ?? DEFAULT_WEIGHTS[s.key] ?? 0.7;
    weights[s.key] = w;
    const raw = clamp01(s.score);
    const weighted = raw * w;
    weightedTotal += weighted;
    totalWeight += w;
    contributions.push({ key: s.key, weighted, raw });
  }

  const baseScore = totalWeight === 0 ? 0 : weightedTotal / totalWeight;

  // Penalties.
  let penalty = 0;
  penalty += input.openSevereIncidents * 0.08;
  penalty += input.openWarningIncidents * 0.02;
  if (input.trafficGuardEngaged) penalty += 0.1;
  if (input.rolloutPaused) penalty += 0.05;
  if (!input.backupsFresh) penalty += 0.07;

  const score = clamp01(baseScore - penalty);

  let classification: HealthClass = 'healthy';
  if (score < 0.6) classification = 'critical';
  else if (score < 0.85) classification = 'degraded';

  // Risk prediction: count "warning"-tier signals (raw < 0.85).
  const warningSignals = contributions.filter((c) => c.raw < 0.85).length;
  let risk: RiskPrediction = 'stable';
  if (input.openSevereIncidents > 0 || warningSignals >= contributions.length / 2) risk = 'unstable';
  else if (warningSignals > 0 || input.openWarningIncidents > 0) risk = 'rising';

  // Launch readiness = health × incident-freeness × rollout-clean
  let launchReadinessScore = score;
  if (input.openSevereIncidents > 0) launchReadinessScore *= 0.5;
  if (input.rolloutPaused) launchReadinessScore *= 0.85;
  if (!input.backupsFresh) launchReadinessScore *= 0.85;
  if (input.productionFreeze) launchReadinessScore *= 0.7;
  launchReadinessScore = clamp01(launchReadinessScore);

  const recommendations: string[] = [];
  if (input.openSevereIncidents > 0) recommendations.push('triage open SEVERE+ incidents before launch');
  if (input.trafficGuardEngaged) recommendations.push('investigate traffic guard engagement');
  if (!input.backupsFresh) recommendations.push('verify backup freshness; re-run backupCoordinator');
  if (input.rolloutPaused) recommendations.push('resolve cause of rollout pause');
  for (const c of contributions) {
    if (c.raw < 0.6) recommendations.push(`degraded: ${c.key} (score=${c.raw.toFixed(2)})`);
  }
  if (recommendations.length === 0) recommendations.push('system healthy — proceed with planned rollouts');

  return {
    score,
    classification,
    risk,
    launchReadinessScore,
    weights,
    contributions,
    recommendations,
  };
}

export const SYSTEM_HEALTH_DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
