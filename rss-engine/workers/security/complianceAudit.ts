/**
 * Phase G — Compliance audit.
 *
 * Final-pass compliance checks that compose the data-retention and
 * access-boundary auditors with surface-level checks (PII logging, debug
 * leakage, excessive notification exposure, queue poisoning, replay
 * abuse, missing audit lineage, insecure env mismatches).
 *
 * Pure compute. Returns:
 *   - finalComplianceScore (0..1)
 *   - launchBlockers[]
 *   - criticalFindings[]
 */

import type { BoundaryFinding } from './accessBoundaryAudit';
import type { RetentionViolation } from './dataRetentionPolicy';

export type ComplianceFindingCode =
  | 'pii_logging'
  | 'debug_endpoint_exposed'
  | 'verbose_log_in_prod'
  | 'excessive_notification_exposure'
  | 'queue_poisoning_vector'
  | 'replay_abuse_opportunity'
  | 'missing_audit_lineage'
  | 'env_mismatch';

export interface ComplianceSurfaceInput {
  /** Sample log lines from production. */
  productionLogSamples: string[];
  /** Routes currently mounted in production. */
  productionRoutes: string[];
  /** True if NODE_ENV/SUPABASE_ENV indicate production. */
  isProduction: boolean;
  /** Notification topics + their target audience size. */
  notificationTopics: Array<{ topic: string; audienceSize: number; requiresOptIn: boolean }>;
  /** Job types accepted by the queue runner. */
  queueAcceptedJobTypes: string[];
  /** Job types declared in source code. */
  queueDeclaredJobTypes: string[];
  /** Map of mutation RPC name → has audit-log write? */
  mutationAuditCoverage: Record<string, boolean>;
  /** Env keys present at runtime; values are NOT included. */
  envKeys: string[];
  expectedEnvKeys: string[];
}

export interface ComplianceFinding {
  code: ComplianceFindingCode;
  severity: 'info' | 'warn' | 'severe';
  message: string;
  detail?: Record<string, unknown>;
}

export interface ComplianceReport {
  finalComplianceScore: number;
  launchBlockers: ComplianceFinding[];
  criticalFindings: ComplianceFinding[];
  allFindings: ComplianceFinding[];
}

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { name: 'phone', re: /\b\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3}[ -]?\d{3,4}\b/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,16}\b/ },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
];

const DEBUG_ROUTE_PATTERNS = [/\/__debug/, /\/internal\//, /\/dev[-_]/, /\/whoami$/];

export function auditCompliance(
  surface: ComplianceSurfaceInput,
  boundaryFindings: BoundaryFinding[] = [],
  retentionViolations: RetentionViolation[] = [],
): ComplianceReport {
  const findings: ComplianceFinding[] = [];

  // PII / verbose logging in prod.
  if (surface.isProduction) {
    for (const sample of surface.productionLogSamples) {
      for (const p of PII_PATTERNS) {
        if (p.re.test(sample)) {
          findings.push({
            code: 'pii_logging',
            severity: 'severe',
            message: `PII pattern ${p.name} detected in production logs`,
            detail: { sample: sample.slice(0, 80) },
          });
        }
      }
      if (/DEBUG[: ]/.test(sample) || /TRACE[: ]/.test(sample)) {
        findings.push({
          code: 'verbose_log_in_prod',
          severity: 'warn',
          message: 'verbose log level emitted in production',
          detail: { sample: sample.slice(0, 80) },
        });
      }
    }

    for (const route of surface.productionRoutes) {
      if (DEBUG_ROUTE_PATTERNS.some((re) => re.test(route))) {
        findings.push({
          code: 'debug_endpoint_exposed',
          severity: 'severe',
          message: `debug route exposed in production: ${route}`,
        });
      }
    }
  }

  // Excessive notification exposure.
  for (const topic of surface.notificationTopics) {
    if (!topic.requiresOptIn && topic.audienceSize > 100_000) {
      findings.push({
        code: 'excessive_notification_exposure',
        severity: 'warn',
        message: `notification topic '${topic.topic}' fanned out to ${topic.audienceSize} users without opt-in`,
      });
    }
  }

  // Queue poisoning vectors — accepted jobs that aren't declared.
  const declared = new Set(surface.queueDeclaredJobTypes);
  for (const t of surface.queueAcceptedJobTypes) {
    if (!declared.has(t)) {
      findings.push({
        code: 'queue_poisoning_vector',
        severity: 'severe',
        message: `queue accepts undeclared job type: ${t}`,
      });
    }
  }

  // Replay abuse — same set: declared but missing handlers would let
  // attackers craft messages; we surface as warn.
  for (const t of surface.queueDeclaredJobTypes) {
    if (!surface.queueAcceptedJobTypes.includes(t)) {
      findings.push({
        code: 'replay_abuse_opportunity',
        severity: 'info',
        message: `declared job '${t}' has no live acceptor — possible replay sink`,
      });
    }
  }

  // Missing audit lineage.
  for (const [rpc, covered] of Object.entries(surface.mutationAuditCoverage)) {
    if (!covered) {
      findings.push({
        code: 'missing_audit_lineage',
        severity: 'severe',
        message: `mutation RPC ${rpc} does not write to admin_audit_log`,
      });
    }
  }

  // Env mismatch.
  const present = new Set(surface.envKeys);
  const missing = surface.expectedEnvKeys.filter((k) => !present.has(k));
  if (missing.length > 0) {
    findings.push({
      code: 'env_mismatch',
      severity: 'warn',
      message: `${missing.length} expected env key(s) missing`,
      detail: { missing },
    });
  }

  // Fold in boundary findings.
  for (const b of boundaryFindings) {
    findings.push({
      code: b.type === 'unsafe_admin_exposure' ? 'debug_endpoint_exposed' : 'missing_audit_lineage',
      severity: b.severity,
      message: `[boundary:${b.type}] ${b.message}`,
      detail: b.detail,
    });
  }

  // Fold in retention violations.
  for (const r of retentionViolations) {
    findings.push({
      code: 'pii_logging',
      severity: r.severity,
      message: `[retention] table ${r.table} retains rows ${Math.floor(
        r.oldestRowAgeMs / 86_400_000,
      )}d old (max ${Math.floor(r.rule.maxAgeMs / 86_400_000)}d)`,
      detail: { rowsExceedingAge: r.rowsExceedingAge },
    });
  }

  const launchBlockers = findings.filter((f) => f.severity === 'severe');
  const criticalFindings = launchBlockers;
  const score = Math.max(
    0,
    1 -
      launchBlockers.length * 0.15 -
      findings.filter((f) => f.severity === 'warn').length * 0.04,
  );

  return {
    finalComplianceScore: score,
    launchBlockers,
    criticalFindings,
    allFindings: findings,
  };
}
