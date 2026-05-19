/**
 * Phase G — Social distribution monitor.
 *
 * Tracks outbound publish health and downstream engagement signals for
 * each social channel the article distributor publishes to. Pure compute.
 */

export type SocialChannel = 'twitter' | 'facebook' | 'linkedin' | 'reddit' | 'rss' | 'newsletter';

export interface SocialPublishAttempt {
  channel: SocialChannel;
  articleId: string;
  attemptedAt: string;
  ok: boolean;
  errorCode?: string;
}

export interface SocialEngagementSample {
  channel: SocialChannel;
  articleId: string;
  observedAt: string;
  impressions: number;
  shares: number;
  clicks: number;
}

export interface SocialChannelHealth {
  channel: SocialChannel;
  attempts: number;
  successRate: number;
  averageCtr: number;
  averageShareVelocity: number; // shares per impression
  status: 'healthy' | 'degraded' | 'failing';
  recentErrors: string[];
}

export interface AttributionRecord {
  source: string;
  /** Reported by the analytics ingest. */
  reportedHits: number;
  /** Hits the renderer claims it served. */
  servedHits: number;
}

export interface AttributionAnomaly {
  source: string;
  divergence: number;
  severity: 'info' | 'warn' | 'severe';
}

export interface SocialDistributionMonitorConfig {
  ctrAnomalyDelta?: number; // default ±0.5 (50%)
  now?: () => Date;
  maxAttempts?: number;
  maxEngagement?: number;
}

export interface SocialDistributionMonitor {
  recordAttempt(a: SocialPublishAttempt): void;
  recordEngagement(s: SocialEngagementSample): void;
  recordAttribution(record: AttributionRecord): void;
  channelHealth(): SocialChannelHealth[];
  attributionAnomalies(): AttributionAnomaly[];
  shareVelocity(channel: SocialChannel, windowMs?: number): number;
}

function aggregate(items: SocialEngagementSample[]): {
  impressions: number;
  shares: number;
  clicks: number;
} {
  let impressions = 0;
  let shares = 0;
  let clicks = 0;
  for (const s of items) {
    impressions += s.impressions;
    shares += s.shares;
    clicks += s.clicks;
  }
  return { impressions, shares, clicks };
}

export function createSocialDistributionMonitor(
  config: SocialDistributionMonitorConfig = {},
): SocialDistributionMonitor {
  const ctrAnomalyDelta = config.ctrAnomalyDelta ?? 0.5;
  const now = config.now ?? (() => new Date());
  const maxAttempts = Math.max(128, config.maxAttempts ?? 50_000);
  const maxEngagement = Math.max(128, config.maxEngagement ?? 50_000);

  const attempts: SocialPublishAttempt[] = [];
  const engagement: SocialEngagementSample[] = [];
  const attribution: AttributionRecord[] = [];

  function prune(): void {
    while (attempts.length > maxAttempts) attempts.shift();
    while (engagement.length > maxEngagement) engagement.shift();
  }

  return {
    recordAttempt(a) {
      attempts.push({ ...a });
      prune();
    },
    recordEngagement(s) {
      engagement.push({ ...s });
      prune();
    },
    recordAttribution(record) {
      attribution.push({ ...record });
      if (attribution.length > 10_000) attribution.shift();
    },

    channelHealth() {
      const byChannel = new Map<SocialChannel, { attempts: SocialPublishAttempt[]; eng: SocialEngagementSample[] }>();
      for (const a of attempts) {
        const b = byChannel.get(a.channel) ?? { attempts: [], eng: [] };
        b.attempts.push(a);
        byChannel.set(a.channel, b);
      }
      for (const e of engagement) {
        const b = byChannel.get(e.channel) ?? { attempts: [], eng: [] };
        b.eng.push(e);
        byChannel.set(e.channel, b);
      }
      const out: SocialChannelHealth[] = [];
      for (const [channel, bucket] of byChannel) {
        const ok = bucket.attempts.filter((a) => a.ok).length;
        const total = bucket.attempts.length;
        const successRate = total === 0 ? 1 : ok / total;
        const agg = aggregate(bucket.eng);
        const ctr = agg.impressions === 0 ? 0 : agg.clicks / agg.impressions;
        const sv = agg.impressions === 0 ? 0 : agg.shares / agg.impressions;
        let status: SocialChannelHealth['status'] = 'healthy';
        if (successRate < 0.7 || ctr === 0) status = 'failing';
        else if (successRate < 0.9 || ctr < 0.005) status = 'degraded';
        const recentErrors = bucket.attempts
          .filter((a) => !a.ok)
          .slice(-5)
          .map((a) => a.errorCode ?? 'unknown_error');
        out.push({
          channel,
          attempts: total,
          successRate,
          averageCtr: ctr,
          averageShareVelocity: sv,
          status,
          recentErrors,
        });
      }
      return out;
    },

    attributionAnomalies() {
      const out: AttributionAnomaly[] = [];
      for (const r of attribution) {
        if (r.servedHits === 0 && r.reportedHits === 0) continue;
        const denom = Math.max(r.servedHits, r.reportedHits);
        const divergence = (r.reportedHits - r.servedHits) / Math.max(1, denom);
        if (Math.abs(divergence) < 0.1) continue;
        let severity: AttributionAnomaly['severity'] = 'info';
        if (Math.abs(divergence) >= 0.5) severity = 'severe';
        else if (Math.abs(divergence) >= 0.25) severity = 'warn';
        out.push({ source: r.source, divergence, severity });
      }
      // Use ctrAnomalyDelta to also detect CTR shifts across channels.
      for (const h of this.channelHealth()) {
        if (h.averageShareVelocity > ctrAnomalyDelta) {
          out.push({ source: `channel:${h.channel}`, divergence: h.averageShareVelocity, severity: 'info' });
        }
      }
      return out;
    },

    shareVelocity(channel, windowMs = 60 * 60_000) {
      const cutoff = now().getTime() - windowMs;
      const slice = engagement.filter(
        (e) => e.channel === channel && new Date(e.observedAt).getTime() >= cutoff,
      );
      const agg = aggregate(slice);
      return agg.impressions === 0 ? 0 : agg.shares / agg.impressions;
    },
  };
}
