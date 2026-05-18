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

async function sendHeartbeat(metadata: Record<string, unknown> = {}): Promise<void> {
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
    }
  } catch (err) {
    log('warn', 'heartbeat_threw', { error: (err as Error)?.message ?? String(err) });
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
  return (data as LeasedFeed[]) || [];
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
 * Look up category_id for a leased feed's underlying source. rss_feed_sources
 * tracks `category` as free text; articles need `category_id` from `sources`.
 * Best-effort: if the lookup fails we still ingest with null category_id
 * (same behaviour as if the source row has no category configured).
 */
async function resolveCategoryId(sourceId: string | null): Promise<string | null> {
  if (!sourceId) return null;
  try {
    const { data, error } = await supabase
      .from('sources')
      .select('category_id')
      .eq('id', sourceId)
      .maybeSingle();
    if (error) {
      log('debug', 'resolve_category_failed', { source_id: sourceId, error: error.message });
      return null;
    }
    return (data?.category_id as string | null) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-feed ingestion pipeline
// ---------------------------------------------------------------------------

async function processLeasedFeed(feed: LeasedFeed): Promise<void> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  inFlight.add(feed.feed_id);

  const baseLog = {
    trace_id: traceId,
    feed_id: feed.feed_id,
    feed_name: feed.name,
    lease_token: feed.lease_token,
  };

  log('info', 'feed_lease_claimed', baseLog);

  const metrics: FeedMetrics = { fetched: 0, inserted: 0, duplicates: 0, durationMs: 0 };
  let success = false;
  let errorMessage: string | null = null;

  try {
    const categoryId = await resolveCategoryId(feed.source_id);

    // Shape an object compatible with the existing fetchRSS / saveArticles
    // primitives, which expect { id, name, rss_url, category_id }.
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
        const saved = await saveArticles(fresh);
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

    log(success ? 'info' : 'warn', 'feed_lease_released', {
      ...baseLog,
      success,
      fetched: metrics.fetched,
      inserted: metrics.inserted,
      duplicates: metrics.duplicates,
      duration_ms: metrics.durationMs,
      error: errorMessage,
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

    log('info', 'feeds_leased', { count: feeds.length });

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

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_initiated', { signal, in_flight: inFlight.size });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (staleReapTimer) clearInterval(staleReapTimer);

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
  startHeartbeat();
  startStaleReap();

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
