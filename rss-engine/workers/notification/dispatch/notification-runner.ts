/**
 * Phase C — Notification Dispatch Engine (NDE) entry script.
 *
 * Boots a *dedicated* process that owns end-to-end notification dispatch:
 *
 *   notification queue  ──┐
 *                         ├─► fanout (→ notification_events / notifications
 *                         │             / notification_deliveries)
 *                         │
 *                         └─► pushDrain (→ Expo via pushSender)
 *
 * The general-purpose `queue-runner` from Phase B also registers the
 * notification processor — running both simultaneously is safe because both
 * use the same SKIP-LOCKED `lease_jobs` RPC and the same
 * `record_notification_delivery` RPC.
 *
 * Operators have three deployment options:
 *   - Stay on the Phase B `queue-runner` (handles notification jobs inline,
 *     no push delivery) — appropriate when the dispatch flag is off.
 *   - Run BOTH `queue-runner` and `notification-runner` — recommended during
 *     ramp-up so push throughput is decoupled from ingestion throughput.
 *   - Disable the notification queue inside `queue-runner` and run only
 *     `notification-runner` once the dispatch pipeline is stable.
 *
 * Activation gates:
 *   - `queue_based_ingestion`         → required (same as Phase B).
 *   - `backend_notification_dispatch` → checked per job by the processor.
 *                                       OFF → structured skip.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const supabase = require('../../config/supabase');

import { createBackpressureController } from '../../lib/backpressure';
import { warmCategoryBootstrapCache } from '../../lib/categoryBootstrapCache';
import { createLogger } from '../../lib/logger';
import { createCategoryNormalizer } from '../../lib/normalizeCategory';
import { createAnalyticsQueueMetricsSink } from '../../lib/observability';
import { createNotificationProcessor } from '../../lib/processors/notification';
import { createQueueVelocityTracker } from '../../lib/queueVelocity';
import { createQueueRunner, defaultQueueConfigs } from '../../lib/runner';
import type { Processor, QueueName, SupabaseLike } from '../../lib/types';
import { createFanoutEngine } from '../fanout';
import { createPushSender, type PushTransport } from '../push/pushSender';

import { createPushDrainLoop } from './pushDrain';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_ID =
  process.env.NOTIFICATION_RUNNER_ID ||
  `nde-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_INTERVAL_MS = parsePositiveInt(
  process.env.NOTIFICATION_RUNNER_HEARTBEAT_INTERVAL_MS,
  30_000,
);
const JOB_TIMEOUT_MS = parsePositiveInt(
  process.env.NOTIFICATION_RUNNER_JOB_TIMEOUT_MS,
  2 * 60_000,
);
const SHUTDOWN_GRACE_MS = parsePositiveInt(
  process.env.NOTIFICATION_RUNNER_SHUTDOWN_GRACE_MS,
  30_000,
);
const PUSH_BATCH_SIZE = parsePositiveInt(
  process.env.NOTIFICATION_RUNNER_PUSH_BATCH_SIZE,
  100,
);
const EXPO_API_URL =
  process.env.EXPO_PUSH_API_URL || 'https://exp.host/--/api/v2/push/send';
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN || '';
const EMIT_METRICS_TO_QUEUE =
  (process.env.NOTIFICATION_RUNNER_EMIT_METRICS_TO_QUEUE || '').toLowerCase() ===
  'true';

const FLAG_NAME = 'queue_based_ingestion';

const log = createLogger({ service: 'notification-runner', worker_id: WORKER_ID });
const supabaseClient = supabase as SupabaseLike;

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
      p_worker_type: 'notification_runner',
      p_hostname: hostname(),
      p_pid: process.pid,
      p_metadata: { version: 'v1', role: 'notification_dispatch_engine' },
    });
    if (error) {
      log('warn', 'heartbeat_failed', { error: error.message });
    }
  } catch (err) {
    log('warn', 'heartbeat_threw', { error: (err as Error)?.message ?? String(err) });
  }
}

/**
 * Default Expo transport. Uses fetch (Node 20+ has it built-in). The runner
 * works perfectly well with a fake transport for testing — production wiring
 * just needs `EXPO_ACCESS_TOKEN` set in env.
 */
function createExpoTransport(): PushTransport {
  return async function expoTransport(batch) {
    if (batch.length === 0) return [];
    const messages = batch.map((m) => ({
      to: m.to,
      title: m.title,
      body: m.body,
      data: m.data ?? {},
      sound: m.sound ?? 'default',
      priority: m.priority ?? 'default',
    }));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    };
    if (EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
    }
    const response = await fetch(EXPO_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`expo_http_${response.status}: ${text.slice(0, 200)}`);
    }
    const json = (await response.json().catch(() => ({}))) as {
      data?: Array<{
        status?: string;
        id?: string;
        message?: string;
        details?: { error?: string };
      }>;
    };
    const tickets = Array.isArray(json.data) ? json.data : [];
    return batch.map((m, i) => {
      const t = tickets[i] ?? {};
      if (t.status === 'ok') {
        return {
          deliveryId: m.deliveryId,
          status: 'ok' as const,
          provider: 'expo',
          providerMessageId: t.id,
        };
      }
      return {
        deliveryId: m.deliveryId,
        status: 'error' as const,
        provider: 'expo',
        errorCode: t.details?.error ?? 'ExpoError',
        errorMessage: t.message ?? 'unknown_expo_error',
      };
    });
  };
}

async function main(): Promise<void> {
  const enabled = await isFeatureEnabled(FLAG_NAME);
  if (!enabled) {
    log('info', 'notification_runner_disabled_by_flag', { flag: FLAG_NAME });
    process.exit(0);
  }

  const configs = defaultQueueConfigs();
  // The NDE only owns the notification queue. Disable the others so the
  // process never accidentally drains ingestion / ranking.
  for (const [name, cfg] of configs) {
    if (name !== 'notification') cfg.enabled = false;
    else cfg.enabled = true;
  }

  const normalizer = createCategoryNormalizer(supabaseClient, log);
  await warmCategoryBootstrapCache(supabaseClient, normalizer, log, { topN: 50 });

  const velocity = createQueueVelocityTracker({ windowMs: 5 * 60_000 });
  const backpressure = createBackpressureController(supabaseClient, configs, log, {
    velocity,
    predictiveGrowthPerMin: 100,
    predictiveMinSamples: 3,
  });

  const fanout = createFanoutEngine({ supabase: supabaseClient, log, normalizer });

  const processors = new Map<QueueName, Processor>();
  processors.set(
    'notification',
    createNotificationProcessor({
      supabase: supabaseClient,
      log,
      normalizer,
      isDispatchEnabled: () => isFeatureEnabled('backend_notification_dispatch'),
      fanout,
    }),
  );

  const metricsSink = EMIT_METRICS_TO_QUEUE
    ? createAnalyticsQueueMetricsSink(supabaseClient, log)
    : undefined;

  const runner = createQueueRunner({
    workerId: WORKER_ID,
    supabase: supabaseClient,
    log,
    processors,
    configs,
    backpressure,
    jobTimeoutMs: JOB_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    metricsSink,
  });

  // Push delivery loop runs in parallel with the queue loop.
  const transport = createExpoTransport();
  const pushSender = createPushSender(transport, log, { maxBatchSize: PUSH_BATCH_SIZE });
  const pushDrain = createPushDrainLoop(
    { supabase: supabaseClient, log, pushSender, workerId: WORKER_ID },
    { batchSize: PUSH_BATCH_SIZE },
  );

  // Worker heartbeat so the ops dashboard from migration 047 can see this
  // process is alive.
  const heartbeatTimer = setInterval(() => {
    void sendWorkerHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  await sendWorkerHeartbeat();

  let shuttingDown = false;
  function stopSignal(): boolean {
    return shuttingDown;
  }
  function sleep(ms: number): Promise<void> {
    return delay(ms);
  }

  runner.start();
  const pushLoop = pushDrain.start(sleep, stopSignal);

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'notification_runner_signal_received', { signal });
    clearInterval(heartbeatTimer);

    const drainTimer = setTimeout(() => {
      log('warn', 'notification_runner_shutdown_grace_exceeded', {
        grace_ms: SHUTDOWN_GRACE_MS,
      });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    drainTimer.unref?.();

    try {
      await Promise.allSettled([runner.stop(), pushLoop]);
    } finally {
      clearTimeout(drainTimer);
      process.exit(0);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log('error', 'notification_runner_fatal', {
    error: (err as Error)?.message ?? String(err),
    stack: (err as Error)?.stack,
  });
  process.exit(1);
});
