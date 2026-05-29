/**
 * RSS Worker v2 — Phase A execution runtime.
 *
 * Lease-based, heartbeat-driven, crash-safe ingestion worker built on top of
 * the canonical job-orchestration foundation (migrations 039–047).
 *
 * Responsibilities:
 *   - Register and maintain a worker_heartbeats row (worker_type='rss_ingestion')
 *   - Claim due feeds via lease_due_feeds() — never two workers on the same feed
 *   - Reuse the existing JS ingestion primitives (fetchRSS, deduplicateArticles,
 *     saveArticles) so behaviour stays identical to the legacy worker
 *   - Report outcomes via record_feed_ingestion_outcome() (server-side EMA +
 *     exponential backoff) and release_ingestion_job()
 *   - Emit downstream jobs (ranking refresh) through enqueue_job() rather than
 *     calling refresh_trending_feed() inline
 *   - Periodically reap stale workers / leases
 *   - Handle SIGINT/SIGTERM: stop claiming, drain in-flight, mark heartbeat
 *     stopped, exit cleanly
 *
 * Activation:
 *   Gated behind the `queue_based_ingestion` feature flag. If the flag is off
 *   the worker logs and exits 0 so the legacy `worker.js` setInterval loop
 *   remains the sole ingestion path (additive cutover).
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// Reuse the existing JS primitives unchanged — they already encode the
// canonical ingestion behaviour and we explicitly want zero behaviour drift.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pLimit = require('p-limit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const supabase = require('../config/supabase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchRSS } = require('../src/fetchRSS');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deduplicateArticles } = require('../src/deduplicateArticles');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveArticles } = require('../src/saveArticles');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONFIG = {
  workerType: 'rss_ingestion' as const,
  workerId:
    process.env.RSS_WORKER_ID ||
    `rss-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  heartbeatIntervalMs: parsePositiveInt(process.env.RSS_HEARTBEAT_INTERVAL_MS, 30_000),
  claimIntervalMs: parsePositiveInt(process.env.RSS_CLAIM_INTERVAL_MS, 5_000),
  idlePollIntervalMs: parsePositiveInt(process.env.RSS_IDLE_POLL_INTERVAL_MS, 30_000),
  batchSize: parsePositiveInt(process.env.RSS_LEASE_BATCH_SIZE, 5),
  leaseSeconds: parsePositiveInt(process.env.RSS_LEASE_SECONDS, 300),
  perFeedConcurrency: parsePositiveInt(process.env.RSS_FEED_CONCURRENCY, 3),
  staleReapIntervalMs: parsePositiveInt(process.env.RSS_STALE_REAP_INTERVAL_MS, 60_000),
  staleAfterSeconds: parsePositiveInt(process.env.RSS_STALE_AFTER_SECONDS, 180),
  shutdownGraceMs: parsePositiveInt(process.env.RSS_SHUTDOWN_GRACE_MS, 30_000),
  featureFlag: 'queue_based_ingestion' as const,
  flagPollIntervalMs: parsePositiveInt(process.env.RSS_FLAG_POLL_INTERVAL_MS, 30_000),
  // ----- Adaptive scheduling bounds (client-side; DB columns are still the
  // source of truth — these are only used when we adjust fetch_interval_seconds
  // in response to feed productivity). All values clamp at safe defaults so a
  // mis-configured env never starves or hammers a feed.
  adaptiveMinIntervalSeconds: parsePositiveInt(
    process.env.RSS_ADAPTIVE_MIN_INTERVAL_SECONDS,
    300, // 5 min floor — well above the DB CHECK lower bound (60s) so even
         // a maximally-decreased interval stays safely off the constraint
  ),
  adaptiveMaxIntervalSeconds: parsePositiveInt(
    process.env.RSS_ADAPTIVE_MAX_INTERVAL_SECONDS,
    10_800, // 3 h ceiling — within DB CHECK upper bound (86400)
  ),
  adaptiveDecreaseSeconds: parsePositiveInt(
    process.env.RSS_ADAPTIVE_DECREASE_SECONDS,
    60, // shrink interval by 1 min when feed produced new articles
  ),
  adaptiveIncreaseSeconds: parsePositiveInt(
    process.env.RSS_ADAPTIVE_INCREASE_SECONDS,
    120, // grow interval by 2 min when feed produced no new articles
  ),
};

// ---------------------------------------------------------------------------
// Structured JSON logger
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: 'rss-worker',
    worker_id: CONFIG.workerId,
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeasedFeed {
  feed_id: string;
  name: string;
  url: string;
  source_id: string | null;
  priority: number | null;
  reliability_score: number | null;
  lease_token: string;
  leased_until: string;
}

interface FeedMetrics {
  fetched: number;
  inserted: number;
  duplicates: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let shuttingDown = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let staleReapTimer: NodeJS.Timeout | null = null;
const inFlight = new Set<string>(); // feed_id values currently being processed
let exitCode = 0;

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function isFeatureEnabled(name: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('is_feature_enabled', { p_name: name });
    if (error) {
      log('warn', 'feature_flag_check_failed', { flag: name, error: error.message });
      return false;
    }
    return Boolean(data);
  } catch (err) {
    log('warn', 'feature_flag_check_threw', {
      flag: name,
      error: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}

async function sendHeartbeat(metadata: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('worker_heartbeat', {
      p_worker_id: CONFIG.workerId,
      p_worker_type: CONFIG.workerType,
      p_hostname: hostname(),
      p_pid: process.pid,
      p_metadata: {
        version: 'v2',
        in_flight: inFlight.size,
        ...metadata,
      },
    });
    if (error) {
      log('warn', 'heartbeat_failed', { error: error.message });
      return false;
    }
    return true;
  } catch (err) {
    log('warn', 'heartbeat_threw', { error: (err as Error)?.message ?? String(err) });
    return false;
  }
}

/**
 * Verify that the heartbeat upsert actually landed in
 * `worker_heartbeats` after startup. Without this, a silent RPC
 * failure (e.g. permission drift on `worker_heartbeat`, RLS
 * misconfiguration, or a stale schema) shows up only as "no rows
 * in worker_heartbeats" with no corresponding error in the worker
 * logs — exactly the symptom reported in production.
 */
async function verifyHeartbeatRegistered(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('worker_heartbeats')
      .select('worker_id, worker_type, status, last_heartbeat_at')
      .eq('worker_id', CONFIG.workerId)
      .eq('worker_type', CONFIG.workerType)
      .maybeSingle();
    if (error) {
      log('error', 'heartbeat_register_failed', { error: error.message });
      return false;
    }
    if (!data) {
      log('error', 'heartbeat_register_failed', {
        reason: 'no_row_after_upsert',
        hint: 'worker_heartbeat RPC returned without error but no row landed — check RLS / grants',
      });
      return false;
    }
    log('info', 'heartbeat_registered', {
      worker_type: data.worker_type,
      status: data.status,
      last_heartbeat_at: data.last_heartbeat_at,
    });
    return true;
  } catch (err) {
    log('error', 'heartbeat_register_threw', {
      error: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}

/**
 * Mark this worker's heartbeat row as stopped during graceful shutdown.
 * worker_heartbeat() always upserts status='alive', so we update directly
 * (allowed by the service-role RLS policy on worker_heartbeats).
 */
async function markHeartbeatStopped(): Promise<void> {
  try {
    const { error } = await supabase
      .from('worker_heartbeats')
      .update({ status: 'stopped', last_heartbeat_at: new Date().toISOString() })
      .eq('worker_id', CONFIG.workerId)
      .eq('worker_type', CONFIG.workerType);
    if (error) {
      log('warn', 'heartbeat_stop_failed', { error: error.message });
    }
  } catch (err) {
    log('warn', 'heartbeat_stop_threw', { error: (err as Error)?.message ?? String(err) });
  }
}

// ---------------------------------------------------------------------------
// Schema-drift defense: column probe for rss_feed_sources
// ---------------------------------------------------------------------------

/**
 * Adaptive scheduling and reliability scoring rely on optional columns on
 * `rss_feed_sources` (`fetch_interval_seconds`, `backoff_seconds`,
 * `reliability_score`). Migration 040 introduced them, but the worker MUST
 * tolerate an environment where one of those migrations has not yet been
 * applied — that is the explicit "no schema assumptions" production-safety
 * requirement.
 *
 * We probe once at startup using `information_schema.columns`. If the probe
 * itself fails (permission drift, missing grants, etc.) we conservatively
 * assume nothing is available, which forces every adaptive code path to
 * no-op and degrade to the legacy behavior driven by
 * `record_feed_ingestion_outcome`.
 */
const ADAPTIVE_OPTIONAL_COLUMNS = [
  'fetch_interval_seconds',
  'backoff_seconds',
  'reliability_score',
] as const;
type AdaptiveColumn = (typeof ADAPTIVE_OPTIONAL_COLUMNS)[number];

let feedSourceColumns: Set<string> | null = null;

async function probeFeedSourceColumns(): Promise<Set<string>> {
  // 1) Preferred path: query information_schema directly. Service-role has
  //    read access to information_schema in standard Supabase deployments.
  //    The `as never` cast is required because the Supabase generated types
  //    don't enumerate system-catalog tables; we're querying a stable
  //    PostgreSQL system view, not a user table, so bypassing the typed
  //    table registry here is safe and intentional.
  try {
    const { data, error } = await supabase
      .from('information_schema.columns' as never)
      .select('column_name')
      .eq('table_schema', 'public')
      .eq('table_name', 'rss_feed_sources');
    if (!error && Array.isArray(data)) {
      const cols = new Set<string>(
        (data as Array<{ column_name: string }>).map((r) => r.column_name),
      );
      log('info', 'feed_source_columns_probed', {
        method: 'information_schema',
        column_count: cols.size,
        adaptive_columns_present: ADAPTIVE_OPTIONAL_COLUMNS.filter((c) => cols.has(c)),
      });
      return cols;
    }
    // Fall through to the empty-row probe below.
    if (error) {
      log('warn', 'feed_source_columns_probe_failed', {
        method: 'information_schema',
        error: error.message,
      });
    }
  } catch (err) {
    log('warn', 'feed_source_columns_probe_threw', {
      method: 'information_schema',
      error: (err as Error)?.message ?? String(err),
    });
  }

  // 2) Fallback: ask Postgres for a zero-row sample with the columns we care
  //    about. PostgREST returns a `column does not exist` error per-column,
  //    so we probe each adaptive column individually. This works in
  //    environments where `information_schema` access is restricted.
  const present = new Set<string>();
  for (const col of ADAPTIVE_OPTIONAL_COLUMNS) {
    try {
      const { error } = await supabase
        .from('rss_feed_sources')
        .select(col)
        .limit(0);
      if (!error) {
        present.add(col);
      }
    } catch {
      // Treat throws as "not present"; we already log probe failures above.
    }
  }
  log('info', 'feed_source_columns_probed', {
    method: 'select_limit_zero_fallback',
    adaptive_columns_present: Array.from(present),
  });
  return present;
}

function hasFeedColumn(name: AdaptiveColumn): boolean {
  // Default to "present" only if the probe completed successfully and saw it.
  // If the probe has not yet run (e.g. tests, or startup ordering edge case)
  // we err on the side of "absent" so adaptive writes silently no-op.
  return feedSourceColumns !== null && feedSourceColumns.has(name);
}

/**
 * DEPRECATED — DO NOT CALL.
 *
 * Historical worker-side adaptive interval tuning. Retained intentionally
 * (logic preserved, usage disabled) per the "single source of truth"
 * refactor: the database is now the sole owner of scheduling decisions via
 * `apply_feed_ingestion_signal()` (migration 058) and
 * `record_feed_ingestion_outcome()` (migration 040). The worker now only
 * emits ingestion signals through {@link recordFeedIngestionSignal}, and
 * never mutates `fetch_interval_seconds` directly.
 *
 * Kept here (not deleted) so that:
 *   - reverting the refactor is a one-line change if scheduling regresses;
 *   - the original adaptive constants in CONFIG remain documented;
 *   - reviewers can compare old vs new behavior at a glance.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function adjustAdaptiveFetchInterval(
  feedId: string,
  hadNewArticles: boolean,
  baseLog: Record<string, unknown>,
): Promise<void> {
  if (!hasFeedColumn('fetch_interval_seconds')) {
    return;
  }
  try {
    const { data, error } = await supabase
      .from('rss_feed_sources')
      .select('fetch_interval_seconds')
      .eq('id', feedId)
      .maybeSingle();
    if (error || !data) {
      // Row may have been deleted out from under us — that is fine.
      return;
    }
    const current = Number(
      (data as { fetch_interval_seconds: number | null }).fetch_interval_seconds,
    );
    if (!Number.isFinite(current) || current <= 0) {
      return;
    }
    const delta = hadNewArticles
      ? -CONFIG.adaptiveDecreaseSeconds
      : CONFIG.adaptiveIncreaseSeconds;
    const next = Math.min(
      CONFIG.adaptiveMaxIntervalSeconds,
      Math.max(CONFIG.adaptiveMinIntervalSeconds, current + delta),
    );
    if (next === current) {
      return;
    }
    const { error: updateError } = await supabase
      .from('rss_feed_sources')
      .update({ fetch_interval_seconds: next })
      .eq('id', feedId);
    if (updateError) {
      log('warn', 'adaptive_interval_update_failed', {
        ...baseLog,
        previous_interval_seconds: current,
        next_interval_seconds: next,
        had_new_articles: hadNewArticles,
        error: updateError.message,
      });
      return;
    }
    log('info', 'adaptive_interval_adjusted', {
      ...baseLog,
      previous_interval_seconds: current,
      next_interval_seconds: next,
      had_new_articles: hadNewArticles,
    });
  } catch (err) {
    log('warn', 'adaptive_interval_threw', {
      ...baseLog,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Read-only eligibility probe (migration 054). Returns the number
 * of feeds that *should* have been leased on the next poll. Used
 * exclusively for observability: when `lease_due_feeds` returns
 * zero rows we still want to know whether the database had eligible
 * feeds that were somehow excluded by the leasing path, vs. a
 * genuine "no work" state.
 *
 * Best-effort: any RPC / permission failure degrades to `null` so
 * the claim loop is never blocked by an observability call.
 */
interface DueFeedCounts {
  eligible_feeds: number | null;
  active_feeds: number | null;
  leased_feeds: number | null;
}

async function countDueFeeds(): Promise<DueFeedCounts> {
  try {
    const { data, error } = await supabase.rpc('count_due_feeds');
    if (error) {
      log('warn', 'count_due_feeds_failed', { error: error.message });
      return { eligible_feeds: null, active_feeds: null, leased_feeds: null };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const toNum = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      return Number.isFinite(n) ? n : null;
    };
    return {
      eligible_feeds: toNum(row?.eligible_feeds),
      active_feeds: toNum(row?.active_feeds),
      leased_feeds: toNum(row?.leased_feeds),
    };
  } catch (err) {
    log('warn', 'count_due_feeds_threw', {
      error: (err as Error)?.message ?? String(err),
    });
    return { eligible_feeds: null, active_feeds: null, leased_feeds: null };
  }
}

/**
 * Empty-table bootstrap (migration 056). On startup, if
 * `rss_feed_sources` contains zero rows the worker would idle
 * forever — there is nothing for `lease_due_feeds` to claim and
 * no operator-driven feedback loop. We call the admin-safe
 * `seed_default_rss_feeds()` RPC exactly once at startup to plant
 * the default catalogue. The RPC is idempotent and gated by
 * `_is_admin_caller()`; the worker authenticates with
 * `service_role`, which satisfies that check.
 *
 * Best-effort: any RPC / permission failure is logged and the
 * worker continues so the operator path (manual SQL editor RPC
 * call) is never blocked by a worker-side bootstrap error.
 */
async function bootstrapDefaultFeedsIfEmpty(): Promise<void> {
  try {
    const { data: statsData, error: statsError } = await supabase.rpc('get_rss_feed_stats');
    if (statsError) {
      log('warn', 'feed_bootstrap_stats_failed', { error: statsError.message });
      return;
    }
    const statsRow = Array.isArray(statsData) ? statsData[0] : statsData;
    const totalFeeds =
      statsRow && statsRow.total_feeds !== undefined && statsRow.total_feeds !== null
        ? Number(statsRow.total_feeds)
        : null;
    if (totalFeeds === null || !Number.isFinite(totalFeeds)) {
      log('warn', 'feed_bootstrap_stats_unparseable', { stats: statsRow });
      return;
    }
    if (totalFeeds > 0) {
      log('info', 'feed_bootstrap_skipped', {
        reason: 'rss_feed_sources_already_populated',
        total_feeds: totalFeeds,
        active_feeds: statsRow?.active_feeds ?? null,
        eligible_feeds: statsRow?.eligible_feeds ?? null,
      });
      return;
    }
    log('warn', 'feed_bootstrap_empty_table_detected', {
      hint: 'rss_feed_sources is empty — invoking seed_default_rss_feeds()',
    });
    const { data: seedData, error: seedError } = await supabase.rpc('seed_default_rss_feeds');
    if (seedError) {
      log('error', 'feed_bootstrap_seed_failed', { error: seedError.message });
      return;
    }
    log('info', 'feed_bootstrap_seed_success', { result: seedData });
  } catch (err) {
    log('warn', 'feed_bootstrap_threw', {
      error: (err as Error)?.message ?? String(err),
    });
  }
}

async function leaseDueFeeds(): Promise<LeasedFeed[]> {
  const { data, error } = await supabase.rpc('lease_due_feeds', {
    p_worker_id: CONFIG.workerId,
    p_batch_size: CONFIG.batchSize,
    p_lease_seconds: CONFIG.leaseSeconds,
  });
  if (error) {
    log('error', 'lease_due_feeds_failed', { error: error.message });
    return [];
  }
  const leased = (data as LeasedFeed[]) || [];
  if (leased.length === 0) {
    // Structured "no work" signal — distinguishes a healthy idle
    // loop from a silently failing RPC. Required by PART A of the
    // production stabilization spec ("Prevent silent catch-and-
    // idle behavior").
    //
    // We also emit the eligibility counts so an operator can tell
    // at a glance whether the database genuinely has no due feeds
    // or whether the leasing path is silently dropping work
    // (e.g. all eligible feeds are currently leased, or the
    // eligibility predicate is too strict).
    const counts = await countDueFeeds();
    log('info', 'lease_due_feeds_idle', {
      next_poll_in_ms: CONFIG.idlePollIntervalMs,
      eligible_feeds: counts.eligible_feeds,
      active_feeds: counts.active_feeds,
      leased_feeds: counts.leased_feeds,
      sql_result_count: 0,
      ingestion_jobs_inserted: 0,
    });
  } else {
    log('info', 'lease_due_feeds_success', {
      count: leased.length,
      // PART D observability: explicit alias for the per-cycle
      // ingestion-jobs upsert count — same value as `count`, kept
      // distinct so dashboards/alerts can pivot on a stable name
      // regardless of future shape changes to this log line.
      sql_result_count: leased.length,
      ingestion_jobs_inserted: leased.length,
      feed_ids: leased.map((f) => f.feed_id),
    });
  }
  return leased;
}

/**
 * Emit a queue-depth snapshot so the activation/admin panels and
 * operators can correlate worker activity against the orchestration
 * tables. Counts are best-effort: any RPC/permission error degrades
 * silently to a single warn log line so it never blocks ingestion.
 */
async function logQueueDepth(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('ingestion_jobs')
      .select('last_status');
    if (error) {
      log('warn', 'queue_depth_query_failed', { error: error.message });
      return;
    }
    const rows = (data as Array<{ last_status: string | null }>) || [];
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      const key = r.last_status ?? 'null';
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    log('info', 'queue_depth', {
      ingestion_jobs_total: rows.length,
      by_status: byStatus,
    });
  } catch (err) {
    log('warn', 'queue_depth_threw', {
      error: (err as Error)?.message ?? String(err),
    });
  }
}

async function recordFeedOutcome(
  feedId: string,
  success: boolean,
  latencyMs: number,
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_feed_ingestion_outcome', {
      p_feed_id: feedId,
      p_success: success,
      p_latency_ms: latencyMs,
      p_error: errorMessage,
    });
    if (error) {
      log('warn', 'record_outcome_failed', { feed_id: feedId, error: error.message });
    }
  } catch (err) {
    log('warn', 'record_outcome_threw', {
      feed_id: feedId,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Worker-emitted adaptive scheduling signal. The DB-side
 * `apply_feed_ingestion_signal` RPC (migration 058) is the single source of
 * truth for adjusting `fetch_interval_seconds`; the worker only reports the
 * outcome and never mutates scheduling columns directly.
 *
 * Failsafe contract (per the refactor spec):
 *   - RPC failures are logged at warn level only — they MUST NOT block or
 *     fail the ingestion path.
 *   - If the RPC is missing (e.g. migration not yet applied) or any column
 *     it relies on is absent, the DB function itself silently no-ops, and
 *     we treat any error here as benign.
 *   - The worker continues to call `record_feed_ingestion_outcome` and
 *     `release_ingestion_job` regardless, so legacy observability is
 *     preserved.
 */
type FeedIngestionSignal =
  | 'success_with_new_articles'
  | 'success_no_new_articles'
  | 'failed_fetch';

async function recordFeedIngestionSignal(
  feedId: string,
  signal: FeedIngestionSignal,
  fetchedCount: number,
  latencyMs: number,
  baseLog: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('apply_feed_ingestion_signal', {
      p_feed_id: feedId,
      p_worker_id: CONFIG.workerId,
      p_signal: signal,
      p_fetched_count: Math.max(0, Math.floor(fetchedCount || 0)),
      p_latency_ms: Math.max(0, Math.floor(latencyMs || 0)),
      p_timestamp: new Date().toISOString(),
    });
    if (error) {
      log('warn', 'ingestion_signal_failed', {
        ...baseLog,
        signal,
        error: error.message,
      });
    }
  } catch (err) {
    log('warn', 'ingestion_signal_threw', {
      ...baseLog,
      signal,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

async function releaseLease(
  feedId: string,
  leaseToken: string,
  status: 'success' | 'failed',
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('release_ingestion_job', {
      p_feed_id: feedId,
      p_lease_token: leaseToken,
      p_status: status,
      p_error: errorMessage,
    });
    if (error) {
      log('warn', 'release_lease_failed', { feed_id: feedId, error: error.message });
    }
  } catch (err) {
    log('warn', 'release_lease_threw', {
      feed_id: feedId,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Emit a downstream ranking refresh job. Deduplicated server-side so a burst
 * of feeds inserting articles within the lease window collapses into a single
 * refresh request — no polling storms, no thundering-herd refreshes.
 */
async function enqueueRankingRefresh(traceId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('enqueue_job', {
      p_queue_name: 'ranking',
      p_job_type: 'refresh_ranked_feeds',
      p_payload: { trace_id: traceId, source: 'rss-worker' },
      p_dedup_key: 'refresh_ranked_feeds:pending',
      p_priority: 5,
      p_max_attempts: 5,
    });
    if (error) {
      log('warn', 'enqueue_ranking_failed', { trace_id: traceId, error: error.message });
    }
  } catch (err) {
    log('warn', 'enqueue_ranking_threw', {
      trace_id: traceId,
      error: (err as Error)?.message ?? String(err),
    });
  }
}

async function reapStaleWorkers(): Promise<void> {
  try {
    const { error } = await supabase.rpc('mark_stale_workers_crashed', {
      p_stale_after_seconds: CONFIG.staleAfterSeconds,
    });
    if (error) {
      log('warn', 'reap_stale_workers_failed', { error: error.message });
    }
  } catch (err) {
    log('warn', 'reap_stale_workers_threw', {
      error: (err as Error)?.message ?? String(err),
    });
  }
}

/**
 * Category resolution is deterministic by design:
 *   - `category_id` is sourced ONLY from `sources.category_id`.
 *   - Any free-text `category` field that may appear in lease RPC results is
 *     deliberately ignored — coupling ingestion to free text was the root
 *     cause of misaligned personalization / ranking buckets in production.
 *   - When `sources.category_id` is missing or unresolvable we fall back to
 *     the well-known "uncategorized" category (looked up once by slug and
 *     cached). If even that lookup fails we surface `null` rather than
 *     crashing — ingestion never blocks on category resolution.
 */
const UNCATEGORIZED_SLUG = 'uncategorized' as const;
let uncategorizedCategoryIdCache: string | null | undefined = undefined;

async function getUncategorizedCategoryId(): Promise<string | null> {
  if (uncategorizedCategoryIdCache !== undefined) {
    return uncategorizedCategoryIdCache;
  }
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('id')
      .eq('slug', UNCATEGORIZED_SLUG)
      .maybeSingle();
    if (error) {
      log('warn', 'uncategorized_lookup_failed', { error: error.message });
      uncategorizedCategoryIdCache = null;
      return null;
    }
    uncategorizedCategoryIdCache = (data?.id as string | null) ?? null;
    return uncategorizedCategoryIdCache;
  } catch (err) {
    log('warn', 'uncategorized_lookup_threw', {
      error: (err as Error)?.message ?? String(err),
    });
    uncategorizedCategoryIdCache = null;
    return null;
  }
}

interface ResolvedCategory {
  categoryId: string | null;
  usedFallback: boolean;
}

async function resolveCategoryId(
  sourceId: string | null,
  baseLog: Record<string, unknown>,
): Promise<ResolvedCategory> {
  if (sourceId) {
    try {
      const { data, error } = await supabase
        .from('sources')
        .select('category_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (error) {
        log('warn', 'resolve_category_failed', {
          ...baseLog,
          source_id: sourceId,
          error: error.message,
        });
      } else {
        const categoryId = (data?.category_id as string | null) ?? null;
        if (categoryId) {
          return { categoryId, usedFallback: false };
        }
      }
    } catch (err) {
      log('warn', 'resolve_category_threw', {
        ...baseLog,
        source_id: sourceId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  // Fail-safe fallback — never crash ingestion on missing category.
  const fallbackId = await getUncategorizedCategoryId();
  log('warn', 'missing_category_fallback_used', {
    ...baseLog,
    source_id: sourceId,
    fallback_category_slug: UNCATEGORIZED_SLUG,
    fallback_category_id: fallbackId,
  });
  return { categoryId: fallbackId, usedFallback: true };
}

// ---------------------------------------------------------------------------
// Per-feed ingestion pipeline
// ---------------------------------------------------------------------------

interface FeedOutcome {
  success: boolean;
  hadNewArticles: boolean;
  durationMs: number;
}

async function processLeasedFeed(feed: LeasedFeed): Promise<FeedOutcome> {
  // trace_id is generated ONCE per feed execution and is treated as immutable
  // for the rest of this function. Every log line, every article inserted,
  // and the downstream ranking job all carry this same value so an operator
  // can trace a single ingestion batch end-to-end.
  const traceId = randomUUID();
  const startedAt = Date.now();
  inFlight.add(feed.feed_id);

  const baseLog = {
    trace_id: traceId,
    feed_id: feed.feed_id,
    feed_name: feed.name,
    source_id: feed.source_id,
    lease_token: feed.lease_token,
  };

  log('info', 'feed_lease_claimed', baseLog);
  log('info', 'ingestion_job_started', {
    ...baseLog,
    worker_id: CONFIG.workerId,
    started_at: new Date(startedAt).toISOString(),
  });

  const metrics: FeedMetrics = { fetched: 0, inserted: 0, duplicates: 0, durationMs: 0 };
  let success = false;
  let errorMessage: string | null = null;
  let resolvedCategoryId: string | null = null;

  try {
    const { categoryId } = await resolveCategoryId(feed.source_id, baseLog);
    resolvedCategoryId = categoryId;

    // Shape an object compatible with the existing fetchRSS / saveArticles
    // primitives, which expect { id, name, rss_url, category_id }. Note we
    // intentionally do NOT pass through any free-text `category` field from
    // the lease RPC result — category_id is the single source of truth.
    const sourceLike = {
      id: feed.source_id,
      name: feed.name,
      rss_url: feed.url,
      category_id: categoryId,
    };

    const articles = await fetchRSS(sourceLike);
    metrics.fetched = articles.length;

    if (articles.length === 0) {
      success = true;
    } else {
      const { fresh, duplicateCount } = await deduplicateArticles(articles);
      metrics.duplicates += duplicateCount;

      if (fresh.length === 0) {
        success = true;
      } else {
        const saveContext = {
          trace_id: traceId,
          worker_id: CONFIG.workerId,
          feed_id: feed.feed_id,
          source_id: feed.source_id,
        };
        const saved = await saveArticles(fresh, saveContext);
        metrics.inserted = saved.inserted;
        metrics.duplicates += saved.skippedDuplicates;

        if (saved.failedBatches > 0) {
          errorMessage =
            saved.errorMessage || `Failed to save ${saved.failedBatches} batch(es)`;
        } else {
          success = true;
        }
      }
    }
  } catch (err) {
    errorMessage = (err as Error)?.message ?? String(err);
    log('error', 'feed_ingest_threw', { ...baseLog, error: errorMessage });
  } finally {
    metrics.durationMs = Date.now() - startedAt;

    // Always release the lease and record the outcome — even on error — so the
    // lease never lingers and server-side backoff updates correctly.
    //
    // Adaptive scheduling is now DB-driven (single source of truth):
    // the worker only emits a signal and `apply_feed_ingestion_signal`
    // (migration 058) decides whether/how to nudge
    // `fetch_interval_seconds`. `record_feed_ingestion_outcome` continues
    // to own the next_fetch_at = now() + fetch_interval_seconds +
    // backoff_seconds computation, so emitting the signal BEFORE the
    // outcome RPC means any cadence change picks up in the same cycle.
    // Failsafe: signal RPC errors are logged at warn level and never
    // block ingestion.
    let signal: FeedIngestionSignal;
    if (success) {
      signal = metrics.inserted > 0
        ? 'success_with_new_articles'
        : 'success_no_new_articles';
    } else {
      signal = 'failed_fetch';
    }
    await recordFeedIngestionSignal(
      feed.feed_id,
      signal,
      metrics.inserted,
      metrics.durationMs,
      baseLog,
    );

    await recordFeedOutcome(
      feed.feed_id,
      success,
      metrics.durationMs,
      success ? null : errorMessage,
    );
    await releaseLease(
      feed.feed_id,
      feed.lease_token,
      success ? 'success' : 'failed',
      success ? null : errorMessage,
    );

    if (success && metrics.inserted > 0) {
      await enqueueRankingRefresh(traceId);
    }

    inFlight.delete(feed.feed_id);

    // Standardized per-feed completion log. Keep this schema stable — it is
    // the contract dashboards and alerts depend on.
    log(success ? 'info' : 'warn', 'feed_lease_released', {
      ...baseLog,
      category_id: resolvedCategoryId,
      status: success ? 'success' : 'failed',
      fetched: metrics.fetched,
      articles_inserted: metrics.inserted,
      duplicates_skipped: metrics.duplicates,
      duration_ms: metrics.durationMs,
      error: errorMessage,
    });

    // Companion ingestion_job_* events. These are the canonical names used
    // by the production dashboards / log routers; `feed_lease_released`
    // is kept for backward compatibility with existing alert rules.
    log(success ? 'info' : 'error', success ? 'ingestion_job_success' : 'ingestion_job_failed', {
      ...baseLog,
      worker_id: CONFIG.workerId,
      category_id: resolvedCategoryId,
      articles_inserted: metrics.inserted,
      duplicates_skipped: metrics.duplicates,
      duration_ms: metrics.durationMs,
      completed_at: new Date().toISOString(),
      ...(success ? {} : { error_message: errorMessage }),
    });
  }

  return {
    success,
    hadNewArticles: success && metrics.inserted > 0,
    durationMs: metrics.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Claim loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimLoop(): Promise<void> {
  const limit = pLimit(CONFIG.perFeedConcurrency);
  let lastFlagCheck = 0;
  let flagEnabled = true;

  while (!shuttingDown) {
    // Re-check the feature flag periodically so an operator can drain the
    // worker simply by flipping the flag off — no kill required.
    const now = Date.now();
    if (now - lastFlagCheck >= CONFIG.flagPollIntervalMs) {
      flagEnabled = await isFeatureEnabled(CONFIG.featureFlag);
      lastFlagCheck = now;
      if (!flagEnabled) {
        log('info', 'feature_flag_disabled_idle', { flag: CONFIG.featureFlag });
      }
    }

    if (!flagEnabled) {
      await sleep(CONFIG.flagPollIntervalMs);
      continue;
    }

    const cycleStartedAt = Date.now();
    const feeds = await leaseDueFeeds();

    if (feeds.length === 0) {
      // Cycle yielded no leases — still emit a (mostly-zero) metrics line so
      // dashboards can chart "idle" cycles distinctly from "no log" cycles.
      log('info', 'cycle_metrics', {
        feeds_checked: 0,
        feeds_skipped: 0,
        feeds_fetched: 0,
        feeds_failed: 0,
        avg_fetch_latency_ms: 0,
        cycle_duration_ms: Date.now() - cycleStartedAt,
      });
      await sleep(CONFIG.idlePollIntervalMs);
      continue;
    }

    // Process the leased batch with bounded concurrency; await the whole batch
    // before claiming again so we never exceed perFeedConcurrency * batchSize
    // open ingestions and never leak leases on shutdown.
    const outcomes = await Promise.all(
      feeds.map((feed) =>
        limit(() =>
          processLeasedFeed(feed).catch((err) => {
            log('error', 'process_leased_feed_unhandled', {
              feed_id: feed.feed_id,
              error: (err as Error)?.message ?? String(err),
            });
            return null;
          }),
        ),
      ),
    );

    // -------------------------------------------------------------------
    // Per-cycle efficiency metrics (PART 3 of the smart-polling spec).
    // Pure observability: no behavior change to ingestion. Counters:
    //   feeds_checked       — feeds actually leased this cycle
    //   feeds_skipped       — successful runs that produced no new articles
    //                         (the "wasted poll" signal the spec targets)
    //   feeds_fetched       — successful runs that produced new articles
    //   feeds_failed        — runs that errored / threw / returned null
    //   avg_fetch_latency_ms — mean per-feed durationMs across the batch
    // -------------------------------------------------------------------
    let feedsFetched = 0;
    let feedsSkipped = 0;
    let feedsFailed = 0;
    let latencySum = 0;
    let latencySamples = 0;
    for (const outcome of outcomes) {
      if (!outcome) {
        feedsFailed += 1;
        continue;
      }
      latencySum += outcome.durationMs;
      latencySamples += 1;
      if (!outcome.success) {
        feedsFailed += 1;
      } else if (outcome.hadNewArticles) {
        feedsFetched += 1;
      } else {
        feedsSkipped += 1;
      }
    }
    log('info', 'cycle_metrics', {
      feeds_checked: feeds.length,
      feeds_skipped: feedsSkipped,
      feeds_fetched: feedsFetched,
      feeds_failed: feedsFailed,
      avg_fetch_latency_ms:
        latencySamples > 0 ? Math.round(latencySum / latencySamples) : 0,
      cycle_duration_ms: Date.now() - cycleStartedAt,
    });

    if (!shuttingDown) {
      await sleep(CONFIG.claimIntervalMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, CONFIG.heartbeatIntervalMs);
  // Don't keep the event loop alive purely for the heartbeat — the claim loop
  // is the primary keep-alive driver.
  heartbeatTimer.unref();
}

function startStaleReap(): void {
  staleReapTimer = setInterval(() => {
    void reapStaleWorkers();
  }, CONFIG.staleReapIntervalMs);
  staleReapTimer.unref();
}

/**
 * Queue-depth metrics scheduler. Shares the stale-reap cadence so we
 * don't add a third independent timer — once per `staleReapIntervalMs`
 * is sufficient for dashboard/alert correlation.
 */
let queueDepthTimer: NodeJS.Timeout | null = null;
function startQueueDepthMetrics(): void {
  queueDepthTimer = setInterval(() => {
    void logQueueDepth();
  }, CONFIG.staleReapIntervalMs);
  queueDepthTimer.unref();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_initiated', { signal, in_flight: inFlight.size });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (staleReapTimer) clearInterval(staleReapTimer);
  if (queueDepthTimer) clearInterval(queueDepthTimer);

  // Wait for in-flight feeds to finish (bounded by shutdownGraceMs). Each
  // in-flight feed releases its own lease in its finally block, so we just
  // need to give them a chance to complete.
  const deadline = Date.now() + CONFIG.shutdownGraceMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await sleep(500);
  }

  if (inFlight.size > 0) {
    log('warn', 'shutdown_grace_expired_with_inflight', {
      in_flight: inFlight.size,
      feeds: Array.from(inFlight),
    });
    // Leases will be reclaimed automatically: lease_due_feeds() skips any
    // feed whose ingestion_jobs.leased_until is still in the future, and
    // the lease window expires after CONFIG.leaseSeconds.
  }

  await markHeartbeatStopped();
  log('info', 'shutdown_complete', { exit_code: exitCode });
  process.exit(exitCode);
}

function registerSignalHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
  process.on('uncaughtException', (err) => {
    log('error', 'uncaught_exception', { error: err?.message, stack: err?.stack });
    exitCode = 1;
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled_rejection', {
      error: (reason as Error)?.message ?? String(reason),
    });
  });
}

async function main(): Promise<void> {
  log('info', 'worker_starting', {
    config: {
      worker_id: CONFIG.workerId,
      worker_type: CONFIG.workerType,
      batch_size: CONFIG.batchSize,
      lease_seconds: CONFIG.leaseSeconds,
      per_feed_concurrency: CONFIG.perFeedConcurrency,
    },
  });

  registerSignalHandlers();

  // Activation gate: refuse to start unless the cutover flag is on. This keeps
  // PR 1 strictly additive — the legacy worker.js setInterval loop continues
  // to be the sole ingestion path until an operator enables the flag.
  const enabled = await isFeatureEnabled(CONFIG.featureFlag);
  if (!enabled) {
    log('info', 'feature_flag_disabled_exit', {
      flag: CONFIG.featureFlag,
      hint: 'Enable feature_flags.queue_based_ingestion to activate this worker.',
    });
    process.exit(0);
  }

  await sendHeartbeat({ event: 'startup' });
  // Verify the heartbeat row actually landed before entering the claim
  // loop — this turns "starts but no rows in worker_heartbeats" from a
  // silent failure into a loud, structured `heartbeat_register_failed`
  // log line. We do NOT abort startup on failure: an operator may want
  // the worker to keep trying, and subsequent `sendHeartbeat()` ticks
  // will surface the same issue again.
  await verifyHeartbeatRegistered();
  // Schema-drift defense: probe `rss_feed_sources` column set ONCE before
  // entering the claim loop so adaptive scheduling can safely no-op on
  // environments where migration 040 (or follow-ups) has not landed yet.
  // Probe failures are logged but never abort startup — the worker degrades
  // to legacy behavior driven purely by `record_feed_ingestion_outcome`.
  feedSourceColumns = await probeFeedSourceColumns();
  startHeartbeat();
  startStaleReap();
  // Auto-bootstrap the default feed catalogue if rss_feed_sources
  // is empty (migration 056). Without this a fresh deployment with
  // a healthy worker would silently idle forever on `lease_due_feeds_idle`.
  await bootstrapDefaultFeedsIfEmpty();
  startQueueDepthMetrics();
  // Emit one queue-depth snapshot at startup so the very first log
  // stream contains a baseline reading for dashboards.
  await logQueueDepth();

  try {
    await claimLoop();
  } catch (err) {
    log('error', 'claim_loop_fatal', {
      error: (err as Error)?.message ?? String(err),
    });
    exitCode = 1;
  }

  await shutdown('claim_loop_exit');
}

if (require.main === module) {
  main().catch((err) => {
    log('error', 'fatal', { error: (err as Error)?.message ?? String(err) });
    process.exit(1);
  });
}

export { CONFIG };
