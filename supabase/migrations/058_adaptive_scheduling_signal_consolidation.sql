-- ============================================================================
-- 058_adaptive_scheduling_signal_consolidation.sql
--
-- PURPOSE
--   Consolidate adaptive RSS scheduling so the database is the single source
--   of truth. Workers stop mutating `fetch_interval_seconds` directly; they
--   only emit ingestion signals. The DB then decides whether (and how) to
--   adjust the polling cadence — `lease_due_feeds` remains the only gate
--   that decides what to fetch next.
--
-- WHAT THIS MIGRATION ADDS (additive only)
--   * `apply_feed_ingestion_signal(...)` SECURITY DEFINER RPC: accepts a
--     worker-emitted signal and adjusts ONLY `fetch_interval_seconds` on the
--     two "success" signals. The "failed_fetch" signal is intentionally a
--     no-op for the interval — the existing `record_feed_ingestion_outcome`
--     function is still the single owner of failure backoff via
--     `backoff_seconds`. We must not stack two competing backoff policies.
--   * `rss_feed_ingestion_signals` table: a small, nullable, append-only log
--     of the last N signals per feed. Used by the debug RPC and for offline
--     analysis. Unused by the live ingestion path.
--   * `get_feed_schedule_debug(p_feed_id)` SECURITY DEFINER RPC: returns the
--     last signal received plus the current scheduling state (next_fetch_at,
--     fetch_interval_seconds, backoff_seconds, consecutive_failures) so
--     operators can reason about why a feed is paced the way it is.
--
-- CONSTRAINTS (per problem statement)
--   * ADDITIVE ONLY — no DROP, no RENAME, no CHECK changes that could reject
--     existing rows. Existing columns (`last_status`, `last_run_at`,
--     `leased_by`, `next_fetch_at`, `fetch_interval_seconds`,
--     `backoff_seconds`, `priority`, `is_active`) are untouched.
--   * Idempotent — every statement uses IF [NOT] EXISTS / CREATE OR REPLACE
--     so re-running the migration is a no-op.
--   * Backward compatible — the worker's existing path (record_feed_
--     ingestion_outcome + release_ingestion_job + lease_due_feeds) keeps
--     working byte-for-byte even if this RPC is never called.
--   * Failsafe by design — every code path silently no-ops when the optional
--     `fetch_interval_seconds` column is missing, when the feed row is gone,
--     or when the input signal is unrecognized. Never raises to the caller.
--   * Does NOT modify `is_active`, `priority`, or `lease_due_feeds`. Manual
--     admin overrides of those columns are preserved.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Signal log table (additive, nullable, optional)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rss_feed_ingestion_signals (
  id              bigserial PRIMARY KEY,
  feed_id         uuid NOT NULL,
  worker_id       text,
  signal          text NOT NULL
                    CHECK (signal IN (
                      'success_with_new_articles',
                      'success_no_new_articles',
                      'failed_fetch'
                    )),
  fetched_count   integer,
  latency_ms      integer,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  previous_interval_seconds integer,
  next_interval_seconds     integer,
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_rss_feed_ingestion_signals_feed_observed
  ON rss_feed_ingestion_signals (feed_id, observed_at DESC);

-- ----------------------------------------------------------------------------
-- 2) apply_feed_ingestion_signal(...)
--
-- The single entry point workers use to report ingestion outcomes for
-- adaptive cadence purposes. Returns void; never raises.
--
-- Adjustment policy (success signals only):
--   * success_with_new_articles -> DECREASE fetch_interval_seconds by
--     v_decrease_step (60s), clamped to [v_min_floor, current].
--   * success_no_new_articles   -> INCREASE fetch_interval_seconds by
--     v_increase_step (120s), clamped to [current, v_max_ceiling].
--   * failed_fetch              -> NO interval change. The existing
--     `record_feed_ingestion_outcome` RPC (migration 040) is the single
--     owner of failure backoff via `backoff_seconds`, and `next_fetch_at`
--     is recomputed there as `now() + fetch_interval_seconds + backoff_seconds`.
--
-- The function never touches `is_active`, `priority`, `next_fetch_at`, or
-- the lease selection logic. It only writes to `fetch_interval_seconds`,
-- and only when the column exists and the row is present.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_feed_ingestion_signal(
  p_feed_id        uuid,
  p_worker_id      text,
  p_signal         text,
  p_fetched_count  integer DEFAULT 0,
  p_latency_ms     integer DEFAULT 0,
  p_timestamp      timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Bounds mirror the DB CHECK on fetch_interval_seconds (60..86400) but stay
  -- conservatively inside it so we never bump into the constraint.
  v_min_floor      constant integer := 300;    -- 5 min
  v_max_ceiling    constant integer := 10800;  -- 3 h
  v_decrease_step  constant integer := 60;     -- 1 min
  v_increase_step  constant integer := 120;    -- 2 min

  v_has_interval_col boolean := false;
  v_current_interval integer;
  v_next_interval    integer;
  v_notes            text := NULL;
BEGIN
  -- Input validation: silently no-op on bad input so the worker is never
  -- blocked by a malformed signal.
  IF p_feed_id IS NULL THEN
    RETURN;
  END IF;
  IF p_signal IS NULL OR p_signal NOT IN (
    'success_with_new_articles',
    'success_no_new_articles',
    'failed_fetch'
  ) THEN
    RETURN;
  END IF;

  -- Column probe: tolerate environments where migration 040 hasn't been
  -- applied yet. If `fetch_interval_seconds` is missing we log the signal
  -- (best effort) and exit without touching scheduling.
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'rss_feed_sources'
      AND column_name = 'fetch_interval_seconds'
  ) INTO v_has_interval_col;

  IF NOT v_has_interval_col THEN
    BEGIN
      INSERT INTO rss_feed_ingestion_signals (
        feed_id, worker_id, signal, fetched_count, latency_ms,
        observed_at, previous_interval_seconds, next_interval_seconds, notes
      ) VALUES (
        p_feed_id, p_worker_id, p_signal,
        COALESCE(p_fetched_count, 0), COALESCE(p_latency_ms, 0),
        COALESCE(p_timestamp, now()), NULL, NULL,
        'fetch_interval_seconds column missing — no adjustment applied'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Logging is best-effort; ingestion must never block on it.
      NULL;
    END;
    RETURN;
  END IF;

  -- Read current interval. If the row is gone we simply no-op.
  SELECT fetch_interval_seconds
    INTO v_current_interval
    FROM rss_feed_sources
   WHERE id = p_feed_id
   FOR UPDATE;

  IF NOT FOUND OR v_current_interval IS NULL OR v_current_interval <= 0 THEN
    RETURN;
  END IF;

  -- Decide the new interval. failed_fetch is a deliberate no-op here —
  -- record_feed_ingestion_outcome owns failure pacing.
  v_next_interval := v_current_interval;
  IF p_signal = 'success_with_new_articles' THEN
    v_next_interval := GREATEST(v_min_floor, v_current_interval - v_decrease_step);
    v_notes := 'decreased interval (productive feed)';
  ELSIF p_signal = 'success_no_new_articles' THEN
    v_next_interval := LEAST(v_max_ceiling, v_current_interval + v_increase_step);
    v_notes := 'increased interval (quiet feed)';
  ELSE
    -- failed_fetch: deferred to record_feed_ingestion_outcome
    v_notes := 'failure logged; backoff handled by record_feed_ingestion_outcome';
  END IF;

  -- Hard clamp inside the DB CHECK bounds (60..86400) defensively.
  v_next_interval := GREATEST(60, LEAST(86400, v_next_interval));

  -- Only write when the value actually changes. We never touch
  -- next_fetch_at, priority, is_active, backoff_seconds, leased_by,
  -- last_status, or last_run_at here.
  IF v_next_interval <> v_current_interval THEN
    UPDATE rss_feed_sources
       SET fetch_interval_seconds = v_next_interval
     WHERE id = p_feed_id;
  END IF;

  -- Best-effort signal log. Wrapped so a logging failure cannot abort the
  -- caller's transaction or block ingestion.
  BEGIN
    INSERT INTO rss_feed_ingestion_signals (
      feed_id, worker_id, signal, fetched_count, latency_ms,
      observed_at, previous_interval_seconds, next_interval_seconds, notes
    ) VALUES (
      p_feed_id, p_worker_id, p_signal,
      COALESCE(p_fetched_count, 0), COALESCE(p_latency_ms, 0),
      COALESCE(p_timestamp, now()),
      v_current_interval, v_next_interval, v_notes
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_feed_ingestion_signal(uuid, text, text, integer, integer, timestamptz)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 3) get_feed_schedule_debug(p_feed_id)
--
-- Returns one row describing the current scheduling state of a feed plus
-- the most recent signal observed. Pure read-only.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_feed_schedule_debug(p_feed_id uuid)
RETURNS TABLE (
  feed_id                  uuid,
  is_active                boolean,
  priority                 integer,
  fetch_interval_seconds   integer,
  backoff_seconds          integer,
  next_fetch_at            timestamptz,
  consecutive_failures     integer,
  reliability_score        numeric,
  last_signal              text,
  last_signal_at           timestamptz,
  last_signal_worker_id    text,
  last_previous_interval   integer,
  last_next_interval       integer,
  last_signal_notes        text,
  reasoning                text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reasoning text;
BEGIN
  RETURN QUERY
  SELECT
    f.id,
    f.is_active,
    f.priority,
    f.fetch_interval_seconds,
    f.backoff_seconds,
    f.next_fetch_at,
    f.consecutive_failures,
    f.reliability_score,
    s.signal,
    s.observed_at,
    s.worker_id,
    s.previous_interval_seconds,
    s.next_interval_seconds,
    s.notes,
    CASE
      WHEN f.backoff_seconds IS NOT NULL AND f.backoff_seconds > 0
        THEN format(
          'next_fetch_at = last_outcome + fetch_interval_seconds(%s) + backoff_seconds(%s)',
          f.fetch_interval_seconds, f.backoff_seconds
        )
      ELSE format(
        'next_fetch_at = last_outcome + fetch_interval_seconds(%s); no active backoff',
        f.fetch_interval_seconds
      )
    END AS reasoning
  FROM rss_feed_sources f
  LEFT JOIN LATERAL (
    SELECT signal, observed_at, worker_id, previous_interval_seconds,
           next_interval_seconds, notes
      FROM rss_feed_ingestion_signals
     WHERE feed_id = f.id
     ORDER BY observed_at DESC
     LIMIT 1
  ) s ON true
  WHERE f.id = p_feed_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_feed_schedule_debug(uuid) TO service_role;

COMMIT;
