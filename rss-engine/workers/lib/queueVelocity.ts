/**
 * Phase C — Queue velocity tracker (closes Phase B reactive-backpressure debt).
 *
 * Phase B made backpressure *reactive*: we sampled queue depth at the start of
 * every cycle and reacted to it. That works once the queue is already deep,
 * but cannot anticipate spikes — by the time depth crosses the threshold the
 * runner has already wasted one round-trip leasing too many jobs.
 *
 * Phase C adds a velocity layer:
 *
 *   ingestion_rate   = jobs enqueued per minute  (how fast work arrives)
 *   processing_rate  = jobs completed per minute (how fast work drains)
 *   growth_delta     = ingestion_rate − processing_rate (signed; positive = backlog growing)
 *
 * All three are exposed as EMA-smoothed values over a 5–10 minute window, so
 * a single bursty cycle does not push the controller into drain mode and a
 * single quiet cycle does not pull it out. The controller (see
 * `backpressure.ts`) consults `growth_delta` to engage *before* depth
 * actually crosses the configured threshold — this is the "predictive
 * throttle" required by Phase C.
 *
 * Design constraints:
 *   - No new infrastructure. Everything is in-process and bounded by
 *     `Math.max(samples_per_window, 1)`.
 *   - No DB writes. Velocity is fed by the runner from its own bookkeeping
 *     (lease batch sizes + per-cycle completion counts).
 *   - Safe to read from multiple callers — `snapshot()` is pure.
 *   - Resilient to a stopped clock: when no events have been recorded in a
 *     window, rates report 0 (rather than NaN or Infinity).
 *
 * Tuning rationale:
 *   - 5–10 min window mirrors the problem statement and matches the worst-
 *     case duration of a ranking refresh job (which can dominate a single
 *     bucket).
 *   - EMA alpha is derived from the window so an operator only has to think
 *     in minutes, not decay constants.
 */

import type { QueueName } from './types';

export interface QueueVelocitySnapshot {
  /** Jobs enqueued per minute, EMA-smoothed. */
  ingestionRatePerMin: number;
  /** Jobs completed per minute, EMA-smoothed. */
  processingRatePerMin: number;
  /** ingestion − processing. Positive = backlog growing. */
  growthDeltaPerMin: number;
  /** Number of raw cycles folded into the EMA so far. */
  samples: number;
  /** ms since this queue last produced an observation. */
  staleMs: number;
}

export interface QueueVelocityOptions {
  /**
   * Window over which the EMA "remembers" past samples. 5–10 min per the
   * Phase C problem statement. Bounded to [60_000, 60 * 60_000].
   */
  windowMs?: number;
  /**
   * Wall-clock for testing. Defaults to `Date.now`. The tracker only ever
   * reads time via this function so simulations can advance time without
   * waiting.
   */
  now?: () => number;
}

export interface QueueVelocityTracker {
  /**
   * Record one polling cycle's totals for a queue. Both arguments are raw
   * counts (NOT rates); the tracker converts to per-minute internally using
   * the elapsed time since the last observation.
   */
  observe(
    queue: QueueName,
    counts: { enqueued: number; processed: number },
  ): void;
  /** Cheap read; safe to call every cycle. */
  snapshot(queue: QueueName): QueueVelocitySnapshot;
  /** Test/diag hook — clears all in-memory state. */
  reset(): void;
}

interface InternalState {
  ingestionRatePerMin: number;
  processingRatePerMin: number;
  lastObservedAt: number;
  samples: number;
}

function emptyState(now: number): InternalState {
  return {
    ingestionRatePerMin: 0,
    processingRatePerMin: 0,
    lastObservedAt: now,
    samples: 0,
  };
}

/**
 * Convert a window length in ms to an EMA alpha that gives roughly the same
 * "memory" as a simple moving average over that window. Derivation: an EMA
 * with alpha `a` reaches ~63% of a step input after `1/a` samples; we want
 * that horizon to equal `windowMs / sampleSpacing`. We pick a conservative
 * sampleSpacing baseline of 1 minute since that is the unit our rates are
 * already normalised to.
 */
function alphaForWindow(windowMs: number): number {
  const windowMinutes = Math.max(windowMs / 60_000, 1);
  return Math.min(Math.max(1 / windowMinutes, 0.05), 0.5);
}

export function createQueueVelocityTracker(
  opts: QueueVelocityOptions = {},
): QueueVelocityTracker {
  const windowMs = Math.min(
    Math.max(opts.windowMs ?? 5 * 60_000, 60_000),
    60 * 60_000,
  );
  const now = opts.now ?? Date.now;
  const alpha = alphaForWindow(windowMs);
  const states = new Map<QueueName, InternalState>();
  // Capture tracker creation time so the very first observation on each
  // queue measures elapsed-since-creation rather than elapsed-since-its-own-
  // initialization (which would always be 0 and produce infinite rates).
  const createdAt = now();

  function ensure(queue: QueueName): InternalState {
    let s = states.get(queue);
    if (!s) {
      s = emptyState(createdAt);
      states.set(queue, s);
    }
    return s;
  }

  return {
    observe(queue, counts) {
      const enq = Math.max(0, counts.enqueued | 0);
      const proc = Math.max(0, counts.processed | 0);
      const s = ensure(queue);
      const t = now();
      // Guard against monotonic-clock anomalies and the first observation:
      // require at least a 1ms gap so we never divide by zero.
      const elapsedMs = Math.max(t - s.lastObservedAt, 1);
      const instantIngestion = (enq * 60_000) / elapsedMs;
      const instantProcessing = (proc * 60_000) / elapsedMs;
      if (s.samples === 0) {
        // Seed the EMA with the first real observation rather than warming
        // up from zero — otherwise the tracker would lag every queue start
        // by ~1 window before reporting realistic numbers.
        s.ingestionRatePerMin = instantIngestion;
        s.processingRatePerMin = instantProcessing;
      } else {
        s.ingestionRatePerMin =
          alpha * instantIngestion + (1 - alpha) * s.ingestionRatePerMin;
        s.processingRatePerMin =
          alpha * instantProcessing + (1 - alpha) * s.processingRatePerMin;
      }
      s.samples += 1;
      s.lastObservedAt = t;
    },
    snapshot(queue) {
      const s = states.get(queue);
      if (!s) {
        return {
          ingestionRatePerMin: 0,
          processingRatePerMin: 0,
          growthDeltaPerMin: 0,
          samples: 0,
          staleMs: 0,
        };
      }
      return {
        ingestionRatePerMin: s.ingestionRatePerMin,
        processingRatePerMin: s.processingRatePerMin,
        growthDeltaPerMin: s.ingestionRatePerMin - s.processingRatePerMin,
        samples: s.samples,
        staleMs: Math.max(now() - s.lastObservedAt, 0),
      };
    },
    reset() {
      states.clear();
    },
  };
}
