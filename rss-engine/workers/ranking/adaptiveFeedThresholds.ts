/**
 * Phase G — Adaptive feed thresholds.
 *
 * Closes the Phase F debt: `feedQualityAuditor` operates on static
 * thresholds (e.g., "single-source share must be < 0.25"). Real traffic
 * does not respect static thresholds, so this module computes percentile
 * baselines from rolling samples and exposes adaptive thresholds the
 * auditor can consult.
 *
 * Inputs are pushed by the operator dashboard / nightly job. The module
 * never reaches for the network and never overrides static thresholds —
 * it RECOMMENDS adaptive ones with an explicit confidence score so the
 * caller can blend them with the static defaults.
 *
 * Capabilities:
 *   - percentile-based dynamic thresholds (p50/p95)
 *   - adaptive engagement baselines (CTR / dwell-time)
 *   - source saturation learning (top-source dominance heuristic)
 *   - per-category diversity calibration
 */

export interface FeedSampleObservation {
  category: string;
  topSourceShare: number;
  uniqueSources: number;
  engagementCtr: number; // 0..1
  dwellSeconds: number;
  recordedAt: Date;
}

export interface AdaptiveThresholdRecommendation {
  metric: string;
  baseline: number;
  recommendedMin?: number;
  recommendedMax?: number;
  staticDefault: number;
  confidence: number; // 0..1
  sampleSize: number;
}

export interface CategoryCalibration {
  category: string;
  recommendations: AdaptiveThresholdRecommendation[];
  saturationRisk: 'none' | 'low' | 'medium' | 'high';
}

export interface AdaptiveFeedThresholdsConfig {
  maxSamplesPerCategory?: number;
  minSamplesForRecommendation?: number;
  staticDefaults?: {
    topSourceShareMax?: number; // default 0.25
    minUniqueSources?: number; // default 8
    minEngagementCtr?: number; // default 0.04
    minDwellSeconds?: number; // default 18
  };
  now?: () => Date;
}

export interface AdaptiveFeedThresholds {
  record(observation: FeedSampleObservation): void;
  recommend(category: string): CategoryCalibration | null;
  recommendAll(): CategoryCalibration[];
  baseline(category: string, metric: string): number | null;
  reset(category?: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function confidenceFromSamples(n: number, min: number): number {
  if (n < min) return 0;
  // saturates at n = 5*min
  return Math.min(1, n / (min * 5));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdaptiveFeedThresholds(
  config: AdaptiveFeedThresholdsConfig = {},
): AdaptiveFeedThresholds {
  const maxSamples = Math.max(20, config.maxSamplesPerCategory ?? 500);
  const minSamples = Math.max(5, config.minSamplesForRecommendation ?? 30);
  const defaults = {
    topSourceShareMax: 0.25,
    minUniqueSources: 8,
    minEngagementCtr: 0.04,
    minDwellSeconds: 18,
    ...(config.staticDefaults ?? {}),
  };

  const samples = new Map<string, FeedSampleObservation[]>();

  function pushSample(category: string, sample: FeedSampleObservation): void {
    const bucket = samples.get(category) ?? [];
    bucket.push(sample);
    if (bucket.length > maxSamples) bucket.shift();
    samples.set(category, bucket);
  }

  function computeRecommendations(category: string): CategoryCalibration | null {
    const bucket = samples.get(category);
    if (!bucket || bucket.length === 0) return null;
    const n = bucket.length;
    const confidence = confidenceFromSamples(n, minSamples);

    const topShares = bucket.map((s) => s.topSourceShare);
    const uniqueSources = bucket.map((s) => s.uniqueSources);
    const ctr = bucket.map((s) => s.engagementCtr);
    const dwell = bucket.map((s) => s.dwellSeconds);

    const recommendations: AdaptiveThresholdRecommendation[] = [
      {
        metric: 'top_source_share',
        baseline: percentile(topShares, 0.5),
        // Adaptive max = max(default, p95) so it tolerates real distribution.
        recommendedMax: Math.max(defaults.topSourceShareMax, percentile(topShares, 0.95)),
        staticDefault: defaults.topSourceShareMax,
        confidence,
        sampleSize: n,
      },
      {
        metric: 'unique_sources',
        baseline: percentile(uniqueSources, 0.5),
        // Adaptive min = min(default, p5) so a healthy steady-state with
        // many sources doesn't make the default look unrealistically low.
        recommendedMin: Math.min(defaults.minUniqueSources, percentile(uniqueSources, 0.05)),
        staticDefault: defaults.minUniqueSources,
        confidence,
        sampleSize: n,
      },
      {
        metric: 'engagement_ctr',
        baseline: mean(ctr),
        recommendedMin: Math.max(defaults.minEngagementCtr * 0.7, percentile(ctr, 0.1)),
        staticDefault: defaults.minEngagementCtr,
        confidence,
        sampleSize: n,
      },
      {
        metric: 'dwell_seconds',
        baseline: mean(dwell),
        recommendedMin: Math.max(defaults.minDwellSeconds * 0.7, percentile(dwell, 0.1)),
        staticDefault: defaults.minDwellSeconds,
        confidence,
        sampleSize: n,
      },
    ];

    const dominantShare = percentile(topShares, 0.95);
    let saturationRisk: CategoryCalibration['saturationRisk'] = 'none';
    if (dominantShare >= 0.6) saturationRisk = 'high';
    else if (dominantShare >= 0.45) saturationRisk = 'medium';
    else if (dominantShare >= 0.3) saturationRisk = 'low';

    return { category, recommendations, saturationRisk };
  }

  return {
    record(observation) {
      pushSample(observation.category, { ...observation });
    },

    recommend(category) {
      return computeRecommendations(category);
    },

    recommendAll() {
      const out: CategoryCalibration[] = [];
      for (const cat of samples.keys()) {
        const rec = computeRecommendations(cat);
        if (rec) out.push(rec);
      }
      return out;
    },

    baseline(category, metric) {
      const rec = computeRecommendations(category);
      if (!rec) return null;
      const item = rec.recommendations.find((r) => r.metric === metric);
      return item ? item.baseline : null;
    },

    reset(category) {
      if (category) samples.delete(category);
      else samples.clear();
    },
  };
}
