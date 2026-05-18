/**
 * Phase B — Queue execution engine (factory).
 *
 * The runner is split into:
 *   - `createQueueRunner()` (this file) — pure factory, takes injected deps,
 *     returns a `start()` / `stop()` controller. No `process.env` reads, no
 *     `require()` of the supabase client — easy to unit-test.
 *   - `queue-runner.ts` (the entry script) — wires environment, real
 *     supabase client, signal handlers, then calls `createQueueRunner()`.
 *
 * Loop, per queue, per cycle:
 *
 *   1. `sample` backpressure (cached, cheap)
 *   2. effectiveConcurrency = min(baseConcurrency, backpressure.concurrency)
 *      effectiveBatch       = min(baseBatchSize,   effectiveConcurrency)
 *   3. `lease_jobs(queue, worker_id, effectiveBatch, leaseSeconds)`
 *   4. Process all leased jobs with p-limit(effectiveConcurrency); each
 *      job runs under a `processSingleJob` wrapper that:
 *        - starts a heartbeat extension timer (`heartbeat_job` mid-lease)
 *        - awaits the processor with a hard timeout
 *        - emits the correct terminal RPC (`complete_job` / `fail_job`)
 *        - never throws upward — failures become metric counters
 *   5. Emit cycle metrics; sleep `backpressure.pollIntervalMs` (or
 *      `idlePollMs` when no jobs leased).
 *
 * Cooperative shutdown: `stop()` flips a flag, drains in-flight work, then
 * awaits each per-queue loop promise. SIGINT/SIGTERM handlers are wired in
 * the entry script.
 *
 * Concurrency safety: the runner only ever mutates `job_queue` rows via
 * RPCs which themselves use SKIP LOCKED, so two runners on the same DB will
 * never both grab the same job.
 *
 * Idempotency: processors are required to be idempotent in their effects
 * (`refresh_ranked_feeds` is naturally so; `recategorize_article` is a
 * `SET` not an `UPDATE+1` etc). The runner additionally guarantees:
 *   - a single job_id is leased to one worker at a time (RPC contract)
 *   - retry attempts re-run the *same* job_id, never enqueuing a clone
 *   - `complete_job` / `fail_job` require the lease_token, so a stale
 *     worker waking up after its lease expired cannot poison results
 */

import { setTimeout as delay } from 'node:timers/promises';

import type { LogFn } from './logger';
import type { BackpressureController } from './backpressure';
import type { CycleAccumulator, MetricsSink } from './observability';
import { emitCycleMetrics, startCycleMetrics } from './observability';
import type {
  LeasedJob,
  Processor,
  ProcessorResult,
  QueueConfig,
  QueueName,
  SupabaseLike,
} from './types';

export interface QueueRunnerDeps {
  workerId: string;
  supabase: SupabaseLike;
  log: LogFn;
  /** Map of queue → processor. Missing queues are treated as disabled. */
  processors: ReadonlyMap<QueueName, Processor>;
  configs: ReadonlyMap<QueueName, QueueConfig>;
  backpressure: BackpressureController;
  /** Optional sink for cycle metrics; defaults to log-only. */
  metricsSink?: MetricsSink;
  /** Hard timeout per job; default 5 minutes. */
  jobTimeoutMs?: number;
  /** Heartbeat extension interval mid-job; default 30s. */
  heartbeatIntervalMs?: number;
  /**
   * Sleep primitive — injectable so tests can fast-forward the loop without
   * burning real wall-clock time. Defaults to node:timers/promises#setTimeout.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Backoff parameters threaded straight into `fail_job` RPC. Defaults match
   * the migration's defaults (base=30s, max=1h).
   */
  failBackoffBaseSeconds?: number;
  failBackoffMaxSeconds?: number;
}

export interface QueueRunner {
  start(): void;
  stop(): Promise<void>;
  /** Test/diag — run one cycle of one queue synchronously. */
  runOnce(queue: QueueName): Promise<{
    leased: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }>;
  /** True once `start()` has been called and the loops are running. */
  isRunning(): boolean;
}

interface JobOutcome {
  status: ProcessorResult['status'];
  latencyMs: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch((err: unknown) => {
    if ((err as { name?: string })?.name === 'AbortError') return;
    throw err;
  });
}

/**
 * Promise.race that rejects with a tagged TimeoutError after `ms`.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`processor_timeout_after_${ms}ms`);
      err.name = 'ProcessorTimeoutError';
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Run up to `limit` async tasks at once. Tiny home-grown limiter to avoid
 * adding another runtime dep — `p-limit` is already in deps but this keeps
 * the runner standalone for tests that mock the entire universe.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const effective = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  }
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < effective; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export function createQueueRunner(deps: QueueRunnerDeps): QueueRunner {
  const {
    workerId,
    supabase,
    log,
    processors,
    configs,
    backpressure,
    metricsSink,
    jobTimeoutMs = 5 * 60_000,
    heartbeatIntervalMs = 30_000,
    sleep = defaultSleep,
    failBackoffBaseSeconds = 30,
    failBackoffMaxSeconds = 3600,
  } = deps;

  let running = false;
  let shuttingDown = false;
  const abort = new AbortController();
  const loopPromises: Array<Promise<void>> = [];

  async function leaseBatch(
    queue: QueueName,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<LeasedJob[]> {
    try {
      const { data, error } = await supabase.rpc<LeasedJob[]>('lease_jobs', {
        p_queue_name: queue,
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds,
      });
      if (error) {
        log('warn', 'lease_jobs_failed', { queue_name: queue, error: error.message });
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (err) {
      log('warn', 'lease_jobs_threw', {
        queue_name: queue,
        error: (err as Error)?.message ?? String(err),
      });
      return [];
    }
  }

  async function completeJob(jobId: string, leaseToken: string): Promise<void> {
    try {
      const { error } = await supabase.rpc('complete_job', {
        p_job_id: jobId,
        p_lease_token: leaseToken,
      });
      if (error) {
        log('warn', 'complete_job_failed', { job_id: jobId, error: error.message });
      }
    } catch (err) {
      log('warn', 'complete_job_threw', {
        job_id: jobId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  async function failJob(
    jobId: string,
    leaseToken: string,
    errorMessage: string,
  ): Promise<string | null> {
    try {
      const { data, error } = await supabase.rpc<string>('fail_job', {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_error: errorMessage,
        p_base_backoff_seconds: failBackoffBaseSeconds,
        p_max_backoff_seconds: failBackoffMaxSeconds,
      });
      if (error) {
        log('warn', 'fail_job_failed', { job_id: jobId, error: error.message });
        return null;
      }
      return typeof data === 'string' ? data : null;
    } catch (err) {
      log('warn', 'fail_job_threw', {
        job_id: jobId,
        error: (err as Error)?.message ?? String(err),
      });
      return null;
    }
  }

  async function heartbeatJob(jobId: string, leaseToken: string, extendSeconds: number): Promise<void> {
    try {
      const { error } = await supabase.rpc('heartbeat_job', {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_extend_seconds: extendSeconds,
      });
      if (error) {
        log('debug', 'heartbeat_job_failed', { job_id: jobId, error: error.message });
      }
    } catch (err) {
      log('debug', 'heartbeat_job_threw', {
        job_id: jobId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  async function processSingleJob(
    cfg: QueueConfig,
    processor: Processor,
    job: LeasedJob,
    acc: CycleAccumulator,
  ): Promise<JobOutcome> {
    const startedAt = Date.now();
    const baseLog = {
      queue_name: cfg.name,
      job_id: job.id,
      job_type: job.job_type,
      attempts: job.attempts,
    };

    // Periodic heartbeat extension so long-running jobs do not lose their
    // lease half-way through. Stops as soon as the processor settles.
    let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
      void heartbeatJob(job.id, job.lease_token, cfg.leaseSeconds);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    function stopHeartbeat(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    let result: ProcessorResult;
    try {
      result = await withTimeout(processor(job), jobTimeoutMs);
    } catch (err) {
      result = {
        status: 'failed',
        error: (err as Error)?.message ?? String(err),
      };
    } finally {
      stopHeartbeat();
    }

    const latencyMs = Date.now() - startedAt;

    if (result.status === 'success') {
      await completeJob(job.id, job.lease_token);
      acc.recordSuccess(latencyMs);
      log('info', 'job_succeeded', {
        ...baseLog,
        latency_ms: latencyMs,
        detail: result.detail,
      });
    } else if (result.status === 'skipped') {
      // Skipped = acknowledged. Treated as `complete` to remove from queue.
      await completeJob(job.id, job.lease_token);
      acc.recordSkipped(latencyMs);
      log('info', 'job_skipped', {
        ...baseLog,
        latency_ms: latencyMs,
        reason: result.reason,
        detail: result.detail,
      });
    } else {
      const disposition = await failJob(job.id, job.lease_token, result.error);
      acc.recordFailure(latencyMs);
      log('warn', 'job_failed', {
        ...baseLog,
        latency_ms: latencyMs,
        disposition, // 'queued' = retry, 'dead' = DLQ
        error: result.error,
        detail: result.detail,
      });
    }

    return { status: result.status, latencyMs };
  }

  async function runQueueCycle(cfg: QueueConfig): Promise<{
    leased: number;
    succeeded: number;
    failed: number;
    skipped: number;
    backpressure: boolean;
    concurrency: number;
    pollIntervalMs: number;
  }> {
    const processor = processors.get(cfg.name);
    if (!processor) {
      return {
        leased: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        backpressure: false,
        concurrency: 0,
        pollIntervalMs: cfg.idlePollMs,
      };
    }

    const bp = await backpressure.sample(cfg.name);
    const effectiveConcurrency = Math.max(
      1,
      Math.min(cfg.baseConcurrency, bp.concurrency),
    );
    const effectiveBatch = Math.max(
      1,
      Math.min(cfg.baseBatchSize, effectiveConcurrency),
    );

    const acc = startCycleMetrics(cfg.name, effectiveConcurrency, bp.active);

    const leased = await leaseBatch(cfg.name, effectiveBatch, cfg.leaseSeconds);
    if (leased.length === 0) {
      // Even when nothing was leased we emit metrics if backpressure is on,
      // so dashboards can plot "queue depth high but worker idle (drain)".
      await emitCycleMetrics(log, acc, metricsSink);
      return {
        leased: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        backpressure: bp.active,
        concurrency: effectiveConcurrency,
        pollIntervalMs: bp.active ? bp.pollIntervalMs : cfg.idlePollMs,
      };
    }

    const outcomes = await runWithConcurrency(
      leased.map((job) => () => processSingleJob(cfg, processor, job, acc)),
      effectiveConcurrency,
    );

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const o of outcomes) {
      if (o.status === 'success') succeeded += 1;
      else if (o.status === 'failed') failed += 1;
      else skipped += 1;
    }

    await emitCycleMetrics(log, acc, metricsSink);

    return {
      leased: leased.length,
      succeeded,
      failed,
      skipped,
      backpressure: bp.active,
      concurrency: effectiveConcurrency,
      pollIntervalMs: bp.active ? bp.pollIntervalMs : cfg.activePollMs,
    };
  }

  async function runQueueLoop(cfg: QueueConfig): Promise<void> {
    log('info', 'queue_loop_started', {
      queue_name: cfg.name,
      base_concurrency: cfg.baseConcurrency,
      base_batch_size: cfg.baseBatchSize,
      enabled: cfg.enabled,
    });

    while (!shuttingDown) {
      if (!cfg.enabled) {
        // Staged-OFF queues just sleep on their idle interval — no leases.
        await sleep(cfg.idlePollMs, abort.signal);
        continue;
      }
      let cycle;
      try {
        cycle = await runQueueCycle(cfg);
      } catch (err) {
        log('error', 'queue_cycle_threw', {
          queue_name: cfg.name,
          error: (err as Error)?.message ?? String(err),
        });
        await sleep(cfg.idlePollMs, abort.signal);
        continue;
      }

      // No work? Idle backoff. Work? Use the active interval (or the larger
      // backpressure-adjusted interval if engaged).
      const nextSleep = cycle.leased === 0 ? cfg.idlePollMs : cycle.pollIntervalMs;
      await sleep(nextSleep, abort.signal);
    }

    log('info', 'queue_loop_stopped', { queue_name: cfg.name });
  }

  return {
    start() {
      if (running) return;
      running = true;
      shuttingDown = false;
      for (const cfg of configs.values()) {
        loopPromises.push(runQueueLoop(cfg));
      }
      log('info', 'queue_runner_started', {
        worker_id: workerId,
        queues: Array.from(configs.keys()),
      });
    },
    async stop() {
      if (!running) return;
      shuttingDown = true;
      abort.abort();
      log('info', 'queue_runner_stopping', { worker_id: workerId });
      await Promise.allSettled(loopPromises);
      loopPromises.length = 0;
      running = false;
      log('info', 'queue_runner_stopped', { worker_id: workerId });
    },
    async runOnce(queue) {
      const cfg = configs.get(queue);
      if (!cfg) throw new Error(`runOnce: unknown queue '${queue}'`);
      const cycle = await runQueueCycle(cfg);
      return {
        leased: cycle.leased,
        succeeded: cycle.succeeded,
        failed: cycle.failed,
        skipped: cycle.skipped,
      };
    },
    isRunning() {
      return running;
    },
  };
}

/**
 * Default per-queue tuning. Matches the Phase B problem statement:
 *   ingestion     → 5 concurrent  (downstream fan-out is small)
 *   ranking       → 10 concurrent (refresh jobs are cheap but bursty)
 *   notification  → 20 concurrent (staged OFF by default)
 *   analytics     → 4 concurrent  (staged OFF; rollups are infrequent)
 */
export function defaultQueueConfigs(): Map<QueueName, QueueConfig> {
  const configs = new Map<QueueName, QueueConfig>();
  configs.set('ingestion', {
    name: 'ingestion',
    baseConcurrency: 5,
    baseBatchSize: 5,
    leaseSeconds: 120,
    idlePollMs: 5_000,
    activePollMs: 500,
    backpressureThreshold: 1_000,
    enabled: true,
  });
  configs.set('ranking', {
    name: 'ranking',
    baseConcurrency: 10,
    baseBatchSize: 10,
    leaseSeconds: 120,
    idlePollMs: 5_000,
    activePollMs: 500,
    backpressureThreshold: 500,
    enabled: true,
  });
  configs.set('notification', {
    name: 'notification',
    baseConcurrency: 20,
    baseBatchSize: 20,
    leaseSeconds: 60,
    idlePollMs: 10_000,
    activePollMs: 1_000,
    backpressureThreshold: 5_000,
    enabled: false, // staged OFF
  });
  configs.set('analytics', {
    name: 'analytics',
    baseConcurrency: 4,
    baseBatchSize: 4,
    leaseSeconds: 300,
    idlePollMs: 30_000,
    activePollMs: 5_000,
    backpressureThreshold: 200,
    enabled: false, // staged OFF
  });
  return configs;
}
