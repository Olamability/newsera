/**
 * In-memory Supabase fake used by Phase B queue-runner simulation scripts.
 *
 * Models exactly the surface area the runner touches:
 *   - rpc('lease_jobs')            → SKIP-LOCKED-equivalent atomic claim
 *   - rpc('complete_job')          → status='success'
 *   - rpc('fail_job')              → exponential backoff OR DLQ
 *   - rpc('heartbeat_job')         → extend lease
 *   - rpc('enqueue_job')           → insert (with dedup)
 *   - rpc('is_feature_enabled')    → flag lookup
 *   - rpc('queue_depth_for')       → backlog count
 *   - rpc('worker_heartbeat')      → no-op success
 *   - rpc('refresh_ranked_feeds')  → injectable behaviour (default success)
 *   - rpc('apply_article_categorization' / 'reset_feed_for_reingest' /
 *         'refresh_ranked_feed_for_category') → injectable behaviour
 *   - from('categories').select('id').eq(...).maybeSingle()
 *     used by the category normalizer.
 *
 * This fake exists ONLY for the simulation/regression scripts. The real
 * runner uses `@supabase/supabase-js`; we never ship this file to prod.
 */

import { randomUUID } from 'node:crypto';

import type { RpcResponse, SupabaseLike } from '../lib/types';

export interface FakeJobRow {
  id: string;
  queue_name: string;
  job_type: string;
  dedup_key: string | null;
  payload: Record<string, unknown>;
  priority: number;
  status: 'queued' | 'leased' | 'running' | 'success' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  leased_by: string | null;
  leased_until: number | null;
  next_attempt_at: number;
  last_error: string | null;
}

export interface FakeDLQRow {
  id: string;
  original_job_id: string;
  queue_name: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  failed_at: number;
}

export interface FakeCategoryRow {
  id: string;
  slug: string;
}

export interface FakeNotificationEventRow {
  id: string;
  event_type: string;
  target_audience: string;
  target_user_id: string | null;
  article_id: string | null;
  category_id: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  channels: string[];
  dedup_key: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  recipient_count: number;
}

export interface FakeNotificationDeliveryRow {
  id: string;
  event_id: string;
  notification_id: string | null;
  user_id: string | null;
  device_id: string | null;
  push_token: string | null;
  channel: 'inbox' | 'push' | 'realtime' | 'email';
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'skipped';
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  attempts: number;
}

export interface FakeUserDeviceRow {
  user_id: string;
  device_id: string;
  push_token: string;
}

export interface FakeRpcOverrides {
  refresh_ranked_feeds?: () => Promise<RpcResponse<unknown>>;
  refresh_ranked_feed_for_category?: (
    args: Record<string, unknown>,
  ) => Promise<RpcResponse<unknown>>;
  apply_article_categorization?: (
    args: Record<string, unknown>,
  ) => Promise<RpcResponse<unknown>>;
  reset_feed_for_reingest?: (
    args: Record<string, unknown>,
  ) => Promise<RpcResponse<unknown>>;
}

export interface FakeSupabase extends SupabaseLike {
  // Test surface — not part of SupabaseLike.
  _seedJob(row: Omit<FakeJobRow, 'id'> & { id?: string }): FakeJobRow;
  _seedJobs(count: number, partial: Partial<FakeJobRow>): FakeJobRow[];
  _seedCategory(row: FakeCategoryRow): void;
  _seedUserDevices(devices: FakeUserDeviceRow[]): void;
  _seedNotificationUsers(userIds: string[]): void;
  _setFlag(name: string, enabled: boolean): void;
  _setDepth(queue: string, depth: number): void;
  _setOverrides(overrides: FakeRpcOverrides): void;
  _jobs(): FakeJobRow[];
  _dlq(): FakeDLQRow[];
  _byStatus(status: FakeJobRow['status']): FakeJobRow[];
  _notificationEvents(): FakeNotificationEventRow[];
  _notificationDeliveries(): FakeNotificationDeliveryRow[];
  _pendingPushDeliveries(): FakeNotificationDeliveryRow[];
  // Phase D — personalization / ranking introspection.
  _fanoutChunks(): Array<{
    parent_event_id: string | null;
    parent_dedup_key: string | null;
    trace_id: string | null;
    chunk_index: number;
    chunk_total: number;
    recipient_count: number;
    job_id: string | null;
    status: string;
  }>;
  _deliveryHealth(): Array<{
    sink: string;
    event: string;
    count: number;
    reason: string | null;
  }>;
  _negativeSignals(): Array<{
    user_id: string;
    signal_type: string;
    article_id: string | null;
    source_id: string | null;
    category_id: string | null;
    weight: number;
  }>;
  _rankingFeedback(): Array<{
    user_id: string | null;
    feed_variant: string;
    session_dwell_ms: number;
    bounce: boolean;
    quality_score: number;
    diversity_score: number;
    exploration_ratio: number;
  }>;
  _personalizedFeedRows(userId?: string): Array<{
    user_id: string;
    article_id: string;
    rank_position: number;
    personalized_score: number;
  }>;
  _seedPersonalizationData(opts: {
    /** Articles ranked in `ranked_feed_global` order. */
    globalArticles: Array<{
      article_id: string;
      source_id: string | null;
      category_id: string | null;
      global_score: number;
      published_at?: Date;
    }>;
    /** Per-user (category_id|source_id) affinity rows. */
    affinities?: Array<{
      user_id: string;
      category_id?: string | null;
      source_id?: string | null;
      score: number;
    }>;
    /** Per-user article read history. */
    reads?: Array<{ user_id: string; article_id: string }>;
  }): void;
  _affinityFor(userId: string): {
    categories: Map<string, number>;
    sources: Map<string, number>;
  };
}

export function createFakeSupabase(): FakeSupabase {
  const jobs = new Map<string, FakeJobRow>();
  const dlq: FakeDLQRow[] = [];
  const categories = new Map<string, FakeCategoryRow>(); // keyed by id
  const categoriesBySlug = new Map<string, FakeCategoryRow>();
  const flags = new Map<string, boolean>();
  const depths = new Map<string, number>();
  let overrides: FakeRpcOverrides = {};
  // Phase C — notification dispatch tables.
  const notificationEvents = new Map<string, FakeNotificationEventRow>();
  const notificationDeliveries = new Map<string, FakeNotificationDeliveryRow>();
  const userDevices: FakeUserDeviceRow[] = [];
  const notificationUserIds = new Set<string>();

  // Phase D — personalization / ranking storage.
  interface FakeAffinityRow {
    user_id: string;
    category_id: string | null;
    source_id: string | null;
    score: number;
    last_interaction_at: number | null;
  }
  interface FakeNegativeSignalRow {
    user_id: string;
    signal_type: string;
    article_id: string | null;
    source_id: string | null;
    category_id: string | null;
    weight: number;
    created_at: number;
  }
  interface FakeGlobalRow {
    article_id: string;
    source_id: string | null;
    category_id: string | null;
    global_score: number;
    published_at: number;
  }
  interface FakeReadRow {
    user_id: string;
    article_id: string;
  }
  interface FakePersonalizedRow {
    user_id: string;
    article_id: string;
    rank_position: number;
    personalized_score: number;
    computed_at: number;
  }
  interface FakeFanoutChunkRow {
    parent_event_id: string | null;
    parent_dedup_key: string | null;
    trace_id: string | null;
    chunk_index: number;
    chunk_total: number;
    recipient_count: number;
    job_id: string | null;
    status: string;
  }
  interface FakeDeliveryHealthRow {
    sink: string;
    event: string;
    count: number;
    reason: string | null;
    recorded_at: number;
  }
  interface FakeRankingFeedbackRow {
    user_id: string | null;
    feed_variant: string;
    session_dwell_ms: number;
    bounce: boolean;
    quality_score: number;
    diversity_score: number;
    exploration_ratio: number;
  }
  const affinities: FakeAffinityRow[] = [];
  const negativeSignals: FakeNegativeSignalRow[] = [];
  const globalRanked: FakeGlobalRow[] = [];
  const reads: FakeReadRow[] = [];
  const personalizedFeed: FakePersonalizedRow[] = [];
  const personalizationQueue = new Set<string>();
  const fanoutChunks: FakeFanoutChunkRow[] = [];
  const deliveryHealth: FakeDeliveryHealthRow[] = [];
  const rankingFeedback: FakeRankingFeedbackRow[] = [];

  function now(): number {
    return Date.now();
  }

  // ----- lease_jobs --------------------------------------------------------
  async function leaseJobs(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const queue = String(args.p_queue_name);
    const workerId = String(args.p_worker_id);
    const batchSize = Math.max(1, Number(args.p_batch_size ?? 10));
    const leaseSeconds = Math.max(5, Number(args.p_lease_seconds ?? 60));
    const t = now();

    const candidates = Array.from(jobs.values())
      .filter(
        (j) =>
          j.queue_name === queue &&
          ((j.status === 'queued' && j.next_attempt_at <= t) ||
            ((j.status === 'leased' || j.status === 'running') &&
              j.leased_until !== null &&
              j.leased_until < t)),
      )
      .sort((a, b) => b.priority - a.priority || a.next_attempt_at - b.next_attempt_at)
      .slice(0, batchSize);

    const leased = candidates.map((j) => {
      const token = randomUUID();
      j.status = 'leased';
      j.lease_token = token;
      j.leased_by = workerId;
      j.leased_until = t + leaseSeconds * 1000;
      j.attempts += 1;
      return {
        id: j.id,
        job_type: j.job_type,
        payload: j.payload,
        attempts: j.attempts,
        lease_token: token,
        leased_until: new Date(j.leased_until).toISOString(),
      };
    });

    return { data: leased, error: null };
  }

  // ----- complete_job ------------------------------------------------------
  async function completeJob(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const id = String(args.p_job_id);
    const token = String(args.p_lease_token);
    const j = jobs.get(id);
    if (!j || j.lease_token !== token || !(j.status === 'leased' || j.status === 'running')) {
      return { data: false, error: null };
    }
    j.status = 'success';
    j.last_error = null;
    j.lease_token = null;
    j.leased_until = null;
    return { data: true, error: null };
  }

  // ----- fail_job ----------------------------------------------------------
  async function failJob(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const id = String(args.p_job_id);
    const token = String(args.p_lease_token);
    const errorMsg = String(args.p_error ?? '');
    const base = Number(args.p_base_backoff_seconds ?? 30);
    const max = Number(args.p_max_backoff_seconds ?? 3600);

    const j = jobs.get(id);
    if (!j || j.lease_token !== token || !(j.status === 'leased' || j.status === 'running')) {
      return { data: null, error: null };
    }

    if (j.attempts >= j.max_attempts) {
      j.status = 'dead';
      j.last_error = errorMsg;
      j.lease_token = null;
      j.leased_until = null;
      dlq.push({
        id: randomUUID(),
        original_job_id: j.id,
        queue_name: j.queue_name,
        job_type: j.job_type,
        payload: j.payload,
        attempts: j.attempts,
        last_error: errorMsg,
        failed_at: now(),
      });
      return { data: 'dead', error: null };
    }

    const backoffSec = Math.min(base * Math.pow(2, Math.max(j.attempts - 1, 0)), max);
    j.status = 'queued';
    j.last_error = errorMsg;
    j.lease_token = null;
    j.leased_until = null;
    j.next_attempt_at = now() + backoffSec * 1000;
    return { data: 'queued', error: null };
  }

  // ----- heartbeat_job -----------------------------------------------------
  async function heartbeatJob(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const id = String(args.p_job_id);
    const token = String(args.p_lease_token);
    const ext = Math.max(5, Number(args.p_extend_seconds ?? 60));
    const j = jobs.get(id);
    if (!j || j.lease_token !== token) return { data: false, error: null };
    j.leased_until = now() + ext * 1000;
    j.status = 'running';
    return { data: true, error: null };
  }

  // ----- enqueue_job -------------------------------------------------------
  async function enqueueJob(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const queue = String(args.p_queue_name);
    const jobType = String(args.p_job_type);
    const payload = (args.p_payload ?? {}) as Record<string, unknown>;
    const dedup = (args.p_dedup_key ?? null) as string | null;
    const priority = Number(args.p_priority ?? 5);
    const maxAttempts = Math.max(1, Number(args.p_max_attempts ?? 5));

    if (dedup) {
      const existing = Array.from(jobs.values()).find(
        (j) =>
          j.queue_name === queue &&
          j.job_type === jobType &&
          j.dedup_key === dedup &&
          (j.status === 'queued' || j.status === 'leased' || j.status === 'running'),
      );
      if (existing) return { data: existing.id, error: null };
    }

    const id = randomUUID();
    const row: FakeJobRow = {
      id,
      queue_name: queue,
      job_type: jobType,
      dedup_key: dedup,
      payload,
      priority,
      status: 'queued',
      attempts: 0,
      max_attempts: maxAttempts,
      lease_token: null,
      leased_by: null,
      leased_until: null,
      next_attempt_at: now(),
      last_error: null,
    };
    jobs.set(id, row);
    return { data: id, error: null };
  }

  // ----- queue_depth_for ---------------------------------------------------
  async function queueDepthFor(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    const q = String(args.p_queue_name);
    if (depths.has(q)) return { data: depths.get(q) ?? 0, error: null };
    const count = Array.from(jobs.values()).filter(
      (j) => j.queue_name === q && j.status === 'queued',
    ).length;
    return { data: count, error: null };
  }

  // ----- is_feature_enabled ------------------------------------------------
  async function isFeatureEnabled(args: Record<string, unknown>): Promise<RpcResponse<unknown>> {
    return { data: flags.get(String(args.p_name)) ?? false, error: null };
  }

  // ----- Phase C: notification dispatch RPCs ------------------------------
  async function enqueueNotificationEvent(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const dedup = (args.p_dedup_key ?? null) as string | null;
    const eventType = String(args.p_event_type);
    if (dedup) {
      const existing = Array.from(notificationEvents.values()).find(
        (e) =>
          e.event_type === eventType &&
          e.dedup_key === dedup &&
          (e.status === 'pending' || e.status === 'processing'),
      );
      if (existing) return { data: existing.id, error: null };
    }
    const id = randomUUID();
    const row: FakeNotificationEventRow = {
      id,
      event_type: eventType,
      target_audience: String(args.p_target_audience ?? 'all'),
      target_user_id: (args.p_target_user_id ?? null) as string | null,
      article_id: (args.p_article_id ?? null) as string | null,
      category_id: (args.p_category_id ?? null) as string | null,
      title: String(args.p_title ?? ''),
      body: String(args.p_body ?? ''),
      payload: (args.p_payload ?? {}) as Record<string, unknown>,
      channels: Array.isArray(args.p_channels)
        ? (args.p_channels as string[])
        : ['inbox', 'push'],
      dedup_key: dedup,
      status: 'pending',
      recipient_count: 0,
    };
    notificationEvents.set(id, row);
    return { data: id, error: null };
  }

  async function materializeNotificationEvent(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const id = String(args.p_event_id);
    const cap = Math.max(1, Number(args.p_max_recipients ?? 5000));
    const ev = notificationEvents.get(id);
    if (!ev || ev.status !== 'pending') return { data: 0, error: null };
    ev.status = 'processing';

    let recipients: string[];
    if (ev.target_audience === 'specific_user' && ev.target_user_id) {
      recipients = [ev.target_user_id];
    } else if (ev.target_audience === 'category_followers') {
      // Fake: every seeded user is a follower of every category in tests.
      recipients = Array.from(notificationUserIds);
    } else {
      recipients = Array.from(notificationUserIds);
    }
    recipients = recipients.slice(0, cap);

    const inboxEnabled = ev.channels.includes('inbox');
    const pushEnabled = ev.channels.includes('push');
    for (const uid of recipients) {
      if (inboxEnabled) {
        const did = randomUUID();
        notificationDeliveries.set(did, {
          id: did,
          event_id: ev.id,
          notification_id: randomUUID(),
          user_id: uid,
          device_id: null,
          push_token: null,
          channel: 'inbox',
          status: 'delivered',
          provider: null,
          provider_message_id: null,
          error_message: null,
          attempts: 1,
        });
      }
      if (pushEnabled) {
        const devices = userDevices.filter(
          (d) => d.user_id === uid && d.push_token && d.push_token.length > 0,
        );
        for (const dev of devices) {
          const did = randomUUID();
          notificationDeliveries.set(did, {
            id: did,
            event_id: ev.id,
            notification_id: null,
            user_id: uid,
            device_id: dev.device_id,
            push_token: dev.push_token,
            channel: 'push',
            status: 'pending',
            provider: null,
            provider_message_id: null,
            error_message: null,
            attempts: 0,
          });
        }
      }
    }
    ev.status = 'completed';
    ev.recipient_count = recipients.length;
    return { data: recipients.length, error: null };
  }

  async function claimPendingPushDeliveries(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const limit = Math.max(1, Number(args.p_limit ?? 100));
    const claimed: Array<{
      id: string;
      user_id: string | null;
      device_id: string | null;
      push_token: string;
      title: string;
      body: string;
      payload: Record<string, unknown> | null;
    }> = [];
    for (const d of notificationDeliveries.values()) {
      if (d.channel !== 'push' || d.status !== 'pending') continue;
      d.status = 'sent'; // claim; will be re-finalised by record_notification_delivery
      const ev = notificationEvents.get(d.event_id);
      claimed.push({
        id: d.id,
        user_id: d.user_id,
        device_id: d.device_id,
        push_token: d.push_token ?? '',
        title: ev?.title ?? '',
        body: ev?.body ?? '',
        payload: ev?.payload ?? null,
      });
      if (claimed.length >= limit) break;
    }
    return { data: claimed, error: null };
  }

  async function recordNotificationDelivery(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const id = String(args.p_delivery_id);
    const status = String(args.p_status) as FakeNotificationDeliveryRow['status'];
    const d = notificationDeliveries.get(id);
    if (!d) return { data: false, error: null };
    d.status = status;
    d.provider = (args.p_provider ?? d.provider) as string | null;
    d.provider_message_id = (args.p_provider_message_id ?? d.provider_message_id) as
      | string
      | null;
    d.error_message = (args.p_error ?? null) as string | null;
    d.attempts += 1;
    return { data: true, error: null };
  }

  // ----- Phase D: personalization + ranking RPCs --------------------------
  async function recomputeUserAffinity(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    // The fake doesn't actually scan raw signal tables — tests seed the
    // result via `_seedPersonalizationData`. This stub just clears the
    // queue entry so the runner observes "completed".
    const uid = String(args.p_user_id ?? '');
    personalizationQueue.delete(uid);
    return { data: null, error: null };
  }

  async function applyNegativeSignalsToAffinity(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const uid = String(args.p_user_id ?? '');
    // Group by source_id and category_id and apply (1-w) product reduction.
    const srcFactors = new Map<string, number>();
    const catFactors = new Map<string, number>();
    for (const n of negativeSignals) {
      if (n.user_id !== uid) continue;
      if (n.source_id) {
        srcFactors.set(
          n.source_id,
          (srcFactors.get(n.source_id) ?? 1) * Math.max(1 - n.weight, 0.01),
        );
      }
      if (n.category_id) {
        catFactors.set(
          n.category_id,
          (catFactors.get(n.category_id) ?? 1) * Math.max(1 - n.weight, 0.01),
        );
      }
    }
    for (const row of affinities) {
      if (row.user_id !== uid) continue;
      if (row.source_id && srcFactors.has(row.source_id)) {
        row.score = row.score * (srcFactors.get(row.source_id) ?? 1);
      }
      if (row.category_id && catFactors.has(row.category_id)) {
        row.score = row.score * (catFactors.get(row.category_id) ?? 1);
      }
    }
    return { data: null, error: null };
  }

  async function recordNegativeSignal(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const userId = String(args.p_user_id ?? '');
    if (!userId) return { data: null, error: null };
    const id = randomUUID();
    negativeSignals.push({
      user_id: userId,
      signal_type: String(args.p_signal_type ?? ''),
      article_id: (args.p_article_id ?? null) as string | null,
      source_id: (args.p_source_id ?? null) as string | null,
      category_id: (args.p_category_id ?? null) as string | null,
      weight: Math.max(0, Math.min(1, Number(args.p_weight ?? 0.5))),
      created_at: now(),
    });
    personalizationQueue.add(userId);
    return { data: id, error: null };
  }

  async function refreshPersonalizedFeedV2(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const uid = String(args.p_user_id ?? '');
    const limit = Math.max(10, Math.min(500, Number(args.p_limit ?? 200)));
    if (!uid) return { data: 0, error: null };

    // Build per-user affinity lookup.
    const userAff = affinities.filter((a) => a.user_id === uid);
    const catScore = new Map<string, number>();
    const srcScore = new Map<string, number>();
    for (const a of userAff) {
      if (a.category_id) catScore.set(a.category_id, a.score);
      if (a.source_id) srcScore.set(a.source_id, a.score);
    }
    // Suppression: reads + negative signals (hide_article / block_source / mute_category).
    const readSet = new Set(
      reads.filter((r) => r.user_id === uid).map((r) => r.article_id),
    );
    const hiddenArticles = new Set<string>();
    const blockedSources = new Set<string>();
    const mutedCategories = new Set<string>();
    for (const n of negativeSignals) {
      if (n.user_id !== uid) continue;
      if (n.signal_type === 'hide_article' && n.article_id) hiddenArticles.add(n.article_id);
      if (n.signal_type === 'block_source' && n.source_id) blockedSources.add(n.source_id);
      if (n.signal_type === 'mute_category' && n.category_id) mutedCategories.add(n.category_id);
    }

    const t = now();
    const scored = globalRanked
      .filter(
        (g) =>
          !readSet.has(g.article_id) &&
          !hiddenArticles.has(g.article_id) &&
          !(g.source_id && blockedSources.has(g.source_id)) &&
          !(g.category_id && mutedCategories.has(g.category_id)),
      )
      .map((g) => {
        const cat = g.category_id ? catScore.get(g.category_id) ?? 0 : 0;
        const src = g.source_id ? srcScore.get(g.source_id) ?? 0 : 0;
        const affW = Math.min(5, 1 + 0.5 * cat + 0.5 * src);
        const ageHours = Math.max((t - g.published_at) / 3_600_000, 0);
        const fresh = 0.5 * Math.exp(-(Math.LN2 / 24) * ageHours);
        const personalizedScore = g.global_score * affW + fresh;
        return { row: g, personalizedScore };
      })
      .sort((a, b) => b.personalizedScore - a.personalizedScore)
      .slice(0, limit);

    // Replace this user's slice.
    for (let i = personalizedFeed.length - 1; i >= 0; i -= 1) {
      if (personalizedFeed[i].user_id === uid) personalizedFeed.splice(i, 1);
    }
    scored.forEach((s, idx) => {
      personalizedFeed.push({
        user_id: uid,
        article_id: s.row.article_id,
        rank_position: idx + 1,
        personalized_score: Math.round(s.personalizedScore * 10_000) / 10_000,
        computed_at: t,
      });
    });
    return { data: scored.length, error: null };
  }

  async function enqueuePersonalizationRecompute(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const uid = String(args.p_user_id ?? '');
    if (uid) personalizationQueue.add(uid);
    return { data: null, error: null };
  }

  async function recordFanoutChunk(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const id = randomUUID();
    fanoutChunks.push({
      parent_event_id: (args.p_parent_event_id ?? null) as string | null,
      parent_dedup_key: (args.p_parent_dedup_key ?? null) as string | null,
      trace_id: (args.p_trace_id ?? null) as string | null,
      chunk_index: Math.max(0, Number(args.p_chunk_index ?? 0)),
      chunk_total: Math.max(1, Number(args.p_chunk_total ?? 1)),
      recipient_count: Math.max(0, Number(args.p_recipient_count ?? 0)),
      job_id: (args.p_job_id ?? null) as string | null,
      status: 'queued',
    });
    return { data: id, error: null };
  }

  async function recordDeliveryHealthEvent(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const id = randomUUID();
    deliveryHealth.push({
      sink: String(args.p_sink ?? ''),
      event: String(args.p_event ?? ''),
      count: Math.max(1, Number(args.p_count ?? 1)),
      reason: (args.p_reason ?? null) as string | null,
      recorded_at: now(),
    });
    return { data: id, error: null };
  }

  async function deliveryHealthSnapshot(
    _args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const acc = new Map<string, { emitted: number; accepted: number; dropped: number; failed: number }>();
    for (const r of deliveryHealth) {
      const cur = acc.get(r.sink) ?? { emitted: 0, accepted: 0, dropped: 0, failed: 0 };
      if (r.event === 'emitted') cur.emitted += r.count;
      else if (r.event === 'accepted') cur.accepted += r.count;
      else if (r.event === 'dropped') cur.dropped += r.count;
      else if (r.event === 'failed') cur.failed += r.count;
      acc.set(r.sink, cur);
    }
    const data = Array.from(acc.entries()).map(([sink, v]) => ({ sink, ...v }));
    return { data, error: null };
  }

  async function recordRankingFeedback(
    args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const id = randomUUID();
    rankingFeedback.push({
      user_id: (args.p_user_id ?? null) as string | null,
      feed_variant: String(args.p_feed_variant ?? 'personalized_v2'),
      session_dwell_ms: Math.max(0, Number(args.p_session_dwell_ms ?? 0)),
      bounce: Boolean(args.p_bounce ?? false),
      quality_score: Math.max(0, Math.min(1, Number(args.p_quality_score ?? 0))),
      diversity_score: Math.max(0, Math.min(1, Number(args.p_diversity_score ?? 0))),
      exploration_ratio: Math.max(0, Math.min(1, Number(args.p_exploration_ratio ?? 0))),
    });
    return { data: id, error: null };
  }

  async function rankingFeedbackSummary(
    _args: Record<string, unknown>,
  ): Promise<RpcResponse<unknown>> {
    const byVariant = new Map<string, { samples: number; dwell: number; bounce: number; q: number; d: number; e: number }>();
    for (const r of rankingFeedback) {
      const v = byVariant.get(r.feed_variant) ?? { samples: 0, dwell: 0, bounce: 0, q: 0, d: 0, e: 0 };
      v.samples += 1;
      v.dwell += r.session_dwell_ms;
      if (r.bounce) v.bounce += 1;
      v.q += r.quality_score;
      v.d += r.diversity_score;
      v.e += r.exploration_ratio;
      byVariant.set(r.feed_variant, v);
    }
    const data = Array.from(byVariant.entries()).map(([feed_variant, v]) => ({
      feed_variant,
      samples: v.samples,
      avg_dwell_ms: v.samples ? v.dwell / v.samples : 0,
      bounce_rate: v.samples ? v.bounce / v.samples : 0,
      avg_quality: v.samples ? v.q / v.samples : 0,
      avg_diversity: v.samples ? v.d / v.samples : 0,
      avg_exploration: v.samples ? v.e / v.samples : 0,
    }));
    return { data, error: null };
  }

  // ----- Dispatcher --------------------------------------------------------
  async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<RpcResponse<T>> {
    switch (fn) {
      case 'lease_jobs':
        return (await leaseJobs(args)) as RpcResponse<T>;
      case 'complete_job':
        return (await completeJob(args)) as RpcResponse<T>;
      case 'fail_job':
        return (await failJob(args)) as RpcResponse<T>;
      case 'heartbeat_job':
        return (await heartbeatJob(args)) as RpcResponse<T>;
      case 'enqueue_job':
        return (await enqueueJob(args)) as RpcResponse<T>;
      case 'queue_depth_for':
        return (await queueDepthFor(args)) as RpcResponse<T>;
      case 'is_feature_enabled':
        return (await isFeatureEnabled(args)) as RpcResponse<T>;
      case 'worker_heartbeat':
        return { data: null, error: null } as RpcResponse<T>;
      case 'enqueue_notification_event':
        return (await enqueueNotificationEvent(args)) as RpcResponse<T>;
      case 'materialize_notification_event':
        return (await materializeNotificationEvent(args)) as RpcResponse<T>;
      case 'claim_pending_push_deliveries':
        return (await claimPendingPushDeliveries(args)) as RpcResponse<T>;
      case 'record_notification_delivery':
        return (await recordNotificationDelivery(args)) as RpcResponse<T>;
      case 'refresh_ranked_feeds':
        return (overrides.refresh_ranked_feeds
          ? await overrides.refresh_ranked_feeds()
          : { data: null, error: null }) as RpcResponse<T>;
      case 'refresh_ranked_feed_for_category':
        return (overrides.refresh_ranked_feed_for_category
          ? await overrides.refresh_ranked_feed_for_category(args)
          : { data: null, error: null }) as RpcResponse<T>;
      case 'apply_article_categorization':
        return (overrides.apply_article_categorization
          ? await overrides.apply_article_categorization(args)
          : { data: null, error: null }) as RpcResponse<T>;
      case 'reset_feed_for_reingest':
        return (overrides.reset_feed_for_reingest
          ? await overrides.reset_feed_for_reingest(args)
          : { data: null, error: null }) as RpcResponse<T>;
      // Phase D
      case 'recompute_user_affinity':
        return (await recomputeUserAffinity(args)) as RpcResponse<T>;
      case 'apply_negative_signals_to_affinity':
        return (await applyNegativeSignalsToAffinity(args)) as RpcResponse<T>;
      case 'record_negative_signal':
        return (await recordNegativeSignal(args)) as RpcResponse<T>;
      case 'refresh_personalized_feed_v2':
        return (await refreshPersonalizedFeedV2(args)) as RpcResponse<T>;
      case 'enqueue_personalization_recompute':
        return (await enqueuePersonalizationRecompute(args)) as RpcResponse<T>;
      case 'record_fanout_chunk':
        return (await recordFanoutChunk(args)) as RpcResponse<T>;
      case 'record_delivery_health_event':
        return (await recordDeliveryHealthEvent(args)) as RpcResponse<T>;
      case 'delivery_health_snapshot':
        return (await deliveryHealthSnapshot(args)) as RpcResponse<T>;
      case 'record_ranking_feedback':
        return (await recordRankingFeedback(args)) as RpcResponse<T>;
      case 'ranking_feedback_summary':
        return (await rankingFeedbackSummary(args)) as RpcResponse<T>;
      default:
        return { data: null, error: { message: `fake: rpc '${fn}' not implemented` } };
    }
  }

  // ----- from() chain (categories only — that's all the runner uses) -------
  interface ChainState {
    table: string;
    filters: Array<{ col: string; val: unknown }>;
  }
  function makeChain(state: ChainState): {
    select: (_: string) => ReturnType<typeof makeChain>;
    eq: (col: string, val: unknown) => ReturnType<typeof makeChain>;
    maybeSingle: () => Promise<RpcResponse<unknown>>;
  } {
    return {
      select(_: string) {
        return makeChain(state);
      },
      eq(col: string, val: unknown) {
        return makeChain({ ...state, filters: [...state.filters, { col, val }] });
      },
      async maybeSingle(): Promise<RpcResponse<unknown>> {
        if (state.table === 'categories') {
          for (const f of state.filters) {
            if (f.col === 'id') {
              const c = categories.get(String(f.val));
              return { data: c ? { id: c.id } : null, error: null };
            }
            if (f.col === 'slug') {
              const c = categoriesBySlug.get(String(f.val));
              return { data: c ? { id: c.id } : null, error: null };
            }
          }
          return { data: null, error: null };
        }
        if (state.table === 'job_queue') {
          // Used by backpressure fallback. Return at most one row.
          const filters = new Map<string, unknown>();
          for (const f of state.filters) filters.set(f.col, f.val);
          const match = Array.from(jobs.values()).find(
            (j) =>
              (filters.has('queue_name')
                ? j.queue_name === filters.get('queue_name')
                : true) &&
              (filters.has('status') ? j.status === filters.get('status') : true),
          );
          return { data: match ? { id: match.id } : null, error: null };
        }
        return { data: null, error: null };
      },
    };
  }

  const api: FakeSupabase = {
    rpc: rpc as SupabaseLike['rpc'],
    from: (<T = unknown>(table: string) =>
      makeChain({ table, filters: [] }) as unknown as ReturnType<
        SupabaseLike['from']
      >) as SupabaseLike['from'],
    _seedJob(row) {
      const id = row.id ?? randomUUID();
      const full: FakeJobRow = { ...row, id };
      jobs.set(id, full);
      return full;
    },
    _seedJobs(count, partial) {
      const out: FakeJobRow[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push(
          api._seedJob({
            queue_name: partial.queue_name ?? 'ingestion',
            job_type: partial.job_type ?? 'reingest_feed',
            dedup_key: partial.dedup_key ?? null,
            payload: partial.payload ?? { feed_id: randomUUID() },
            priority: partial.priority ?? 5,
            status: partial.status ?? 'queued',
            attempts: partial.attempts ?? 0,
            max_attempts: partial.max_attempts ?? 5,
            lease_token: partial.lease_token ?? null,
            leased_by: partial.leased_by ?? null,
            leased_until: partial.leased_until ?? null,
            next_attempt_at: partial.next_attempt_at ?? Date.now(),
            last_error: partial.last_error ?? null,
          }),
        );
      }
      return out;
    },
    _seedCategory(row) {
      categories.set(row.id, row);
      categoriesBySlug.set(row.slug, row);
    },
    _seedUserDevices(devices) {
      for (const d of devices) {
        userDevices.push(d);
        notificationUserIds.add(d.user_id);
      }
    },
    _seedNotificationUsers(userIds) {
      for (const id of userIds) notificationUserIds.add(id);
    },
    _setFlag(name, enabled) {
      flags.set(name, enabled);
    },
    _setDepth(queue, depth) {
      depths.set(queue, depth);
    },
    _setOverrides(o) {
      overrides = { ...overrides, ...o };
    },
    _jobs() {
      return Array.from(jobs.values());
    },
    _dlq() {
      return [...dlq];
    },
    _byStatus(status) {
      return Array.from(jobs.values()).filter((j) => j.status === status);
    },
    _notificationEvents() {
      return Array.from(notificationEvents.values());
    },
    _notificationDeliveries() {
      return Array.from(notificationDeliveries.values());
    },
    _pendingPushDeliveries() {
      return Array.from(notificationDeliveries.values()).filter(
        (d) => d.channel === 'push' && d.status === 'pending',
      );
    },
    _fanoutChunks() {
      return [...fanoutChunks];
    },
    _deliveryHealth() {
      return deliveryHealth.map((r) => ({
        sink: r.sink,
        event: r.event,
        count: r.count,
        reason: r.reason,
      }));
    },
    _negativeSignals() {
      return negativeSignals.map((n) => ({
        user_id: n.user_id,
        signal_type: n.signal_type,
        article_id: n.article_id,
        source_id: n.source_id,
        category_id: n.category_id,
        weight: n.weight,
      }));
    },
    _rankingFeedback() {
      return rankingFeedback.map((r) => ({ ...r }));
    },
    _personalizedFeedRows(userId?: string) {
      const rows = userId
        ? personalizedFeed.filter((r) => r.user_id === userId)
        : [...personalizedFeed];
      return rows.map((r) => ({
        user_id: r.user_id,
        article_id: r.article_id,
        rank_position: r.rank_position,
        personalized_score: r.personalized_score,
      }));
    },
    _seedPersonalizationData(opts) {
      const t = Date.now();
      for (const g of opts.globalArticles) {
        globalRanked.push({
          article_id: g.article_id,
          source_id: g.source_id ?? null,
          category_id: g.category_id ?? null,
          global_score: g.global_score,
          published_at: g.published_at ? g.published_at.getTime() : t,
        });
      }
      for (const a of opts.affinities ?? []) {
        affinities.push({
          user_id: a.user_id,
          category_id: a.category_id ?? null,
          source_id: a.source_id ?? null,
          score: a.score,
          last_interaction_at: t,
        });
      }
      for (const r of opts.reads ?? []) {
        reads.push({ user_id: r.user_id, article_id: r.article_id });
      }
    },
    _affinityFor(userId: string) {
      const cats = new Map<string, number>();
      const srcs = new Map<string, number>();
      for (const a of affinities) {
        if (a.user_id !== userId) continue;
        if (a.category_id) cats.set(a.category_id, a.score);
        if (a.source_id) srcs.set(a.source_id, a.score);
      }
      return { categories: cats, sources: srcs };
    },
  };
  return api;
}
