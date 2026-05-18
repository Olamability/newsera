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
  };
  return api;
}
