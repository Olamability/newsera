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

async function processLeasedFeed(feed: LeasedFeed): Promise<void> {
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

    const feeds = await leaseDueFeeds();

    if (feeds.length === 0) {
      await sleep(CONFIG.idlePollIntervalMs);
      continue;
    }

    // Process the leased batch with bounded concurrency; await the whole batch
    // before claiming again so we never exceed perFeedConcurrency * batchSize
    // open ingestions and never leak leases on shutdown.
    await Promise.all(
      feeds.map((feed) =>
        limit(() =>
          processLeasedFeed(feed).catch((err) => {
            log('error', 'process_leased_feed_unhandled', {
              feed_id: feed.feed_id,
              error: (err as Error)?.message ?? String(err),
            });
          }),
        ),
      ),
    );

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
