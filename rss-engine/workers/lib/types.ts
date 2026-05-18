/**
 * Phase B queue-runner — shared types.
 *
 * Centralised so that the runner, processors, backpressure controller and
 * observability hooks all speak the same vocabulary. Keep this file free of
 * runtime imports — it is only types.
 */

export type QueueName = 'ingestion' | 'ranking' | 'notification' | 'analytics';

export const QUEUE_NAMES: readonly QueueName[] = [
  'ingestion',
  'ranking',
  'notification',
  'analytics',
] as const;

/**
 * One row returned by the `lease_jobs` Postgres RPC. The runner never mutates
 * rows directly — `lease_token` is the only credential the worker has to
 * complete/fail a job atomically.
 */
export interface LeasedJob {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  lease_token: string;
  leased_until: string;
}

/**
 * Result returned by a processor. The runner uses this to decide whether to
 * call `complete_job` (success) or `fail_job` (failure → backoff or DLQ).
 *
 * `skipped` lets a processor short-circuit a feature-flagged-off job as a
 * non-failure: the job is marked complete and removed from the queue without
 * doing any work or triggering retry.
 */
export type ProcessorResult =
  | { status: 'success'; detail?: Record<string, unknown> }
  | { status: 'skipped'; reason: string; detail?: Record<string, unknown> }
  | { status: 'failed'; error: string; detail?: Record<string, unknown> };

export type Processor = (job: LeasedJob) => Promise<ProcessorResult>;

/**
 * Runtime configuration for a single queue. Defaults are tuned for the safety
 * profile required by Phase B (small ingestion fan-out, larger ranking
 * throughput, notifications staged OFF).
 */
export interface QueueConfig {
  name: QueueName;
  /** Hard concurrency cap before backpressure adjustments. */
  baseConcurrency: number;
  /** Largest batch claimed per polling cycle. */
  baseBatchSize: number;
  /** Lease length granted by `lease_jobs`. */
  leaseSeconds: number;
  /** Polling interval when idle (no jobs returned). */
  idlePollMs: number;
  /** Polling interval when actively draining the queue. */
  activePollMs: number;
  /** Queue depth above which backpressure engages. */
  backpressureThreshold: number;
  /**
   * When true the runner skips polling entirely (used for the
   * staged-OFF queues so even leasing is bypassed in production).
   */
  enabled: boolean;
}

/**
 * Per-cycle metrics record, emitted as a structured log line by the
 * observability hook. The schema is the contract required by the Phase B
 * problem statement and MUST stay stable.
 */
export interface CycleMetrics {
  queue_name: QueueName;
  jobs_processed: number;
  jobs_failed: number;
  avg_latency_ms: number;
  backpressure: boolean;
  concurrency: number;
}

/**
 * Minimal Supabase-shaped client surface used by the queue runner. We model
 * only the methods we actually call so the runner can be unit-tested with a
 * lightweight in-memory fake (see `workers/tests/fakeSupabase.ts`) without
 * pulling the real `@supabase/supabase-js` types into the test harness.
 */
export interface RpcResponse<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface QueryBuilder<T> {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in?(column: string, values: unknown[]): QueryBuilder<T>;
  maybeSingle(): Promise<RpcResponse<T>>;
}

export interface SupabaseLike {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<RpcResponse<T>>;
  from<T = unknown>(table: string): QueryBuilder<T>;
}
