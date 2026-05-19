/**
 * Phase B — Queue runner entry script.
 *
 * Boots the central job execution engine on top of the Phase 039–047 job
 * orchestration foundation and the Phase A ingestion worker. This process
 * complements `rss-worker.ts` — it does NOT replace it:
 *
 *   rss-worker.ts → leases due *feeds*, ingests, enqueues downstream jobs
 *   queue-runner  → leases & executes those downstream jobs from job_queue
 *
 * Activation:
 *   - Gated end-to-end by the `queue_based_ingestion` feature flag.
 *   - Per-queue activation is hard-coded in `defaultQueueConfigs()`:
 *       ingestion=ON, ranking=ON, notification=OFF, analytics=OFF.
 *   - The notification processor additionally re-checks the
 *     `backend_notification_dispatch` flag on every job so flag flips are
 *     observed without a restart.
 *
 * Phase A debts addressed here (per problem statement, NOT optional):
 *   1. Schema dependency → category normalization layer is invoked from every
 *      processor that has a `category_id` in its payload, removing the last
 *      `null`-tolerant path.
 *   2. Scaling risk → per-queue concurrency caps, batch-size caps, and a
 *      backpressure controller that throttles when `job_queue` depth spikes.
 *
 * Strict rules (re-stated for the reader):
 *   - NO schema changes (we only call the existing RPCs)
 *   - NO direct DB writes from processors (every mutation goes via an RPC)
 *   - NO new infra (no Redis, no Kafka — Postgres SKIP LOCKED is the bus)
 *   - The legacy `rss-worker.ts` is untouched
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const supabase = require('../config/supabase');

import { createBackpressureController } from './lib/backpressure';
import { warmCategoryBootstrapCache } from './lib/categoryBootstrapCache';
import { createLogger } from './lib/logger';
import { createCategoryNormalizer } from './lib/normalizeCategory';
import { createAnalyticsQueueMetricsSink } from './lib/observability';
import { createAnalyticsProcessor } from './lib/processors/analytics';
import { createIngestionProcessor } from './lib/processors/ingestion';
import { createNotificationProcessor } from './lib/processors/notification';
import { createRankingProcessor } from './lib/processors/ranking';
import { createQueueVelocityTracker } from './lib/queueVelocity';
import { createQueueRunner, defaultQueueConfigs } from './lib/runner';
import type { Processor, QueueName, SupabaseLike } from './lib/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_ID =
  process.env.QUEUE_RUNNER_ID ||
  `queue-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_INTERVAL_MS = parsePositiveInt(
  process.env.QUEUE_RUNNER_HEARTBEAT_INTERVAL_MS,
  30_000,
);
const JOB_TIMEOUT_MS = parsePositiveInt(process.env.QUEUE_RUNNER_JOB_TIMEOUT_MS, 5 * 60_000);
const SHUTDOWN_GRACE_MS = parsePositiveInt(process.env.QUEUE_RUNNER_SHUTDOWN_GRACE_MS, 30_000);
const VELOCITY_WINDOW_MS = parsePositiveInt(
  process.env.QUEUE_RUNNER_VELOCITY_WINDOW_MS,
  5 * 60_000,
);
const PREDICTIVE_GROWTH_PER_MIN = parsePositiveInt(
  process.env.QUEUE_RUNNER_PREDICTIVE_GROWTH_PER_MIN,
  50,
);
const EMIT_METRICS_TO_QUEUE =
  (process.env.QUEUE_RUNNER_EMIT_METRICS_TO_QUEUE || '').toLowerCase() === 'true';
const FLAG_NAME = 'queue_based_ingestion';

const log = createLogger({ service: 'queue-runner', worker_id: WORKER_ID });

// The supabase JS client surface conforms to our minimal `SupabaseLike` type.
const supabaseClient = supabase as SupabaseLike;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isFeatureEnabled(name: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseClient.rpc<boolean>('is_feature_enabled', {
      p_name: name,
    });
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

async function sendWorkerHeartbeat(): Promise<void> {
  try {
    const { error } = await supabaseClient.rpc('worker_heartbeat', {
      p_worker_id: WORKER_ID,
      p_worker_type: 'queue_runner',
      p_hostname: hostname(),
      p_pid: process.pid,
      p_metadata: { version: 'v1', role: 'queue_runner' },
    });
    if (error) {
      log('warn', 'heartbeat_failed', { error: error.message });
    }
  } catch (err) {
    log('warn', 'heartbeat_threw', { error: (err as Error)?.message ?? String(err) });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const enabled = await isFeatureEnabled(FLAG_NAME);
  if (!enabled) {
    log('info', 'queue_runner_disabled_by_flag', { flag: FLAG_NAME });
    process.exit(0);
  }

  const configs = defaultQueueConfigs();
  const normalizer = createCategoryNormalizer(supabaseClient, log);

  // Phase C — warm the category cache before the runner starts polling so
  // the first burst after a rolling restart does not hammer `categories`.
  await warmCategoryBootstrapCache(supabaseClient, normalizer, log, { topN: 50 });

  const velocity = createQueueVelocityTracker({ windowMs: VELOCITY_WINDOW_MS });
  const backpressure = createBackpressureController(supabaseClient, configs, log, {
    velocity,
    predictiveGrowthPerMin: PREDICTIVE_GROWTH_PER_MIN,
    predictiveMinSamples: 3,
  });

  const processors = new Map<QueueName, Processor>();
  processors.set(
    'ingestion',
    createIngestionProcessor({ supabase: supabaseClient, log, normalizer }),
  );
  processors.set(
    'ranking',
    createRankingProcessor({
      supabase: supabaseClient,
      log,
      normalizer,
      isPersonalizationEnabled: () => isFeatureEnabled('personalization_v1'),
      isRankingEnabled: () => isFeatureEnabled('ranking_v1'),
    }),
  );
  processors.set(
    'notification',
    createNotificationProcessor({
      supabase: supabaseClient,
      log,
      normalizer,
      isDispatchEnabled: () => isFeatureEnabled('backend_notification_dispatch'),
    }),
  );
  processors.set('analytics', createAnalyticsProcessor({ log, supabase: supabaseClient }));

  const runner = createQueueRunner({
    workerId: WORKER_ID,
    supabase: supabaseClient,
    log,
    processors,
    configs,
    backpressure,
    jobTimeoutMs: JOB_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    velocity,
    metricsSink: EMIT_METRICS_TO_QUEUE
      ? createAnalyticsQueueMetricsSink(supabaseClient, log)
      : undefined,
  });

  // Worker-level heartbeat (separate from per-job lease heartbeats) so the
  // ops dashboard from migration 047 can see this process is alive.
  const heartbeatTimer = setInterval(() => {
    void sendWorkerHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  await sendWorkerHeartbeat();

  runner.start();

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'queue_runner_signal_received', { signal });
    clearInterval(heartbeatTimer);

    // Hard cap on drain time so a stuck processor cannot wedge the process
    // forever — k8s/SystemD will SIGKILL us anyway after its own grace.
    const drainTimer = setTimeout(() => {
      log('warn', 'queue_runner_shutdown_grace_exceeded', {
        grace_ms: SHUTDOWN_GRACE_MS,
      });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    drainTimer.unref?.();

    try {
      await runner.stop();
    } finally {
      clearTimeout(drainTimer);
      process.exit(0);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log('error', 'queue_runner_fatal', {
    error: (err as Error)?.message ?? String(err),
    stack: (err as Error)?.stack,
  });
  process.exit(1);
});
