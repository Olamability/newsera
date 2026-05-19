/**
 * Phase E — Performance profiler.
 *
 * In-process, allocation-light profiler that records latency observations
 * across the critical paths of the runner and surfaces p50/p95/p99 per
 * named bucket. Buckets the operator wires up by default:
 *
 *   - queue_latency.*          (per queue)
 *   - rpc_latency.*            (per RPC name)
 *   - ranking_compute_duration
 *   - personalization_refresh_time
 *   - fanout_throughput        (durations of one fanout batch)
 *   - db_query.*               (per query alias)
 *
 * The profiler is intentionally NOT an APM client — it does not ship spans
 * to a vendor. The data sits in memory until the host process flushes it
 * (typically into the analytics queue via the existing observability hook).
 *
 * Storage:
 *   - Each bucket holds at most `maxSamplesPerBucket` observations (FIFO
 *     ring buffer, default 1024). When the buffer fills we drop the oldest
 *     sample. This bounds RAM regardless of traffic.
 *   - Snapshots compute exact percentiles from the current buffer
 *     contents — no HDR histograms, no t-digests, because the workload is
 *     small enough that O(n log n) per snapshot is fine for n ≤ 1024.
 *
 * Hard rules:
 *   - PURE COMPUTE. The profiler is not async.
 *   - NO external deps.
 *   - ALWAYS safe to call from a hot path: `record()` is O(1) amortized.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BucketSnapshot {
  bucket: string;
  count: number;
  /** Latest sample value (ms). 0 when no samples. */
  last: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface ProfilerOptions {
  /** Max samples retained per bucket. Default 1024. */
  maxSamplesPerBucket?: number;
  /** Provider for `Date.now()` — used only by `time()`. */
  now?: () => number;
}

export interface PerformanceProfiler {
  /** Record a single observation in `ms` for `bucket`. */
  record(bucket: string, durationMs: number): void;
  /** Convenience helper: returns a stop() function that records elapsed. */
  time(bucket: string): () => number;
  /** Wrap an async function so its duration is automatically recorded. */
  timeAsync<T>(bucket: string, fn: () => Promise<T>): Promise<T>;
  /** Wrap a sync function. */
  timeSync<T>(bucket: string, fn: () => T): T;
  /** Snapshot one bucket. Returns null if the bucket has no samples. */
  snapshot(bucket: string): BucketSnapshot | null;
  /** Snapshot all buckets. */
  snapshotAll(): BucketSnapshot[];
  /** Clear all samples. */
  reset(): void;
  /** Bucket names with at least one sample. */
  buckets(): string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX = 1024;

interface Bucket {
  buf: number[];
  /** Write position in the ring. */
  cursor: number;
  count: number;
  totalSeen: number;
  sumAll: number;
}

function newBucket(cap: number): Bucket {
  return { buf: new Array(cap), cursor: 0, count: 0, totalSeen: 0, sumAll: 0 };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function createPerformanceProfiler(opts: ProfilerOptions = {}): PerformanceProfiler {
  const cap = Math.max(opts.maxSamplesPerBucket ?? DEFAULT_MAX, 16);
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  function getBucket(name: string): Bucket {
    let b = buckets.get(name);
    if (!b) {
      b = newBucket(cap);
      buckets.set(name, b);
    }
    return b;
  }

  function record(name: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const b = getBucket(name);
    b.buf[b.cursor] = durationMs;
    b.cursor = (b.cursor + 1) % cap;
    if (b.count < cap) b.count += 1;
    b.totalSeen += 1;
    b.sumAll += durationMs;
  }

  function time(name: string): () => number {
    const start = now();
    return () => {
      const elapsed = now() - start;
      record(name, elapsed);
      return elapsed;
    };
  }

  async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const stop = time(name);
    try {
      return await fn();
    } finally {
      stop();
    }
  }

  function timeSync<T>(name: string, fn: () => T): T {
    const stop = time(name);
    try {
      return fn();
    } finally {
      stop();
    }
  }

  function snapshot(name: string): BucketSnapshot | null {
    const b = buckets.get(name);
    if (!b || b.count === 0) return null;
    // Pull contents into a fresh array of length `count` then sort.
    const samples: number[] = new Array(b.count);
    if (b.count < cap) {
      for (let i = 0; i < b.count; i += 1) samples[i] = b.buf[i];
    } else {
      // Ring full — read from cursor as the oldest.
      for (let i = 0; i < cap; i += 1) {
        samples[i] = b.buf[(b.cursor + i) % cap];
      }
    }
    let min = samples[0];
    let max = samples[0];
    let sum = 0;
    for (const v of samples) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const last = samples[samples.length - 1];
    samples.sort((a, b) => a - b);
    return {
      bucket: name,
      count: b.count,
      last,
      min,
      max,
      mean: sum / samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    };
  }

  function snapshotAll(): BucketSnapshot[] {
    const out: BucketSnapshot[] = [];
    for (const name of buckets.keys()) {
      const snap = snapshot(name);
      if (snap) out.push(snap);
    }
    out.sort((a, b) => a.bucket.localeCompare(b.bucket));
    return out;
  }

  function reset(): void {
    buckets.clear();
  }

  function bucketNames(): string[] {
    return [...buckets.keys()];
  }

  return {
    record,
    time,
    timeAsync,
    timeSync,
    snapshot,
    snapshotAll,
    reset,
    buckets: bucketNames,
  };
}
