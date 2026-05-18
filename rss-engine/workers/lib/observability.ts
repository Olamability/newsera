/**
 * Phase B — Observability hooks.
 *
 * The Phase B problem statement nails down the exact metrics shape the
 * runner must emit every cycle:
 *
 *   { queue_name, jobs_processed, jobs_failed, avg_latency_ms,
 *     backpressure, concurrency }
 *
 * We expose this via two pieces:
 *
 *   - `startCycleMetrics()` returns a small accumulator the runner mutates
 *     while jobs execute. It tracks latency, success/failure counts, and the
 *     concurrency it actually ran with.
 *
 *   - `emitCycleMetrics()` flushes the accumulator as a structured log line
 *     and (optionally) hands it off to a sink callback so the host process
 *     can forward to its real metrics pipeline if one exists. Sink errors
 *     never crash the runner.
 */

import type { LogFn } from './logger';
import type { CycleMetrics, QueueName, SupabaseLike } from './types';

export type MetricsSink = (metrics: CycleMetrics) => void | Promise<void>;

/**
 * Phase C — non-blocking analytics-queue sink.
 *
 * Closes the Phase B "observability sink is local-only" debt by giving the
 * runner an optional path to forward each cycle's metrics into the
 * `analytics` queue. The job is enqueued via the existing `enqueue_job` RPC
 * — no schema additions, no new infra — and consumed downstream by whatever
 * analytics processor / admin dashboard takes over the rollup.
 *
 * Rules baked in here:
 *   - FIRE-AND-FORGET. The runner never awaits the enqueue (we return
 *     immediately after kicking it off) and any RPC failure is downgraded
 *     to a debug log. Metrics emission must never wedge the data path.
 *   - DEDUP. Each metric job carries a coarse-time dedup key so a chatty
 *     runner cannot flood the analytics queue with thousands of identical
 *     rows when the queue is hot.
 *   - FLAG-GATED at the caller. The runner only installs this sink when
 *     `emit_metrics_to_queue` is requested explicitly; default deployments
 *     remain log-only.
 */
export function createAnalyticsQueueMetricsSink(
  supabase: SupabaseLike,
  log: LogFn,
  opts: { dedupBucketMs?: number } = {},
): MetricsSink {
  const bucketMs = Math.max(opts.dedupBucketMs ?? 60_000, 1_000);
  return function emitMetricsToAnalyticsQueue(metrics: CycleMetrics): void {
    // Don't await — caller already invokes us asynchronously, but we make
    // the promise chain explicit so unhandled rejections don't escape.
    const bucket = Math.floor(Date.now() / bucketMs);
    const dedup = `cycle_metrics:${metrics.queue_name}:${bucket}`;
    void (async () => {
      try {
        const { error } = await supabase.rpc('enqueue_job', {
          p_queue_name: 'analytics',
          p_job_type: 'cycle_metrics_rollup',
          p_payload: {
            source: 'queue_runner',
            metrics,
            emitted_at: new Date().toISOString(),
          },
          p_dedup_key: dedup,
          p_priority: 1,
          p_max_attempts: 3,
        });
        if (error) {
          log('debug', 'metrics_sink_enqueue_failed', {
            queue_name: metrics.queue_name,
            error: error.message,
          });
        }
      } catch (err) {
        log('debug', 'metrics_sink_enqueue_threw', {
          queue_name: metrics.queue_name,
          error: (err as Error)?.message ?? String(err),
        });
      }
    })();
  };
}

export interface CycleAccumulator {
  readonly queue_name: QueueName;
  recordSuccess(latencyMs: number): void;
  recordFailure(latencyMs: number): void;
  recordSkipped(latencyMs: number): void;
  setConcurrency(value: number): void;
  setBackpressure(active: boolean): void;
  snapshot(): CycleMetrics;
}

export function startCycleMetrics(
  queue: QueueName,
  initialConcurrency: number,
  initialBackpressure: boolean,
): CycleAccumulator {
  let processed = 0;
  let failed = 0;
  let totalLatency = 0;
  let samples = 0;
  let concurrency = initialConcurrency;
  let backpressure = initialBackpressure;

  return {
    queue_name: queue,
    recordSuccess(latencyMs) {
      processed += 1;
      totalLatency += latencyMs;
      samples += 1;
    },
    recordFailure(latencyMs) {
      processed += 1;
      failed += 1;
      totalLatency += latencyMs;
      samples += 1;
    },
    recordSkipped(latencyMs) {
      // Skipped jobs still consumed a lease cycle — count them in latency so
      // dashboards see realistic per-job timing, but do not count them as
      // failures or successes.
      totalLatency += latencyMs;
      samples += 1;
    },
    setConcurrency(value) {
      concurrency = value;
    },
    setBackpressure(active) {
      backpressure = active;
    },
    snapshot() {
      return {
        queue_name: queue,
        jobs_processed: processed,
        jobs_failed: failed,
        avg_latency_ms: samples === 0 ? 0 : Math.round(totalLatency / samples),
        backpressure,
        concurrency,
      };
    },
  };
}

export async function emitCycleMetrics(
  log: LogFn,
  acc: CycleAccumulator,
  sink?: MetricsSink,
): Promise<CycleMetrics> {
  const snap = acc.snapshot();
  // Only emit when we actually did something OR backpressure is engaged —
  // a 4 a.m. idle loop should not flood the log pipeline.
  if (snap.jobs_processed === 0 && !snap.backpressure) {
    return snap;
  }
  log('info', 'queue_cycle_metrics', { ...snap });
  if (sink) {
    try {
      await sink(snap);
    } catch (err) {
      log('warn', 'queue_cycle_metrics_sink_threw', {
        queue_name: snap.queue_name,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
  return snap;
}
