-- ============================================================
-- MIGRATION 040: RSS worker health + feed reliability
-- - Extend ingestion_jobs and rss_feed_sources with health/scoring columns
-- - Worker heartbeat table for distributed coordination
-- - RPCs to update feed health and calculate reliability scores
-- - Additive only; existing single-process worker remains functional
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Feed health columns on rss_feed_sources
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS rss_feed_sources
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_latency_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_score numeric(5,4) NOT NULL DEFAULT 1.0
    CHECK (reliability_score BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS fetch_interval_seconds integer NOT NULL DEFAULT 600
    CHECK (fetch_interval_seconds BETWEEN 60 AND 86400),
  ADD COLUMN IF NOT EXISTS backoff_seconds integer NOT NULL DEFAULT 0
    CHECK (backoff_seconds >= 0),
  ADD COLUMN IF NOT EXISTS next_fetch_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 5
    CHECK (priority BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS idx_rss_feed_sources_active_next_fetch
  ON rss_feed_sources (is_active, next_fetch_at ASC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_rss_feed_sources_reliability
  ON rss_feed_sources (reliability_score DESC NULLS LAST);

-- ------------------------------------------------------------
-- 2) Ingestion job orchestration columns
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS ingestion_jobs
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS leased_by text,
  ADD COLUMN IF NOT EXISTS leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backoff_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_score numeric(5,4) NOT NULL DEFAULT 1.0
    CHECK (health_score BETWEEN 0 AND 1);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_lease
  ON ingestion_jobs (last_status, leased_until)
  WHERE last_status IN ('queued', 'running');

-- ------------------------------------------------------------
-- 3) Worker heartbeat table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id text NOT NULL,
  worker_type text NOT NULL
    CHECK (worker_type IN ('rss_ingestion', 'notification_dispatch', 'ranking', 'analytics', 'cleanup', 'generic')),
  hostname text,
  pid integer,
  status text NOT NULL DEFAULT 'alive'
    CHECK (status IN ('alive', 'draining', 'stopped', 'crashed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (worker_id, worker_type)
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_type_status
  ON worker_heartbeats (worker_type, status, last_heartbeat_at DESC);

CREATE OR REPLACE FUNCTION worker_heartbeat(
  p_worker_id text,
  p_worker_type text,
  p_hostname text DEFAULT NULL,
  p_pid integer DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO worker_heartbeats (
    worker_id, worker_type, hostname, pid, status,
    started_at, last_heartbeat_at, metadata
  )
  VALUES (
    p_worker_id, p_worker_type, p_hostname, p_pid, 'alive',
    now(), now(), COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (worker_id, worker_type)
  DO UPDATE SET
    last_heartbeat_at = now(),
    status = 'alive',
    hostname = COALESCE(EXCLUDED.hostname, worker_heartbeats.hostname),
    pid = COALESCE(EXCLUDED.pid, worker_heartbeats.pid),
    metadata = worker_heartbeats.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION worker_heartbeat(text, text, text, integer, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION mark_stale_workers_crashed(p_stale_after_seconds integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE worker_heartbeats
  SET status = 'crashed'
  WHERE status = 'alive'
    AND last_heartbeat_at < now() - make_interval(secs => GREATEST(p_stale_after_seconds, 30));

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_stale_workers_crashed(integer) TO service_role;

-- ------------------------------------------------------------
-- 4) Reliability recompute (exponential moving average on
--    success ratio + latency penalty)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_feed_ingestion_outcome(
  p_feed_id uuid,
  p_success boolean,
  p_latency_ms integer,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_alpha numeric := 0.2; -- EMA smoothing factor
  v_current_score numeric;
  v_new_score numeric;
  v_observation numeric;
  v_avg_latency integer;
  v_success_count integer;
  v_consecutive_failures integer;
  v_total_observations integer;
  v_new_backoff integer;
BEGIN
  IF p_feed_id IS NULL THEN
    RETURN;
  END IF;

  SELECT reliability_score, average_latency_ms, success_count, consecutive_failures
  INTO v_current_score, v_avg_latency, v_success_count, v_consecutive_failures
  FROM rss_feed_sources
  WHERE id = p_feed_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_observation := CASE WHEN p_success THEN 1.0 ELSE 0.0 END;
  v_new_score := GREATEST(LEAST(
    (1 - v_alpha) * COALESCE(v_current_score, 1.0) + v_alpha * v_observation,
    1.0
  ), 0.0);

  v_total_observations := COALESCE(v_success_count, 0) + COALESCE(v_consecutive_failures, 0) + 1;
  v_avg_latency := (
    (COALESCE(v_avg_latency, 0) * (v_total_observations - 1)
     + GREATEST(COALESCE(p_latency_ms, 0), 0))
    / GREATEST(v_total_observations, 1)
  )::integer;

  IF p_success THEN
    v_consecutive_failures := 0;
    v_new_backoff := 0;
    v_success_count := COALESCE(v_success_count, 0) + 1;
  ELSE
    v_consecutive_failures := COALESCE(v_consecutive_failures, 0) + 1;
    -- Exponential backoff capped at 6 hours.
    v_new_backoff := LEAST(60 * (2 ^ LEAST(v_consecutive_failures, 8))::integer, 21600);
  END IF;

  UPDATE rss_feed_sources
  SET reliability_score = v_new_score,
      average_latency_ms = v_avg_latency,
      success_count = v_success_count,
      consecutive_failures = v_consecutive_failures,
      backoff_seconds = v_new_backoff,
      last_success_at = CASE WHEN p_success THEN now() ELSE last_success_at END,
      last_failure_at = CASE WHEN NOT p_success THEN now() ELSE last_failure_at END,
      last_fetched_at = now(),
      last_error = CASE WHEN NOT p_success THEN p_error ELSE NULL END,
      fetch_count = COALESCE(fetch_count, 0) + 1,
      error_count = COALESCE(error_count, 0) + CASE WHEN NOT p_success THEN 1 ELSE 0 END,
      next_fetch_at = now() + make_interval(
        secs => GREATEST(fetch_interval_seconds + v_new_backoff, 60)
      )
  WHERE id = p_feed_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_feed_ingestion_outcome(uuid, boolean, integer, text) TO service_role;

-- ------------------------------------------------------------
-- 5) Lease ingestion jobs (per-feed, lease-based)
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
DECLARE
  v_lease_token uuid := gen_random_uuid();
  v_leased_until timestamptz := now() + make_interval(secs => GREATEST(p_lease_seconds, 30));
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT f.id
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
    INSERT INTO ingestion_jobs (
      feed_id, source_id, schedule_cron, priority, enabled,
      last_run_at, last_status, lease_token, leased_by, leased_until
    )
    SELECT
      c.id,
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
    JOIN rss_feed_sources f ON f.id = c.id
    ON CONFLICT (feed_id)
    DO UPDATE SET
      last_run_at = now(),
      last_status = 'running',
      lease_token = v_lease_token,
      leased_by = p_worker_id,
      leased_until = v_leased_until,
      updated_at = now()
    RETURNING ingestion_jobs.feed_id
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
-- 6) Release ingestion job lease
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_ingestion_job(
  p_feed_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'release_ingestion_job: invalid status %', p_status;
  END IF;

  UPDATE ingestion_jobs
  SET last_status = p_status,
      last_error = p_error,
      lease_token = NULL,
      leased_until = NULL,
      consecutive_failures = CASE
        WHEN p_status = 'success' THEN 0
        ELSE consecutive_failures + 1
      END,
      health_score = CASE
        WHEN p_status = 'success' THEN LEAST(health_score + 0.05, 1.0)
        ELSE GREATEST(health_score - 0.10, 0.0)
      END,
      next_run_at = CASE
        WHEN p_status = 'success' THEN now() + interval '10 minutes'
        ELSE now() + make_interval(
          secs => LEAST(60 * (2 ^ LEAST(consecutive_failures + 1, 8))::integer, 21600)
        )
      END,
      updated_at = now()
  WHERE feed_id = p_feed_id
    AND lease_token = p_lease_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION release_ingestion_job(uuid, uuid, text, text) TO service_role;

-- ------------------------------------------------------------
-- 7) RLS — admin read, service-role write
-- ------------------------------------------------------------
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_heartbeats_select_admin ON worker_heartbeats;
DROP POLICY IF EXISTS worker_heartbeats_write_service_role ON worker_heartbeats;

CREATE POLICY worker_heartbeats_select_admin
  ON worker_heartbeats
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY worker_heartbeats_write_service_role
  ON worker_heartbeats
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
