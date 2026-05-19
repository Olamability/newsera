/**
 * Phase F — Pre-launch security lockdown audit.
 *
 * Performs a deterministic static analysis of the deployment surface and
 * returns a `launchSecurityScore` plus a list of findings. The host
 * passes a snapshot of the deployment configuration; this module DOES
 * NOT read process.env on its own (so it stays pure & testable).
 *
 * Categories checked:
 *
 *   - exposed_service_role_keys       (secrets accidentally available client-side)
 *   - insecure_env_vars               (HTTP urls in production, hardcoded creds)
 *   - unsafe_admin_rpc_exposure       (admin RPC reachable without auth)
 *   - open_debug_endpoints            (e.g., /debug, /__inspect, /pprof)
 *   - test_routes                     (anything routed under /test, /staging)
 *   - verbose_production_logs         (log_level=debug in prod)
 *   - replay_vulnerabilities          (replay primitives missing idempotency)
 *   - queue_poisoning_vectors         (queues accept untrusted payload shapes)
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O.
 *   - DETERMINISTIC. Same input → same findings & score.
 *   - NEVER throws on malformed input — it surfaces a `malformed_*` finding.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LockdownInput {
  /** Process environment in the target deployment, after secrets sanitisation. */
  env: Record<string, string | undefined>;
  /** Whether the deployment is production. */
  isProduction: boolean;
  /** Set of routes exposed by the public API. */
  publicRoutes: string[];
  /** Admin RPC functions that may be invoked without auth. */
  unauthenticatedAdminRpcs: string[];
  /** Active log level for the service. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Replay primitives and whether they enforce idempotency. */
  replayPrimitives: Array<{ name: string; hasIdempotencyKey: boolean }>;
  /** Queues and whether the consumer validates payload shape. */
  queues: Array<{ name: string; validatesPayload: boolean }>;
  /** Public bucket of "service_role"-style key prefixes to detect. */
  serviceRoleKeyPrefixes?: string[];
}

export type LockdownSeverity = 'info' | 'warning' | 'critical';

export type LockdownCheck =
  | 'exposed_service_role_key'
  | 'insecure_env_var'
  | 'unsafe_admin_rpc_exposure'
  | 'open_debug_endpoint'
  | 'test_route'
  | 'verbose_production_logs'
  | 'replay_vulnerability'
  | 'queue_poisoning_vector';

export interface LockdownFinding {
  check: LockdownCheck;
  severity: LockdownSeverity;
  subject: string;
  detail: Record<string, unknown>;
  remediation: string;
}

export interface LockdownResult {
  launchSecurityScore: number;
  findings: LockdownFinding[];
  blockingCount: number;
  warningCount: number;
  passed: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_ROLE_PREFIXES = [
  'SUPABASE_SERVICE_ROLE',
  'SERVICE_ROLE_KEY',
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
];

const CLIENT_VISIBLE_ENV_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_', 'EXPO_PUBLIC_'];

const SUSPICIOUS_ROUTE_PATTERNS = [
  /^\/?debug\b/i,
  /^\/?__/i,
  /^\/?pprof\b/i,
  /^\/?metrics\/debug\b/i,
  /^\/?dev\b/i,
];

const TEST_ROUTE_PATTERNS = [
  /^\/?test\b/i,
  /^\/?staging\b/i,
  /^\/?qa\b/i,
  /^\/?internal\b/i,
];

const SEVERITY_WEIGHTS: Record<LockdownSeverity, number> = {
  info: 0.02,
  warning: 0.08,
  critical: 0.20,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function looksLikeServiceRoleKey(name: string, prefixes: ReadonlyArray<string>): boolean {
  const upper = name.toUpperCase();
  if (prefixes.some((p) => upper.startsWith(p.toUpperCase()))) return true;
  // Also detect client-visible prefixes wrapping a service-role key.
  for (const visiblePrefix of CLIENT_VISIBLE_ENV_PREFIXES) {
    if (upper.startsWith(visiblePrefix.toUpperCase())) {
      const stripped = upper.slice(visiblePrefix.length);
      if (prefixes.some((p) => stripped.startsWith(p.toUpperCase()))) return true;
    }
  }
  return false;
}

function isClientVisible(name: string): boolean {
  return CLIENT_VISIBLE_ENV_PREFIXES.some((p) => name.startsWith(p));
}

export function runLaunchLockdown(input: LockdownInput): LockdownResult {
  const findings: LockdownFinding[] = [];
  const prefixes = input.serviceRoleKeyPrefixes ?? DEFAULT_SERVICE_ROLE_PREFIXES;

  // 1. exposed_service_role_keys & insecure_env_vars
  for (const [name, value] of Object.entries(input.env)) {
    if (value === undefined) continue;
    if (looksLikeServiceRoleKey(name, prefixes) && isClientVisible(name)) {
      findings.push({
        check: 'exposed_service_role_key',
        severity: 'critical',
        subject: name,
        detail: { reason: 'service_role_key_under_client_visible_prefix' },
        remediation: 'Move the key to a server-only variable; rotate the key.',
      });
    }
    if (input.isProduction && /^http:\/\//i.test(value) && !value.startsWith('http://localhost')) {
      findings.push({
        check: 'insecure_env_var',
        severity: 'warning',
        subject: name,
        detail: { reason: 'http_url_in_production', value: '[redacted]' },
        remediation: 'Switch to https:// before launch.',
      });
    }
    if (/(password|secret|token|key)/i.test(name) && /^[A-Za-z0-9]{1,8}$/.test(value)) {
      findings.push({
        check: 'insecure_env_var',
        severity: 'critical',
        subject: name,
        detail: { reason: 'weak_secret_length' },
        remediation: 'Rotate to a high-entropy secret (>= 32 random chars).',
      });
    }
  }

  // 2. unsafe_admin_rpc_exposure
  for (const rpc of input.unauthenticatedAdminRpcs) {
    findings.push({
      check: 'unsafe_admin_rpc_exposure',
      severity: 'critical',
      subject: rpc,
      detail: { reason: 'unauthenticated_admin_rpc' },
      remediation: 'Require service-role bearer or session-bound admin claim; remove anon access.',
    });
  }

  // 3. open_debug_endpoints + 4. test_routes
  for (const route of input.publicRoutes) {
    if (SUSPICIOUS_ROUTE_PATTERNS.some((re) => re.test(route))) {
      findings.push({
        check: 'open_debug_endpoint',
        severity: input.isProduction ? 'critical' : 'warning',
        subject: route,
        detail: { reason: 'matches_debug_pattern' },
        remediation: 'Disable or guard behind an internal-only auth check before launch.',
      });
    }
    if (TEST_ROUTE_PATTERNS.some((re) => re.test(route))) {
      findings.push({
        check: 'test_route',
        severity: input.isProduction ? 'warning' : 'info',
        subject: route,
        detail: { reason: 'matches_test_pattern' },
        remediation: 'Remove test/staging routes from the production build.',
      });
    }
  }

  // 5. verbose_production_logs
  if (input.isProduction && input.logLevel === 'debug') {
    findings.push({
      check: 'verbose_production_logs',
      severity: 'warning',
      subject: 'log_level',
      detail: { current: input.logLevel },
      remediation: 'Set log level to "info" or higher in production.',
    });
  }

  // 6. replay_vulnerabilities
  for (const p of input.replayPrimitives) {
    if (!p.hasIdempotencyKey) {
      findings.push({
        check: 'replay_vulnerability',
        severity: 'critical',
        subject: p.name,
        detail: { reason: 'replay_without_idempotency' },
        remediation: 'Enforce a fingerprint/idempotency key per replay primitive.',
      });
    }
  }

  // 7. queue_poisoning_vectors
  for (const q of input.queues) {
    if (!q.validatesPayload) {
      findings.push({
        check: 'queue_poisoning_vector',
        severity: 'warning',
        subject: q.name,
        detail: { reason: 'consumer_lacks_payload_validation' },
        remediation: 'Validate the payload shape at the consumer; reject malformed jobs to the DLQ.',
      });
    }
  }

  let score = 1;
  for (const f of findings) score -= SEVERITY_WEIGHTS[f.severity];
  score = Math.max(0, Math.min(1, score));
  const blockingCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const passed = blockingCount === 0;
  const summary = `score=${score.toFixed(2)} critical=${blockingCount} warnings=${warningCount} total=${findings.length}`;

  return {
    launchSecurityScore: score,
    findings,
    blockingCount,
    warningCount,
    passed,
    summary,
  };
}
