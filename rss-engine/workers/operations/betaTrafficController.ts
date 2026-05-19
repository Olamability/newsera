/**
 * Phase F — Beta traffic controller.
 *
 * Decides whether a given identity may use the live platform during the
 * beta launch. Combines five independent gates — each one short-circuits
 * if it returns false. Operators tune the policy via `configure()`.
 *
 * Gates (evaluated in order):
 *
 *   1. mode               — `closed` denies everyone, `internal_only` denies
 *                           non-staff, `beta` consults cohort/invite,
 *                           `open` allows percentage gating only.
 *   2. staff_allowlist    — staff are always admitted (even in `closed`
 *                           if `allowStaffInClosed` is true).
 *   3. invite_code        — when present + valid, admits the user.
 *   4. cohort             — when the user's cohort is in `enabledCohorts`,
 *                           admits the user.
 *   5. geography          — when staged_geographies is configured, the
 *                           user's region must be enabled.
 *   6. traffic_percentage — deterministic hash-based bucketing so each
 *                           user sees a stable verdict across calls.
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O.
 *   - DETERMINISTIC. Identity → verdict is stable for a given policy.
 *   - REVERSIBLE. Calling `configure({mode:'closed'})` instantly halts
 *     all traffic for the next decision (no caching beyond the policy
 *     object).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BetaMode = 'closed' | 'internal_only' | 'beta' | 'open';

export interface BetaIdentity {
  userId: string;
  /** True if the user is a staff member. */
  isStaff?: boolean;
  /** Cohort tag — e.g., "early-access", "press". */
  cohort?: string;
  /** Geography hint — ISO country code, region, etc. */
  region?: string;
  /** Optional invite code the user is presenting. */
  inviteCode?: string;
}

export interface BetaPolicy {
  mode: BetaMode;
  /** Cohorts admitted when mode === 'beta'. */
  enabledCohorts: string[];
  /** Valid invite codes (hashed or plain — caller's choice). */
  inviteCodes: string[];
  /** Allowed regions. Empty array means "no geography filter". */
  enabledRegions: string[];
  /** Allowed traffic fraction in [0..1]. */
  trafficPercentage: number;
  /** Whether staff are admitted even in `closed` mode. */
  allowStaffInClosed?: boolean;
}

export const DEFAULT_BETA_POLICY: BetaPolicy = {
  mode: 'internal_only',
  enabledCohorts: [],
  inviteCodes: [],
  enabledRegions: [],
  trafficPercentage: 1.0,
  allowStaffInClosed: true,
};

export interface BetaDecision {
  allowed: boolean;
  gate: 'mode' | 'staff' | 'invite' | 'cohort' | 'geography' | 'traffic_percentage' | 'open';
  reason: string;
}

export interface BetaTrafficController {
  configure(policy: Partial<BetaPolicy>): BetaPolicy;
  policy(): BetaPolicy;
  decide(identity: BetaIdentity): BetaDecision;
  /** Map of admitted cohort → most recent decision (for the dashboard). */
  cohortSummary(): Record<string, { allowed: number; denied: number }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function bucketForUser(userId: string): number {
  // Same FNV-1a as the recovery manager so behaviour stays consistent.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    h ^= userId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h % 10_000) / 10_000;
}

export function createBetaTrafficController(
  initial: Partial<BetaPolicy> = {},
): BetaTrafficController {
  let policy: BetaPolicy = { ...DEFAULT_BETA_POLICY, ...initial };
  const cohortStats = new Map<string, { allowed: number; denied: number }>();

  function incStats(cohort: string, allowed: boolean): void {
    const cur = cohortStats.get(cohort) ?? { allowed: 0, denied: 0 };
    if (allowed) cur.allowed += 1;
    else cur.denied += 1;
    cohortStats.set(cohort, cur);
  }

  function configure(next: Partial<BetaPolicy>): BetaPolicy {
    policy = { ...policy, ...next };
    return { ...policy };
  }

  function decide(identity: BetaIdentity): BetaDecision {
    const cohortKey = identity.cohort ?? '__no_cohort__';

    // 1. mode + 2. staff
    if (policy.mode === 'closed') {
      const allow = !!(identity.isStaff && policy.allowStaffInClosed);
      const d: BetaDecision = allow
        ? { allowed: true, gate: 'staff', reason: 'staff_allowed_in_closed' }
        : { allowed: false, gate: 'mode', reason: 'platform_closed' };
      incStats(cohortKey, d.allowed);
      return d;
    }
    if (policy.mode === 'internal_only') {
      const allow = !!identity.isStaff;
      const d: BetaDecision = allow
        ? { allowed: true, gate: 'staff', reason: 'staff_only_mode' }
        : { allowed: false, gate: 'mode', reason: 'internal_only_non_staff' };
      incStats(cohortKey, d.allowed);
      return d;
    }
    if (identity.isStaff) {
      incStats(cohortKey, true);
      return { allowed: true, gate: 'staff', reason: 'staff_pass' };
    }

    // 3. invite_code (valid invite is a fast-pass)
    if (
      identity.inviteCode &&
      policy.inviteCodes.length > 0 &&
      policy.inviteCodes.includes(identity.inviteCode)
    ) {
      incStats(cohortKey, true);
      return { allowed: true, gate: 'invite', reason: 'valid_invite_code' };
    }

    // 4. cohort (beta mode only)
    if (policy.mode === 'beta') {
      if (identity.cohort && policy.enabledCohorts.includes(identity.cohort)) {
        // Cohort matches — still apply geography & traffic %.
      } else {
        incStats(cohortKey, false);
        return { allowed: false, gate: 'cohort', reason: 'cohort_not_enabled' };
      }
    }

    // 5. geography
    if (policy.enabledRegions.length > 0) {
      if (!identity.region || !policy.enabledRegions.includes(identity.region)) {
        incStats(cohortKey, false);
        return { allowed: false, gate: 'geography', reason: 'region_not_enabled' };
      }
    }

    // 6. traffic_percentage
    if (policy.trafficPercentage < 1) {
      const bucket = bucketForUser(identity.userId);
      if (bucket >= policy.trafficPercentage) {
        incStats(cohortKey, false);
        return {
          allowed: false,
          gate: 'traffic_percentage',
          reason: `bucket_${bucket.toFixed(4)}_above_${policy.trafficPercentage.toFixed(4)}`,
        };
      }
    }

    incStats(cohortKey, true);
    return { allowed: true, gate: 'open', reason: 'all_gates_passed' };
  }

  function cohortSummary(): Record<string, { allowed: number; denied: number }> {
    const out: Record<string, { allowed: number; denied: number }> = {};
    for (const [k, v] of cohortStats) out[k] = { ...v };
    return out;
  }

  return {
    configure,
    policy: () => ({ ...policy }),
    decide,
    cohortSummary,
  };
}
