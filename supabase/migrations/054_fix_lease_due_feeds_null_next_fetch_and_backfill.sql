-- ============================================================
-- MIGRATION 054: lease_due_feeds idle-on-empty fix + scheduling
--                bootstrap + eligibility observability
--
-- Production symptom
-- ------------------
--   * rss-worker:v2 is healthy (heartbeat registered, queue
--     system running, no crashes, no SQL errors)
--   * `lease_due_feeds_idle` fires on every poll
--   * `ingestion_jobs_total = 0`
--   * `articles` table stops growing despite having historical
--     data and active rows in `rss_feed_sources`
--
-- Root causes
-- -----------
-- 1. PART A — `lease_due_feeds` filtered feeds with
--
--        AND f.next_fetch_at <= now()
--
--    but did NOT tolerate `next_fetch_at IS NULL`. Migration 040
--    added `next_fetch_at timestamptz NOT NULL DEFAULT now()`,
--    however the canonical eligibility predicate documented in
--    the activation spec is
--
--        is_active = true
--        AND (next_fetch_at IS NULL OR next_fetch_at <= now())
--
--    and seeded / hand-imported rows from older environments
--    that pre-date migration 040 may legitimately carry NULL
--    (the column is then back-filled to its default only on
--    `INSERT`, never on existing rows). Without the NULL branch
--    those legacy feeds are silently excluded forever.
--
-- 2. PART B — Active feeds whose `next_fetch_at` has drifted
--    far into the future (e.g. an environment that was paused
--    for a while, a stuck backoff window, or a partial restore)
--    are never re-eligible without operator intervention. We
--    need an idempotent backfill so activation always converges.
--
-- 3. PART D — There is no read-only counterpart to
--    `lease_due_feeds` that tells operators (and the worker)
--    *how many* feeds were eligible at decision time. When the
--    leasing RPC returns zero rows it is impossible to tell
--    "no due feeds" from "due feeds existed but were excluded
--    by a bug" without manually running ad-hoc SQL.
--
-- This migration is strictly additive:
--   * function signatures, return types, column names — unchanged
--   * lease semantics, ordering, `FOR UPDATE SKIP LOCKED` — unchanged
--   * downstream consumers (worker, admin panel, mobile app) — unchanged
--   * no schema rewrites, no infra changes, rollback-safe
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- PART A: re-issue lease_due_feeds with the NULL-tolerant
-- eligibility predicate. Keeps the de-ambiguation directive and
-- fully-qualified column references introduced by migration 052.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION lease_due_feeds(
  p_worker_id text,
  p_batch_size integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE (
  feed_id uuid,
  name text,
  url text,
  source_id uuid,
  priority smallint,
  reliability_score numeric,
  lease_token uuid,
  leased_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
#variable_conflict use_column
DECLARE
  v_lease_token uuid := gen_random_uuid();
  v_leased_until timestamptz := now() + make_interval(secs => GREATEST(p_lease_seconds, 30));
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT f.id AS feed_id
    FROM rss_feed_sources f
    WHERE f.is_active = true
      -- Canonical eligibility predicate. The NULL branch protects
      -- against legacy rows that pre-date migration 040 (when
      -- next_fetch_at was added with a NOT NULL default — defaults
      -- only apply on INSERT, not to pre-existing rows) and against
      -- any future code path that explicitly clears the column.
      AND (f.next_fetch_at IS NULL OR f.next_fetch_at <= now())
      AND NOT EXISTS (
        SELECT 1
        FROM ingestion_jobs ij
        WHERE ij.feed_id = f.id
          AND ij.leased_until IS NOT NULL
          AND ij.leased_until > now()
      )
    -- NULLs sort last under ASC by default, so we coerce NULL to
    -- the epoch to guarantee orphaned-schedule rows are leased
    -- *first* on the next poll — they have been waiting longest.
    ORDER BY f.priority DESC NULLS LAST,
             COALESCE(f.next_fetch_at, 'epoch'::timestamptz) ASC
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  ),
  upserted AS (
    INSERT INTO ingestion_jobs AS ij (
      feed_id, source_id, schedule_cron, priority, enabled,
      last_run_at, last_status, lease_token, leased_by, leased_until
    )
    SELECT
      c.feed_id,
      f.source_id,
      'manual',
      f.priority,
      true,
      now(),
      'running',
      v_lease_token,
      p_worker_id,
      v_leased_until
    FROM claimed c
    JOIN rss_feed_sources f ON f.id = c.feed_id
    ON CONFLICT (feed_id)
    DO UPDATE SET
      last_run_at = now(),
      last_status = 'running',
      lease_token = v_lease_token,
      leased_by = p_worker_id,
      leased_until = v_leased_until,
      updated_at = now()
    RETURNING ij.feed_id AS feed_id
  )
  SELECT
    f.id,
    f.name,
    f.url,
    f.source_id,
    f.priority,
    f.reliability_score,
    v_lease_token,
    v_leased_until
  FROM upserted u
  JOIN rss_feed_sources f ON f.id = u.feed_id;
END;
$$;

GRANT EXECUTE ON FUNCTION lease_due_feeds(text, integer, integer) TO service_role;

-- ------------------------------------------------------------
-- PART D: read-only eligibility counter.
--
-- Pure observability — never mutates state, never holds row
-- locks. The worker calls this once per claim cycle (when the
-- leasing RPC returns zero rows) to disambiguate between
-- "genuinely no due feeds" and "due feeds existed but the
-- leasing RPC excluded them". Operators can also invoke it
-- directly from psql / the admin panel as a fast health probe.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION count_due_feeds()
RETURNS TABLE (
  eligible_feeds bigint,
  active_feeds bigint,
  leased_feeds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    (
      SELECT count(*)::bigint
      FROM rss_feed_sources f
      WHERE f.is_active = true
        AND (f.next_fetch_at IS NULL OR f.next_fetch_at <= now())
        AND NOT EXISTS (
          SELECT 1
          FROM ingestion_jobs ij
          WHERE ij.feed_id = f.id
            AND ij.leased_until IS NOT NULL
            AND ij.leased_until > now()
        )
    ) AS eligible_feeds,
    (SELECT count(*)::bigint FROM rss_feed_sources WHERE is_active = true) AS active_feeds,
    (
      SELECT count(*)::bigint
      FROM ingestion_jobs ij
      WHERE ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    ) AS leased_feeds;
$$;

GRANT EXECUTE ON FUNCTION count_due_feeds() TO service_role, authenticated;

-- ------------------------------------------------------------
-- PART B: idempotent scheduling bootstrap.
--
-- Brings every active feed with a missing / drifted
-- next_fetch_at back into the due-set. Two failure modes are
-- corrected:
--
--   1. next_fetch_at IS NULL
--      Legacy rows that pre-date migration 040.
--
--   2. next_fetch_at > now() + interval '1 hour'
--      Rows whose backoff window is unreasonably far in the
--      future after a paused environment, a stuck reliability
--      score update, or a partial restore. The 1-hour threshold
--      matches the cap already used by migration 051 so the two
--      bootstraps stay aligned.
--
-- Safe to call repeatedly. Returns a jsonb summary so callers
-- (the migration DO block below, ops scripts, and the admin
-- panel) can log exactly what changed.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION backfill_next_fetch_at_for_active_feeds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_null_fixed integer := 0;
  v_drift_fixed integer := 0;
BEGIN
  WITH upd AS (
    UPDATE rss_feed_sources
       SET next_fetch_at = now()
     WHERE is_active = true
       AND next_fetch_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_null_fixed FROM upd;

  WITH upd AS (
    UPDATE rss_feed_sources
       SET next_fetch_at = now()
     WHERE is_active = true
       AND next_fetch_at IS NOT NULL
       AND next_fetch_at > now() + interval '1 hour'
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_drift_fixed FROM upd;

  RETURN jsonb_build_object(
    'null_next_fetch_at_fixed', v_null_fixed,
    'drifted_next_fetch_at_fixed', v_drift_fixed,
    'ran_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION backfill_next_fetch_at_for_active_feeds()
  TO service_role;

-- ------------------------------------------------------------
-- Run the backfill once during migration. Failure here must not
-- block the migration: the RPC remains available for manual
-- invocation by ops if the bootstrap is skipped for any reason.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := backfill_next_fetch_at_for_active_feeds();
  RAISE NOTICE 'backfill_next_fetch_at_for_active_feeds: %', v_result;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'backfill_next_fetch_at_for_active_feeds skipped: %', SQLERRM;
END $$;

-- ============================================================
-- END OF MIGRATION 054
-- ============================================================
