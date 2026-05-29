-- ============================================================================
-- 057_ingestion_jobs_observability_cleanup.sql
--
-- PURPOSE
--   Improve operational visibility into the RSS ingestion pipeline without
--   touching the working ingestion path. The live worker (rss-worker:v2)
--   continues to read/write the existing columns on `ingestion_jobs`
--   (`last_status`, `last_run_at`, `last_error`, `leased_*`) — this
--   migration only ADDS:
--
--     * generally-named observability columns (`status`, `started_at`,
--       `completed_at`, `error_message`, `article_id`, `worker_id`) kept
--       in sync with the legacy columns via a lightweight trigger so
--       dashboards and ad-hoc queries can use the obvious names;
--     * safe, idempotent indexes for the new columns;
--     * a `get_ingestion_health()` RPC for at-a-glance worker status.
--
-- CONSTRAINTS
--   * ADDITIVE ONLY — no DROP, no RENAME, no CHECK changes that could
--     reject existing rows.
--   * Backward compatible — all new columns are NULLABLE and have safe
--     defaults; existing INSERT/UPDATE statements continue to work.
--   * Idempotent — every statement uses IF [NOT] EXISTS / CREATE OR
--     REPLACE so re-running the migration is a no-op.
--   * Does NOT change ingestion behaviour or how articles are inserted.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Additive observability columns on ingestion_jobs
-- ----------------------------------------------------------------------------
-- The legacy schema (migrations 034 + 040) exposes:
--   id, feed_id, source_id, schedule_cron, priority, enabled,
--   last_run_at, next_run_at, last_status, last_error, created_at,
--   updated_at, lease_token, leased_by, leased_until,
--   consecutive_failures, backoff_seconds, health_score
--
-- We mirror the run-state into clearer, generically-named columns so that
-- operator queries, alerting RPCs, and the get_ingestion_health() helper
-- can use intuitive names regardless of the legacy field shape.

ALTER TABLE IF EXISTS ingestion_jobs
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS article_id uuid;

-- Backfill from the legacy columns so the new fields are immediately
-- populated for every existing row. This is a one-shot UPDATE; subsequent
-- inserts/updates are kept in sync by the trigger below.
UPDATE ingestion_jobs
SET
  status        = COALESCE(status, last_status),
  started_at    = COALESCE(started_at, last_run_at),
  completed_at  = COALESCE(
    completed_at,
    CASE WHEN last_status IN ('success', 'failed') THEN last_run_at ELSE NULL END
  ),
  error_message = COALESCE(error_message, last_error),
  worker_id     = COALESCE(worker_id, leased_by)
WHERE
  status IS NULL
  OR started_at IS NULL
  OR completed_at IS NULL
  OR error_message IS NULL
  OR worker_id IS NULL;

-- ----------------------------------------------------------------------------
-- 2) Keep legacy + observability columns in sync (additive, lossless)
-- ----------------------------------------------------------------------------
-- Bi-directional mirroring: whichever name the caller sets, the other is
-- populated automatically. This insulates downstream consumers from the
-- historical naming and avoids forcing the worker to write both columns.

CREATE OR REPLACE FUNCTION sync_ingestion_jobs_observability_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- last_status <-> status
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS NOT NULL THEN
    NEW.last_status := NEW.status;
  ELSIF NEW.last_status IS DISTINCT FROM OLD.last_status AND NEW.last_status IS NOT NULL THEN
    NEW.status := NEW.last_status;
  END IF;

  -- last_run_at <-> started_at
  IF NEW.started_at IS DISTINCT FROM OLD.started_at AND NEW.started_at IS NOT NULL THEN
    NEW.last_run_at := NEW.started_at;
  ELSIF NEW.last_run_at IS DISTINCT FROM OLD.last_run_at AND NEW.last_run_at IS NOT NULL THEN
    NEW.started_at := COALESCE(NEW.started_at, NEW.last_run_at);
  END IF;

  -- last_error <-> error_message
  IF NEW.error_message IS DISTINCT FROM OLD.error_message AND NEW.error_message IS NOT NULL THEN
    NEW.last_error := NEW.error_message;
  ELSIF NEW.last_error IS DISTINCT FROM OLD.last_error AND NEW.last_error IS NOT NULL THEN
    NEW.error_message := NEW.last_error;
  END IF;

  -- leased_by <-> worker_id
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id AND NEW.worker_id IS NOT NULL THEN
    NEW.leased_by := NEW.worker_id;
  ELSIF NEW.leased_by IS DISTINCT FROM OLD.leased_by AND NEW.leased_by IS NOT NULL THEN
    NEW.worker_id := NEW.leased_by;
  END IF;

  -- Terminal status auto-stamps completed_at if the worker forgot to.
  IF NEW.status IN ('success', 'failed') AND NEW.completed_at IS NULL THEN
    NEW.completed_at := COALESCE(NEW.last_run_at, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_ingestion_jobs_observability ON ingestion_jobs;

CREATE TRIGGER trg_sync_ingestion_jobs_observability
  BEFORE INSERT OR UPDATE ON ingestion_jobs
  FOR EACH ROW
  EXECUTE FUNCTION sync_ingestion_jobs_observability_columns();

-- ----------------------------------------------------------------------------
-- 3) Safe additive indexes
-- ----------------------------------------------------------------------------
-- All CREATE INDEX statements use IF NOT EXISTS and target the new
-- observability columns. The pre-existing `idx_ingestion_jobs_lease`
-- (on last_status, leased_until) is left untouched.

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
  ON ingestion_jobs (status);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_at
  ON ingestion_jobs (created_at DESC);

-- An index on feed_id already exists implicitly via the UNIQUE constraint
-- declared in migration 034. We add an explicit btree to give the planner
-- a non-unique option for range scans and joins.
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_feed_id_btree
  ON ingestion_jobs (feed_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_completed_at
  ON ingestion_jobs (completed_at DESC NULLS LAST);

-- ----------------------------------------------------------------------------
-- 4) get_ingestion_health() — one-call operator snapshot
-- ----------------------------------------------------------------------------
-- Returns a single row with the headline numbers an operator wants to see:
--
--   active_workers                  — distinct worker_heartbeats alive in the
--                                     last 2 minutes.
--   recent_jobs                     — ingestion_jobs touched in the last hour.
--   failed_jobs                     — ingestion_jobs whose latest status is
--                                     'failed' in the last 24 hours.
--   latest_article_at               — most recent articles.published_at.
--   latest_successful_ingestion_at  — most recent ingestion_jobs.completed_at
--                                     with status='success'.
--
-- SECURITY DEFINER so callers without direct table access (e.g. anon users
-- hitting a public status page) can still get the snapshot, but the function
-- is GRANTed narrowly below.

CREATE OR REPLACE FUNCTION get_ingestion_health()
RETURNS TABLE (
  active_workers                 integer,
  recent_jobs                    integer,
  failed_jobs                    integer,
  latest_article_at              timestamptz,
  latest_successful_ingestion_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE((
      SELECT COUNT(DISTINCT worker_id)::integer
      FROM worker_heartbeats
      WHERE status = 'alive'
        AND last_heartbeat_at > now() - interval '2 minutes'
    ), 0) AS active_workers,
    COALESCE((
      SELECT COUNT(*)::integer
      FROM ingestion_jobs
      WHERE COALESCE(completed_at, started_at, last_run_at, updated_at)
            > now() - interval '1 hour'
    ), 0) AS recent_jobs,
    COALESCE((
      SELECT COUNT(*)::integer
      FROM ingestion_jobs
      WHERE COALESCE(status, last_status) = 'failed'
        AND COALESCE(completed_at, last_run_at, updated_at)
            > now() - interval '24 hours'
    ), 0) AS failed_jobs,
    (SELECT MAX(published_at) FROM articles)            AS latest_article_at,
    (SELECT MAX(COALESCE(completed_at, last_run_at))
       FROM ingestion_jobs
      WHERE COALESCE(status, last_status) = 'success')  AS latest_successful_ingestion_at;
END;
$$;

REVOKE ALL ON FUNCTION get_ingestion_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_ingestion_health() TO authenticated, service_role;

COMMENT ON FUNCTION get_ingestion_health() IS
  'Returns a one-row snapshot of RSS ingestion health: active workers, '
  'recent + failed jobs, and the freshest article/ingestion timestamps. '
  'Safe to call from dashboards, status pages, and alerting jobs.';

COMMIT;
