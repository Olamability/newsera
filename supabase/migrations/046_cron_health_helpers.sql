-- ============================================================
-- MIGRATION 046: pg_cron health helpers (Phase C activation)
-- - get_pg_cron_status():      reports whether pg_cron is installed
-- - get_cron_job_health():     joins cron.job + cron.job_run_details
--                              for the 11 schedules declared in 044
-- - Both gracefully degrade when pg_cron is missing (Supabase local
--   dev or restricted projects) so the admin dashboard can render a
--   "pg_cron not installed" banner instead of crashing.
-- - Read-only; no schema mutation outside of these functions.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) pg_cron presence probe
-- Returns a single row describing whether the extension is installed
-- and whether the calling role can read cron.job. This is the safe
-- gate the dashboard should query before calling get_cron_job_health.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_pg_cron_status()
RETURNS TABLE (
  pg_cron_installed boolean,
  cron_schema_present boolean,
  job_table_readable boolean,
  run_details_table_readable boolean,
  scheduled_job_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_installed boolean := false;
  v_schema_present boolean := false;
  v_job_readable boolean := false;
  v_run_readable boolean := false;
  v_count integer := 0;
BEGIN
  -- Admin-only: function returns empty when not admin.
  IF coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin'
     AND current_user <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) INTO v_installed;

  SELECT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
  ) INTO v_schema_present;

  IF v_schema_present THEN
    BEGIN
      PERFORM 1 FROM cron.job LIMIT 1;
      v_job_readable := true;
    EXCEPTION WHEN OTHERS THEN
      v_job_readable := false;
    END;

    BEGIN
      PERFORM 1 FROM cron.job_run_details LIMIT 1;
      v_run_readable := true;
    EXCEPTION WHEN OTHERS THEN
      v_run_readable := false;
    END;

    IF v_job_readable THEN
      BEGIN
        EXECUTE 'SELECT COUNT(*)::integer FROM cron.job' INTO v_count;
      EXCEPTION WHEN OTHERS THEN
        v_count := 0;
      END;
    END IF;
  END IF;

  pg_cron_installed := v_installed;
  cron_schema_present := v_schema_present;
  job_table_readable := v_job_readable;
  run_details_table_readable := v_run_readable;
  scheduled_job_count := v_count;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION get_pg_cron_status() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2) Per-job health summary
-- For each row in cron.job, return:
--   - last_run / last_status / last_duration_ms (most recent run)
--   - runs_24h / failures_24h (24h rollup from job_run_details)
--   - is_expected: true if jobname matches one of the 11 schedules
--     declared by migration 044 (so the dashboard can flag drift)
-- Returns empty when pg_cron unavailable; this lets the dashboard
-- safely render an empty table with the cron-status banner above.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_cron_job_health()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  command text,
  active boolean,
  is_expected boolean,
  last_run timestamptz,
  last_status text,
  last_duration_ms integer,
  last_error text,
  runs_24h integer,
  failures_24h integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_schema_present boolean := false;
  v_job_readable boolean := false;
  v_run_readable boolean := false;
  v_expected text[] := ARRAY[
    'reap_expired_job_leases_1m',
    'mark_stale_workers_crashed_2m',
    'refresh_ranked_feeds_5m',
    'process_pending_personalization_1m',
    'refresh_active_personalized_15m',
    'cleanup_job_queue_daily',
    'cleanup_job_dead_letter_weekly',
    'cleanup_notification_events_daily',
    'cleanup_notification_deliveries_d',
    'cleanup_worker_heartbeats_daily',
    'cleanup_personalized_feeds_daily'
  ];
BEGIN
  -- Admin-only gate, matching feature_flags_write_admin policy idiom.
  IF coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin'
     AND current_user <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
  ) INTO v_schema_present;

  IF NOT v_schema_present THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM 1 FROM cron.job LIMIT 1;
    v_job_readable := true;
  EXCEPTION WHEN OTHERS THEN
    v_job_readable := false;
  END;

  IF NOT v_job_readable THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM 1 FROM cron.job_run_details LIMIT 1;
    v_run_readable := true;
  EXCEPTION WHEN OTHERS THEN
    v_run_readable := false;
  END;

  -- Dynamic EXECUTE so the function compiles even on databases that
  -- lack the cron schema entirely (e.g. local supabase dev without
  -- pg_cron). The presence checks above keep this branch unreached
  -- in that case, but plpgsql still type-checks function bodies.
  IF v_run_readable THEN
    RETURN QUERY EXECUTE $q$
      WITH latest AS (
        SELECT DISTINCT ON (jrd.jobid)
          jrd.jobid,
          jrd.start_time AS last_run,
          jrd.status     AS last_status,
          GREATEST(
            EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time)) * 1000.0,
            0
          )::integer AS last_duration_ms,
          jrd.return_message AS last_error
        FROM cron.job_run_details jrd
        ORDER BY jrd.jobid, jrd.start_time DESC
      ),
      rollup AS (
        SELECT
          jrd.jobid,
          COUNT(*)::integer AS runs_24h,
          COUNT(*) FILTER (WHERE jrd.status <> 'succeeded')::integer AS failures_24h
        FROM cron.job_run_details jrd
        WHERE jrd.start_time >= now() - interval '24 hours'
        GROUP BY jrd.jobid
      )
      SELECT
        j.jobid::bigint,
        j.jobname::text,
        j.schedule::text,
        j.command::text,
        j.active,
        (j.jobname = ANY ($1)) AS is_expected,
        l.last_run,
        l.last_status::text,
        l.last_duration_ms,
        l.last_error,
        COALESCE(r.runs_24h, 0) AS runs_24h,
        COALESCE(r.failures_24h, 0) AS failures_24h
      FROM cron.job j
      LEFT JOIN latest l ON l.jobid = j.jobid
      LEFT JOIN rollup r ON r.jobid = j.jobid
      ORDER BY j.jobname
    $q$ USING v_expected;
  ELSE
    -- cron.job readable but run_details not — return jobs without history.
    RETURN QUERY EXECUTE $q$
      SELECT
        j.jobid::bigint,
        j.jobname::text,
        j.schedule::text,
        j.command::text,
        j.active,
        (j.jobname = ANY ($1)) AS is_expected,
        NULL::timestamptz AS last_run,
        NULL::text        AS last_status,
        NULL::integer     AS last_duration_ms,
        NULL::text        AS last_error,
        0::integer        AS runs_24h,
        0::integer        AS failures_24h
      FROM cron.job j
      ORDER BY j.jobname
    $q$ USING v_expected;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION get_cron_job_health() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Missing expected jobs (drift detector)
-- Returns the names of schedules declared by migration 044 that are
-- not currently present in cron.job. Empty result == healthy.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_missing_expected_cron_jobs()
RETURNS TABLE (jobname text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_schema_present boolean := false;
  v_expected text[] := ARRAY[
    'reap_expired_job_leases_1m',
    'mark_stale_workers_crashed_2m',
    'refresh_ranked_feeds_5m',
    'process_pending_personalization_1m',
    'refresh_active_personalized_15m',
    'cleanup_job_queue_daily',
    'cleanup_job_dead_letter_weekly',
    'cleanup_notification_events_daily',
    'cleanup_notification_deliveries_d',
    'cleanup_worker_heartbeats_daily',
    'cleanup_personalized_feeds_daily'
  ];
BEGIN
  IF coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin'
     AND current_user <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
  ) INTO v_schema_present;

  IF NOT v_schema_present THEN
    -- pg_cron missing: every expected job is "missing".
    RETURN QUERY SELECT unnest(v_expected);
    RETURN;
  END IF;

  RETURN QUERY EXECUTE $q$
    SELECT e.name::text AS jobname
    FROM unnest($1::text[]) AS e(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM cron.job j WHERE j.jobname = e.name
    )
    ORDER BY e.name
  $q$ USING v_expected;
EXCEPTION WHEN OTHERS THEN
  -- cron schema present but unreadable: treat as all-missing so the
  -- dashboard surfaces the permission gap.
  RETURN QUERY SELECT unnest(v_expected);
END;
$$;

GRANT EXECUTE ON FUNCTION get_missing_expected_cron_jobs() TO authenticated, service_role;

RESET ROLE;
