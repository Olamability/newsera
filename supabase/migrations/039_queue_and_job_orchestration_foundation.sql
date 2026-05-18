-- ============================================================
-- MIGRATION 039: Queue & job orchestration foundation
-- - Canonical job_queue table for ingestion / notification / ranking / analytics
-- - Dead-letter queue and retry metadata
-- - Lease-based concurrency control (FOR UPDATE SKIP LOCKED)
-- - RPCs: enqueue_job, lease_jobs, complete_job, fail_job
-- - Fully additive; no impact on existing pipelines until callers opt in
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Canonical job queue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name text NOT NULL
    CHECK (queue_name IN ('ingestion', 'notification', 'ranking', 'analytics')),
  job_type text NOT NULL,
  dedup_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority smallint NOT NULL DEFAULT 5
    CHECK (priority BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'running', 'success', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_token uuid,
  leased_by text,
  leased_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup of pending work: at most one (queue_name, job_type, dedup_key)
-- in a non-terminal state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedup_active
  ON job_queue (queue_name, job_type, dedup_key)
  WHERE dedup_key IS NOT NULL
    AND status IN ('queued', 'leased', 'running');

CREATE INDEX IF NOT EXISTS idx_job_queue_dispatch
  ON job_queue (queue_name, status, priority DESC, next_attempt_at ASC)
  WHERE status IN ('queued');

CREATE INDEX IF NOT EXISTS idx_job_queue_lease_expiry
  ON job_queue (status, leased_until)
  WHERE status IN ('leased', 'running');

CREATE INDEX IF NOT EXISTS idx_job_queue_created_at
  ON job_queue (created_at DESC);

-- ------------------------------------------------------------
-- 2) Dead-letter queue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_dead_letter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id uuid,
  queue_name text NOT NULL,
  job_type text NOT NULL,
  dedup_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_job_id uuid
);

CREATE INDEX IF NOT EXISTS idx_job_dead_letter_queue_failed
  ON job_dead_letter (queue_name, failed_at DESC);

-- ------------------------------------------------------------
-- 3) updated_at trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_queue_touch_updated_at ON job_queue;
CREATE TRIGGER trg_job_queue_touch_updated_at
BEFORE UPDATE ON job_queue
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 4) Enqueue RPC (idempotent via dedup_key)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_job(
  p_queue_name text,
  p_job_type text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_dedup_key text DEFAULT NULL,
  p_priority smallint DEFAULT 5,
  p_max_attempts integer DEFAULT 5,
  p_available_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_dedup_key IS NOT NULL THEN
    SELECT id
    INTO v_id
    FROM job_queue
    WHERE queue_name = p_queue_name
      AND job_type = p_job_type
      AND dedup_key = p_dedup_key
      AND status IN ('queued', 'leased', 'running')
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO job_queue (
    queue_name, job_type, dedup_key, payload,
    priority, max_attempts, available_at, next_attempt_at
  )
  VALUES (
    p_queue_name, p_job_type, p_dedup_key, COALESCE(p_payload, '{}'::jsonb),
    GREATEST(LEAST(p_priority, 10), 1)::smallint,
    GREATEST(p_max_attempts, 1),
    p_available_at,
    p_available_at
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION enqueue_job(text, text, jsonb, text, smallint, integer, timestamptz) TO service_role;

-- ------------------------------------------------------------
-- 5) Lease RPC (FOR UPDATE SKIP LOCKED, atomic claim)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION lease_jobs(
  p_queue_name text,
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  job_type text,
  payload jsonb,
  attempts integer,
  lease_token uuid,
  leased_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lease_token uuid := gen_random_uuid();
  v_leased_until timestamptz := now() + make_interval(secs => GREATEST(p_lease_seconds, 5));
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM job_queue j
    WHERE j.queue_name = p_queue_name
      AND (
        j.status = 'queued'
        AND j.next_attempt_at <= now()
        AND j.available_at <= now()
      )
      OR (
        j.queue_name = p_queue_name
        AND j.status IN ('leased', 'running')
        AND j.leased_until IS NOT NULL
        AND j.leased_until < now()
      )
    ORDER BY j.priority DESC, j.next_attempt_at ASC
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE job_queue j
  SET status = 'leased',
      lease_token = v_lease_token,
      leased_by = p_worker_id,
      leased_until = v_leased_until,
      attempts = j.attempts + 1,
      started_at = now()
  FROM claimed c
  WHERE j.id = c.id
  RETURNING
    j.id,
    j.job_type,
    j.payload,
    j.attempts,
    j.lease_token,
    j.leased_until;
END;
$$;

GRANT EXECUTE ON FUNCTION lease_jobs(text, text, integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 6) Heartbeat / extend lease
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION heartbeat_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_extend_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE job_queue
  SET leased_until = now() + make_interval(secs => GREATEST(p_extend_seconds, 5)),
      status = 'running'
  WHERE id = p_job_id
    AND lease_token = p_lease_token
    AND status IN ('leased', 'running');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION heartbeat_job(uuid, uuid, integer) TO service_role;

-- ------------------------------------------------------------
-- 7) Complete RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE job_queue
  SET status = 'success',
      finished_at = now(),
      last_error = NULL,
      lease_token = NULL,
      leased_until = NULL
  WHERE id = p_job_id
    AND lease_token = p_lease_token
    AND status IN ('leased', 'running');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION complete_job(uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 8) Fail RPC: exponential backoff or DLQ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fail_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error text,
  p_base_backoff_seconds integer DEFAULT 30,
  p_max_backoff_seconds integer DEFAULT 3600
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_attempts integer;
  v_max_attempts integer;
  v_queue_name text;
  v_job_type text;
  v_dedup_key text;
  v_payload jsonb;
  v_next_attempt_at timestamptz;
  v_backoff_seconds bigint;
  v_resulting_status text;
BEGIN
  SELECT attempts, max_attempts, queue_name, job_type, dedup_key, payload
  INTO v_attempts, v_max_attempts, v_queue_name, v_job_type, v_dedup_key, v_payload
  FROM job_queue
  WHERE id = p_job_id
    AND lease_token = p_lease_token
    AND status IN ('leased', 'running');

  IF v_attempts IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_attempts >= v_max_attempts THEN
    UPDATE job_queue
    SET status = 'dead',
        finished_at = now(),
        last_error = p_error,
        lease_token = NULL,
        leased_until = NULL
    WHERE id = p_job_id;

    INSERT INTO job_dead_letter (
      original_job_id, queue_name, job_type, dedup_key,
      payload, attempts, last_error
    )
    VALUES (
      p_job_id, v_queue_name, v_job_type, v_dedup_key,
      v_payload, v_attempts, p_error
    );

    v_resulting_status := 'dead';
  ELSE
    v_backoff_seconds := LEAST(
      p_base_backoff_seconds::bigint * (2 ^ GREATEST(v_attempts - 1, 0))::bigint,
      p_max_backoff_seconds::bigint
    );
    v_next_attempt_at := now() + make_interval(secs => v_backoff_seconds);

    UPDATE job_queue
    SET status = 'queued',
        last_error = p_error,
        lease_token = NULL,
        leased_until = NULL,
        next_attempt_at = v_next_attempt_at,
        started_at = NULL
    WHERE id = p_job_id;

    v_resulting_status := 'queued';
  END IF;

  RETURN v_resulting_status;
END;
$$;

GRANT EXECUTE ON FUNCTION fail_job(uuid, uuid, text, integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 9) Reaper for expired leases (called by pg_cron in 044)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION reap_expired_job_leases()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE job_queue
  SET status = 'queued',
      lease_token = NULL,
      leased_until = NULL,
      next_attempt_at = LEAST(next_attempt_at, now()),
      last_error = COALESCE(last_error, '') || ' [lease_expired]'
  WHERE status IN ('leased', 'running')
    AND leased_until IS NOT NULL
    AND leased_until < now() - interval '30 seconds';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION reap_expired_job_leases() TO service_role;

-- ------------------------------------------------------------
-- 10) Replay from DLQ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION replay_dead_letter(p_dlq_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_queue_name text;
  v_job_type text;
  v_dedup_key text;
  v_payload jsonb;
  v_new_job_id uuid;
BEGIN
  SELECT queue_name, job_type, dedup_key, payload
  INTO v_queue_name, v_job_type, v_dedup_key, v_payload
  FROM job_dead_letter
  WHERE id = p_dlq_id
    AND replayed_at IS NULL;

  IF v_queue_name IS NULL THEN
    RETURN NULL;
  END IF;

  v_new_job_id := enqueue_job(v_queue_name, v_job_type, v_payload, v_dedup_key, 5::smallint, 5, now());

  UPDATE job_dead_letter
  SET replayed_at = now(),
      replayed_job_id = v_new_job_id
  WHERE id = p_dlq_id;

  RETURN v_new_job_id;
END;
$$;

GRANT EXECUTE ON FUNCTION replay_dead_letter(uuid) TO service_role;

-- ------------------------------------------------------------
-- 11) RLS — admin read, service-role write only
-- ------------------------------------------------------------
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_dead_letter ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_queue_select_admin ON job_queue;
DROP POLICY IF EXISTS job_queue_write_service_role ON job_queue;

CREATE POLICY job_queue_select_admin
  ON job_queue
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY job_queue_write_service_role
  ON job_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS job_dead_letter_select_admin ON job_dead_letter;
DROP POLICY IF EXISTS job_dead_letter_write_service_role ON job_dead_letter;

CREATE POLICY job_dead_letter_select_admin
  ON job_dead_letter
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY job_dead_letter_write_service_role
  ON job_dead_letter
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
