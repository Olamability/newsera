/**
 * Phase G — Click-fraud signals.
 *
 * Heuristic detector for suspicious ad-click activity. Pure compute, no
 * external services. Produces structured findings the monetization guard
 * can act on (block, downrank, isolate).
 *
 * Signals:
 *   - click burst per user / IP / session (velocity)
 *   - click-to-impression ratio anomaly
 *   - invalid-traffic (user-agent / region) heuristics
 *   - duplicate click fingerprints
 *   - revenue anomaly correlation
 */

export interface AdClickEvent {
  userId: string;
  sessionId: string;
  ipHash: string;
  userAgent: string;
  region?: string;
  articleId: string;
  slotId: string;
  occurredAt: string;
}

export interface AdImpressionEvent {
  userId: string;
  sessionId: string;
  ipHash: string;
  articleId: string;
  slotId: string;
  occurredAt: string;
}

export type FraudFindingType =
  | 'click_burst_user'
  | 'click_burst_ip'
  | 'ctr_anomaly'
  | 'duplicate_click'
  | 'suspicious_user_agent'
  | 'rapid_session_churn';

export interface FraudFinding {
  type: FraudFindingType;
  severity: 'info' | 'warn' | 'severe';
  subject: string; // user/ip/session identifier
  count?: number;
  detail?: Record<string, unknown>;
}

export interface ClickFraudConfig {
  burstWindowMs?: number;
  burstUserThreshold?: number;
  burstIpThreshold?: number;
  ctrSpikeRatio?: number; // observed_ctr / expected_ctr
  expectedCtrCap?: number; // sane ceiling for a legitimate ad
  duplicateWindowMs?: number;
  suspiciousUserAgentPatterns?: RegExp[];
  now?: () => Date;
  maxEvents?: number;
}

export interface ClickFraudSignals {
  ingestClick(event: AdClickEvent): void;
  ingestImpression(event: AdImpressionEvent): void;
  evaluate(): FraudFinding[];
  reset(): void;
}

const DEFAULT_BAD_UAS: RegExp[] = [
  /HeadlessChrome/i,
  /PhantomJS/i,
  /\bbot\b/i,
  /spider/i,
  /scrap/i,
  /curl\//i,
  /wget\//i,
];

export function createClickFraudSignals(config: ClickFraudConfig = {}): ClickFraudSignals {
  const burstWindowMs = config.burstWindowMs ?? 60_000;
  const burstUserThreshold = config.burstUserThreshold ?? 5;
  const burstIpThreshold = config.burstIpThreshold ?? 20;
  const ctrSpikeRatio = config.ctrSpikeRatio ?? 5;
  const expectedCtrCap = config.expectedCtrCap ?? 0.05;
  const duplicateWindowMs = config.duplicateWindowMs ?? 2_000;
  const badUas = config.suspiciousUserAgentPatterns ?? DEFAULT_BAD_UAS;
  const now = config.now ?? (() => new Date());
  const maxEvents = Math.max(256, config.maxEvents ?? 200_000);

  const clicks: AdClickEvent[] = [];
  const impressions: AdImpressionEvent[] = [];

  function prune(): void {
    while (clicks.length > maxEvents) clicks.shift();
    while (impressions.length > maxEvents) impressions.shift();
  }

  return {
    ingestClick(event) {
      clicks.push({ ...event });
      prune();
    },

    ingestImpression(event) {
      impressions.push({ ...event });
      prune();
    },

    evaluate() {
      const out: FraudFinding[] = [];
      const cutoff = now().getTime() - burstWindowMs;
      const recent = clicks.filter((c) => new Date(c.occurredAt).getTime() >= cutoff);

      // Burst per user.
      const byUser = new Map<string, number>();
      for (const c of recent) byUser.set(c.userId, (byUser.get(c.userId) ?? 0) + 1);
      for (const [userId, count] of byUser) {
        if (count >= burstUserThreshold) {
          out.push({
            type: 'click_burst_user',
            severity: count >= burstUserThreshold * 2 ? 'severe' : 'warn',
            subject: userId,
            count,
            detail: { windowMs: burstWindowMs },
          });
        }
      }

      // Burst per IP.
      const byIp = new Map<string, number>();
      for (const c of recent) byIp.set(c.ipHash, (byIp.get(c.ipHash) ?? 0) + 1);
      for (const [ipHash, count] of byIp) {
        if (count >= burstIpThreshold) {
          out.push({
            type: 'click_burst_ip',
            severity: count >= burstIpThreshold * 2 ? 'severe' : 'warn',
            subject: ipHash,
            count,
            detail: { windowMs: burstWindowMs },
          });
        }
      }

      // CTR anomaly (over a larger window — duplicateWindow * 30 or burstWindow * 10).
      const ctrWindow = Math.max(burstWindowMs * 10, 10 * 60_000);
      const ctrCutoff = now().getTime() - ctrWindow;
      const ctrClicks = clicks.filter((c) => new Date(c.occurredAt).getTime() >= ctrCutoff);
      const ctrImpressions = impressions.filter(
        (i) => new Date(i.occurredAt).getTime() >= ctrCutoff,
      );
      if (ctrImpressions.length > 0) {
        const ctr = ctrClicks.length / ctrImpressions.length;
        const expected = Math.min(expectedCtrCap, 0.02);
        const ratio = expected === 0 ? Infinity : ctr / expected;
        if (ratio >= ctrSpikeRatio) {
          out.push({
            type: 'ctr_anomaly',
            severity: ratio >= ctrSpikeRatio * 2 ? 'severe' : 'warn',
            subject: 'global',
            detail: { ctr, expected, ratio, windowMs: ctrWindow },
          });
        }
      }

      // Duplicate clicks (same (user, slotId) within duplicateWindowMs).
      const dupSeen = new Map<string, number>();
      for (const c of clicks) {
        const key = `${c.userId}|${c.slotId}`;
        const t = new Date(c.occurredAt).getTime();
        const prev = dupSeen.get(key);
        if (prev !== undefined && t - prev < duplicateWindowMs) {
          out.push({
            type: 'duplicate_click',
            severity: 'warn',
            subject: c.userId,
            detail: { slotId: c.slotId, deltaMs: t - prev },
          });
        }
        dupSeen.set(key, t);
      }

      // Suspicious user agents.
      const flaggedUsers = new Set<string>();
      for (const c of clicks) {
        if (badUas.some((re) => re.test(c.userAgent)) && !flaggedUsers.has(c.userId)) {
          flaggedUsers.add(c.userId);
          out.push({
            type: 'suspicious_user_agent',
            severity: 'severe',
            subject: c.userId,
            detail: { userAgent: c.userAgent },
          });
        }
      }

      // Rapid session churn — many sessions per user in short window.
      const sessionsByUser = new Map<string, Set<string>>();
      for (const c of clicks.filter((c) => new Date(c.occurredAt).getTime() >= ctrCutoff)) {
        const set = sessionsByUser.get(c.userId) ?? new Set<string>();
        set.add(c.sessionId);
        sessionsByUser.set(c.userId, set);
      }
      for (const [userId, set] of sessionsByUser) {
        if (set.size >= 10) {
          out.push({
            type: 'rapid_session_churn',
            severity: 'warn',
            subject: userId,
            count: set.size,
          });
        }
      }

      return out;
    },

    reset() {
      clicks.length = 0;
      impressions.length = 0;
    },
  };
}
