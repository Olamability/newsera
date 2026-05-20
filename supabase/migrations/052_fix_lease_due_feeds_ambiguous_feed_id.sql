-- ============================================================
-- MIGRATION 052: Fix lease_due_feeds — ambiguous "feed_id" column
--
-- Purely additive, surgical fix for the production-activation
-- blocker where the RSS ingestion worker (`rss:worker:v2`) cannot
-- lease any feeds because the leasing RPC errors out with:
--
--     lease_due_feeds_failed
--     ERROR: column reference "feed_id" is ambiguous
--
-- Symptom impact
-- --------------
--   * No rows ever appear in `ingestion_jobs` via the leasing path
--   * No articles are produced downstream
--   * Notifications / personalization / ranking remain empty
--   * Readiness matrix shows `rss_workers` blocked
--
-- Root cause
-- ----------
-- Migration 040 declared:
--
--   CREATE OR REPLACE FUNCTION lease_due_feeds(...)
--   RETURNS TABLE (
--     feed_id uuid,
--     name text,
--     url text,
--     source_id uuid,
--     priority smallint,
--     reliability_score numeric,
--     lease_token uuid,
--     leased_until timestamptz
--   )
--   LANGUAGE plpgsql ...
--
-- In PL/pgSQL, every `RETURNS TABLE` column is an OUT parameter
-- and is therefore in scope as a *variable* throughout the
-- function body. PL/pgSQL's default `variable_conflict` policy is
-- `error`, so any unqualified column reference whose name matches
-- one of those OUT parameters is rejected by Postgres with
-- "column reference \"<name>\" is ambiguous".
--
-- The leasing function contains exactly such a reference inside
-- the upsert:
--
--     ON CONFLICT (feed_id)        -- <-- ambiguous: OUT param vs.
--                                  --     ingestion_jobs.feed_id
--
-- `ON CONFLICT` conflict-target columns *cannot* be table-
-- qualified (Postgres syntax disallows `table.col` there), so we
-- fix this the canonical way: instruct PL/pgSQL to prefer the
-- column over the variable by adding
--
--     #variable_conflict use_column
--
-- at the top of the function body. We also defensively re-qualify
-- every remaining `feed_id` reference (`ij.feed_id`,
-- `ingestion_jobs.feed_id`, `u.feed_id`) so the SQL is robust
-- even if the directive is ever revisited.
--
-- What is NOT changed
-- -------------------
--   * Function signature (name, args, return type) — unchanged.
--   * Returned column ordering / names / types — unchanged
--     (the worker reads them by name via supabase-js).
--   * Lease semantics, batch ordering, `FOR UPDATE SKIP LOCKED`,
--     reliability scoring, ingestion architecture — unchanged.
--   * Schema, indexes, feature flags, migration numbering of
--     prior migrations — unchanged.
--
-- Validation
-- ----------
--   1. `SELECT * FROM lease_due_feeds('manual-test', 1, 60);`
--      returns rows (or empty set) without raising.
--   2. `pnpm rss:worker:v2` logs `lease_due_feeds_success`
--      followed by `job_leased` / `processing_feed` instead of
--      `lease_due_feeds_failed`.
--   3. `SELECT COUNT(*) FROM articles;` begins to grow.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- Replace lease_due_feeds with the de-ambiguated body.
-- `CREATE OR REPLACE` preserves the existing signature and any
-- grants — but we re-issue the explicit GRANT below to match the
-- pattern established by migration 040.
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
      AND f.next_fetch_at <= now()
      AND NOT EXISTS (
        SELECT 1
        FROM ingestion_jobs ij
        WHERE ij.feed_id = f.id
          AND ij.leased_until IS NOT NULL
          AND ij.leased_until > now()
      )
    ORDER BY f.priority DESC, f.next_fetch_at ASC
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
