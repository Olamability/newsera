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
import type { CycleMetrics, QueueName } from './types';

export type MetricsSink = (metrics: CycleMetrics) => void | Promise<void>;

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
