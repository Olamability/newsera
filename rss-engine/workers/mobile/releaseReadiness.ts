/**
 * Phase G — Mobile release readiness.
 *
 * Aggregates the outputs of `apiCompatibilityGuard` and `crashCorrelation`
 * together with production mobile-config validation into a single
 * release-readiness verdict.
 *
 * Pure compute.
 */

import type { CompatibilityReport } from './apiCompatibilityGuard';
import type { CrashSpike, RolloutToCrashMapping } from './crashCorrelation';

export interface MobileConfigBundle {
  /** App version this bundle targets. */
  version: string;
  /** Mandatory keys required at runtime. */
  requiredKeys: string[];
  /** Values present in the bundle. */
  values: Record<string, unknown>;
  /** Feature flags enabled in the bundle. */
  enabledFlags: string[];
  /** Build channel — production / beta. */
  channel: 'production' | 'beta';
}

export interface AppStoreReadiness {
  hasPrivacyManifest: boolean;
  hasReleaseNotes: boolean;
  hasScreenshots: boolean;
  passesTosCheck: boolean;
  binarySigned: boolean;
}

export interface ReleaseReadinessInput {
  compatibility: CompatibilityReport;
  crashSpikes: CrashSpike[];
  rolloutMappings: RolloutToCrashMapping[];
  config: MobileConfigBundle;
  appStore: AppStoreReadiness;
}

export interface ReleaseReadinessReport {
  ok: boolean;
  blockerScore: number; // 0..1; 1.0 = no blockers, 0 = blocked
  blockers: string[];
  warnings: string[];
  recommendation: 'ship' | 'hold' | 'rollback';
}

export function evaluateMobileRelease(input: ReleaseReadinessInput): ReleaseReadinessReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.compatibility.ok) {
    const severe = input.compatibility.issues.filter((i) => i.severity === 'severe').length;
    if (severe > 0) blockers.push(`${severe} severe API compatibility issues`);
  }
  if (input.compatibility.summary.unsupportedActive > 0) {
    warnings.push(
      `${input.compatibility.summary.unsupportedActive} unsupported app version(s) still in production`,
    );
  }
  if (input.compatibility.summary.deprecatedEndpointsInUse > 0) {
    warnings.push(
      `${input.compatibility.summary.deprecatedEndpointsInUse} deprecated endpoint(s) still required by supported apps`,
    );
  }

  const severeCrashes = input.crashSpikes.filter((c) => c.severity === 'severe');
  if (severeCrashes.length > 0) {
    blockers.push(`${severeCrashes.length} severe crash spike(s) detected`);
  }
  const rollbackRecommended = input.rolloutMappings.some((m) => m.recommendsRollback);
  if (rollbackRecommended) {
    blockers.push('crash correlation recommends rollback of one or more flags');
  }

  // Mobile config validation.
  const missingKeys = input.config.requiredKeys.filter((k) => !(k in input.config.values));
  if (missingKeys.length > 0) {
    blockers.push(`mobile config missing keys: ${missingKeys.join(', ')}`);
  }
  if (input.config.channel === 'production' && input.config.enabledFlags.length === 0) {
    warnings.push('production config has no flags enabled — verify intent');
  }

  // App-store readiness.
  if (!input.appStore.hasPrivacyManifest) blockers.push('privacy manifest missing');
  if (!input.appStore.binarySigned) blockers.push('binary is not signed');
  if (!input.appStore.passesTosCheck) blockers.push('ToS check failed');
  if (!input.appStore.hasReleaseNotes) warnings.push('release notes missing');
  if (!input.appStore.hasScreenshots) warnings.push('screenshots missing');

  const blockerScore = Math.max(0, 1 - blockers.length * 0.2 - warnings.length * 0.05);
  const ok = blockers.length === 0;
  let recommendation: ReleaseReadinessReport['recommendation'] = ok ? 'ship' : 'hold';
  if (rollbackRecommended || severeCrashes.length > 0) recommendation = 'rollback';
  return { ok, blockerScore, blockers, warnings, recommendation };
}
