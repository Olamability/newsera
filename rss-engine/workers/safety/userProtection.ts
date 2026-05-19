/**
 * Phase F — Real-user safety controls.
 *
 * Protects live users from the failure modes the spec calls out:
 *
 *   - notification spam               → per-user daily ceiling
 *   - personalization runaway loops   → recompute cooldown per user
 *   - repetitive content loops        → same-article exposure cap
 *   - source domination               → per-source exposure cap per session
 *   - excessive exploration           → recent-exploration cooldown
 *   - feed staleness                  → staleness flag for the host
 *
 * All checks are pure, in-memory, bounded, and explicit. The host calls
 * `canSend()`, `canRecompute()`, `canShowArticle()`, etc. before doing
 * the user-visible action. The protector NEVER initiates work — it only
 * tells the caller `allowed: false` with a structured reason.
 *
 * HARD RULES:
 *   - PURE COMPUTE. No I/O.
 *   - BOUNDED. LRU-style trimming when per-user state exceeds the cap.
 *   - DETERMINISTIC. Same sequence of recordings → same decisions.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UserProtectionThresholds {
  /** Maximum notifications delivered to a user in 24h. Default 25. */
  notificationsPerDay?: number;
  /** Minimum gap between consecutive notifications, ms. Default 60_000. */
  minNotificationGapMs?: number;
  /** Maximum personalization recomputes per user per hour. Default 6. */
  personalizationRecomputesPerHour?: number;
  /** Minimum gap between personalization recomputes for a user. Default 5 min. */
  minRecomputeGapMs?: number;
  /** Maximum times the same article can be surfaced per user per day. Default 3. */
  sameArticleExposurePerDay?: number;
  /** Fraction of a feed allowed from a single source. Default 0.35. */
  maxSourceShareInFeed?: number;
  /** Fraction of items allowed to be exploration. Default 0.30. */
  maxExplorationRatio?: number;
  /** Feed staleness threshold (ms). Default 30 min. */
  feedStalenessMs?: number;
  /** Max users tracked in-memory. Default 50_000. */
  maxTrackedUsers?: number;
}

export const DEFAULT_USER_PROTECTION_THRESHOLDS: Required<UserProtectionThresholds> = {
  notificationsPerDay: 25,
  minNotificationGapMs: 60_000,
  personalizationRecomputesPerHour: 6,
  minRecomputeGapMs: 5 * 60_000,
  sameArticleExposurePerDay: 3,
  maxSourceShareInFeed: 0.35,
  maxExplorationRatio: 0.30,
  feedStalenessMs: 30 * 60_000,
  maxTrackedUsers: 50_000,
};

export interface Decision {
  allowed: boolean;
  reason?: string;
  /** Suggested cooldown until the operation may be retried (ms). */
  retryAfterMs?: number;
}

export interface FeedAuditSample {
  /** Source ID for each article (length = feed size). */
  sourceIds: string[];
  /** Flag per article: was it surfaced as exploration? */
  isExploration: boolean[];
  /** Age of the freshest item in the feed, ms. */
  oldestItemAgeMs?: number;
}

export interface FeedSafetyResult {
  allowed: boolean;
  reasons: string[];
  /** Largest single-source share observed. */
  topSourceShare: number;
  topSourceId: string | null;
  explorationRatio: number;
  stale: boolean;
}

export interface UserProtector {
  /** Returns whether a notification may be dispatched to this user right now. */
  canSendNotification(userId: string, now: Date): Decision;
  /** Record that a notification was sent (called only on actual dispatch). */
  recordNotificationSent(userId: string, now: Date): void;
  /** Returns whether personalization recompute may run for this user. */
  canRecomputePersonalization(userId: string, now: Date): Decision;
  /** Record a personalization recompute. */
  recordRecompute(userId: string, now: Date): void;
  /** Returns whether an article may be surfaced to this user. */
  canShowArticle(userId: string, articleId: string, now: Date): Decision;
  /** Record an article surfaced to the user. */
  recordArticleShown(userId: string, articleId: string, now: Date): void;
  /** Audit a candidate feed (pre-render) for safety violations. */
  auditFeed(sample: FeedAuditSample): FeedSafetyResult;
  /** Return per-user state for the dashboard. */
  snapshot(userId: string): {
    notificationsLast24h: number;
    lastNotificationAt: Date | null;
    recomputesLastHour: number;
    lastRecomputeAt: Date | null;
    trackedArticleCount: number;
  } | null;
  /** Garbage-collect users whose state hasn't been touched in `staleMs`. */
  reap(now: Date, staleMs?: number): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface UserState {
  notifications: number[]; // timestamps (ms)
  lastNotificationAt: number | null;
  recomputes: number[]; // timestamps (ms)
  lastRecomputeAt: number | null;
  /** articleId → array of timestamps surfaced. */
  articleExposures: Map<string, number[]>;
  lastTouchedAt: number;
}

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

function pruneOlder(arr: number[], cutoff: number): void {
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i += 1;
  if (i > 0) arr.splice(0, i);
}

export function createUserProtector(
  opts: UserProtectionThresholds = {},
): UserProtector {
  const cfg: Required<UserProtectionThresholds> = {
    ...DEFAULT_USER_PROTECTION_THRESHOLDS,
    ...opts,
  };
  const users = new Map<string, UserState>();

  function getOrCreate(userId: string, now: Date): UserState {
    let s = users.get(userId);
    if (!s) {
      s = {
        notifications: [],
        lastNotificationAt: null,
        recomputes: [],
        lastRecomputeAt: null,
        articleExposures: new Map(),
        lastTouchedAt: now.getTime(),
      };
      users.set(userId, s);
      if (users.size > cfg.maxTrackedUsers) {
        // Drop the least-recently-touched user.
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, st] of users) {
          if (st.lastTouchedAt < oldestTs) {
            oldestTs = st.lastTouchedAt;
            oldestId = id;
          }
        }
        if (oldestId && oldestId !== userId) users.delete(oldestId);
      }
    }
    s.lastTouchedAt = now.getTime();
    return s;
  }

  function canSendNotification(userId: string, now: Date): Decision {
    const s = getOrCreate(userId, now);
    const tNow = now.getTime();
    pruneOlder(s.notifications, tNow - DAY_MS);
    if (s.notifications.length >= cfg.notificationsPerDay) {
      const oldest = s.notifications[0] ?? tNow;
      return {
        allowed: false,
        reason: 'notification_daily_ceiling',
        retryAfterMs: Math.max(0, oldest + DAY_MS - tNow),
      };
    }
    if (
      s.lastNotificationAt !== null &&
      tNow - s.lastNotificationAt < cfg.minNotificationGapMs
    ) {
      return {
        allowed: false,
        reason: 'notification_cooldown',
        retryAfterMs: cfg.minNotificationGapMs - (tNow - s.lastNotificationAt),
      };
    }
    return { allowed: true };
  }

  function recordNotificationSent(userId: string, now: Date): void {
    const s = getOrCreate(userId, now);
    s.notifications.push(now.getTime());
    s.lastNotificationAt = now.getTime();
  }

  function canRecomputePersonalization(userId: string, now: Date): Decision {
    const s = getOrCreate(userId, now);
    const tNow = now.getTime();
    pruneOlder(s.recomputes, tNow - HOUR_MS);
    if (s.recomputes.length >= cfg.personalizationRecomputesPerHour) {
      return {
        allowed: false,
        reason: 'personalization_runaway_protection',
        retryAfterMs: (s.recomputes[0] ?? tNow) + HOUR_MS - tNow,
      };
    }
    if (
      s.lastRecomputeAt !== null &&
      tNow - s.lastRecomputeAt < cfg.minRecomputeGapMs
    ) {
      return {
        allowed: false,
        reason: 'recompute_cooldown',
        retryAfterMs: cfg.minRecomputeGapMs - (tNow - s.lastRecomputeAt),
      };
    }
    return { allowed: true };
  }

  function recordRecompute(userId: string, now: Date): void {
    const s = getOrCreate(userId, now);
    s.recomputes.push(now.getTime());
    s.lastRecomputeAt = now.getTime();
  }

  function canShowArticle(userId: string, articleId: string, now: Date): Decision {
    const s = getOrCreate(userId, now);
    const tNow = now.getTime();
    const arr = s.articleExposures.get(articleId);
    if (arr) {
      pruneOlder(arr, tNow - DAY_MS);
      if (arr.length >= cfg.sameArticleExposurePerDay) {
        return {
          allowed: false,
          reason: 'repetitive_content_loop',
          retryAfterMs: Math.max(0, (arr[0] ?? tNow) + DAY_MS - tNow),
        };
      }
    }
    return { allowed: true };
  }

  function recordArticleShown(userId: string, articleId: string, now: Date): void {
    const s = getOrCreate(userId, now);
    const arr = s.articleExposures.get(articleId) ?? [];
    arr.push(now.getTime());
    s.articleExposures.set(articleId, arr);
    // Bound per-user article tracking: drop articles not seen in 48h.
    const cutoff = now.getTime() - 2 * DAY_MS;
    for (const [id, ts] of s.articleExposures) {
      if (ts.length > 0 && ts[ts.length - 1] < cutoff) {
        s.articleExposures.delete(id);
      }
    }
  }

  function auditFeed(sample: FeedAuditSample): FeedSafetyResult {
    const reasons: string[] = [];
    const len = sample.sourceIds.length;
    const counts = new Map<string, number>();
    let exploreCount = 0;
    for (let i = 0; i < len; i += 1) {
      const src = sample.sourceIds[i];
      counts.set(src, (counts.get(src) ?? 0) + 1);
      if (sample.isExploration[i]) exploreCount += 1;
    }
    let topSourceShare = 0;
    let topSourceId: string | null = null;
    for (const [src, c] of counts) {
      const share = len > 0 ? c / len : 0;
      if (share > topSourceShare) {
        topSourceShare = share;
        topSourceId = src;
      }
    }
    if (topSourceShare > cfg.maxSourceShareInFeed) {
      reasons.push(`source_domination:${topSourceId}:${topSourceShare.toFixed(2)}`);
    }
    const explorationRatio = len > 0 ? exploreCount / len : 0;
    if (explorationRatio > cfg.maxExplorationRatio) {
      reasons.push(`excessive_exploration:${explorationRatio.toFixed(2)}`);
    }
    const stale =
      typeof sample.oldestItemAgeMs === 'number' && sample.oldestItemAgeMs > cfg.feedStalenessMs;
    if (stale) reasons.push(`feed_stale:${sample.oldestItemAgeMs}ms`);
    return {
      allowed: reasons.length === 0,
      reasons,
      topSourceShare,
      topSourceId,
      explorationRatio,
      stale,
    };
  }

  function snapshot(userId: string) {
    const s = users.get(userId);
    if (!s) return null;
    return {
      notificationsLast24h: s.notifications.length,
      lastNotificationAt: s.lastNotificationAt ? new Date(s.lastNotificationAt) : null,
      recomputesLastHour: s.recomputes.length,
      lastRecomputeAt: s.lastRecomputeAt ? new Date(s.lastRecomputeAt) : null,
      trackedArticleCount: s.articleExposures.size,
    };
  }

  function reap(now: Date, staleMs = 3 * DAY_MS): number {
    const cutoff = now.getTime() - staleMs;
    let removed = 0;
    for (const [id, s] of users) {
      if (s.lastTouchedAt < cutoff) {
        users.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    canSendNotification,
    recordNotificationSent,
    canRecomputePersonalization,
    recordRecompute,
    canShowArticle,
    recordArticleShown,
    auditFeed,
    snapshot,
    reap,
  };
}
