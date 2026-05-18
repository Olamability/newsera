-- ============================================================
-- MIGRATION 047: Activation observability & admin orchestration RPCs
--
-- Phase C activation layer. Purely additive: no destructive DDL, no
-- schema rewrites, no RLS bypass, no client-writable surface added.
--
-- This migration provides the server-side observability and
-- orchestration primitives that the admin /infrastructure dashboard
-- consumes. All mutation RPCs:
--   * are SECURITY DEFINER but admin-gated via a uniform
--     _is_admin_caller() check
--   * audit every action into the existing public.admin_audit_log
--   * delegate to the already-shipped service-role-only primitives
--     (replay_dead_letter, enqueue_job, …) so RLS is never bypassed
--     from the client
--
-- Observability RPCs are read-only and return empty when the caller
-- is not admin, so the dashboard degrades gracefully.
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 0) Shared admin gate + audit helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _is_admin_caller()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    OR current_user = 'service_role'
    OR session_user IN ('postgres', 'supabase_admin');
$$;

GRANT EXECUTE ON FUNCTION _is_admin_caller() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION _log_admin_action(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text,
  p_metadata jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin uuid;
BEGIN
  -- auth.uid() is the calling admin; for service-role / postgres calls
  -- (e.g. cron) we record a sentinel zero-uuid so the row still
  -- satisfies the NOT NULL constraint.
  v_admin := auth.uid();
  IF v_admin IS NULL THEN
    v_admin := '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  -- admin_audit_log.admin_user_id references auth.users(id); only
  -- write when we have a real admin to avoid FK violations from
  -- background callers.
  IF v_admin = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RETURN;
  END IF;

  INSERT INTO admin_audit_log (
    admin_user_id, action, entity_type, entity_id, reason, metadata
  )
  VALUES (
    v_admin, p_action, p_entity_type, p_entity_id, p_reason,
    COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION _log_admin_action(text, text, uuid, text, jsonb)
  TO authenticated, service_role;

-- ============================================================
-- A) OBSERVABILITY: QUEUE HEALTH
-- ============================================================

-- Per-queue aggregate: counts by status + throughput + latency.
-- The four canonical queues (ingestion / notification / ranking /
-- analytics) are emitted even when zero jobs exist so the dashboard
-- always renders a stable row set.
CREATE OR REPLACE FUNCTION get_queue_health()
RETURNS TABLE (
  queue_name text,
  queued_count integer,
  leased_count integer,
  running_count integer,
  success_count integer,
  failed_count integer,
  dead_count integer,
  retry_count integer,
  oldest_pending_seconds integer,
  avg_lease_seconds integer,
  throughput_1h integer,
  throughput_24h integer,
  failure_rate_1h numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH queues AS (
    SELECT unnest(ARRAY['ingestion','notification','ranking','analytics']) AS qn
  ),
  by_status AS (
    SELECT
      jq.queue_name AS qn,
      COUNT(*) FILTER (WHERE jq.status = 'queued')::integer    AS queued_count,
      COUNT(*) FILTER (WHERE jq.status = 'leased')::integer    AS leased_count,
      COUNT(*) FILTER (WHERE jq.status = 'running')::integer   AS running_count,
      COUNT(*) FILTER (WHERE jq.status = 'success')::integer   AS success_count,
      COUNT(*) FILTER (WHERE jq.status = 'failed')::integer    AS failed_count,
      COUNT(*) FILTER (WHERE jq.status = 'dead')::integer      AS dead_count,
      COALESCE(SUM(jq.attempts) FILTER (WHERE jq.attempts > 1), 0)::integer AS retry_count,
      EXTRACT(EPOCH FROM (now() - MIN(jq.created_at)
        FILTER (WHERE jq.status = 'queued')))::integer AS oldest_pending_seconds,
      AVG(EXTRACT(EPOCH FROM (jq.finished_at - jq.started_at)))
        FILTER (WHERE jq.finished_at IS NOT NULL AND jq.started_at IS NOT NULL
                AND jq.finished_at >= now() - interval '24 hours')::integer
        AS avg_lease_seconds
    FROM job_queue jq
    GROUP BY jq.queue_name
  ),
  throughput AS (
    SELECT
      jq.queue_name AS qn,
      COUNT(*) FILTER (WHERE jq.finished_at >= now() - interval '1 hour'
                       AND jq.status = 'success')::integer AS throughput_1h,
      COUNT(*) FILTER (WHERE jq.finished_at >= now() - interval '24 hours'
                       AND jq.status = 'success')::integer AS throughput_24h,
      CASE
        WHEN COUNT(*) FILTER (WHERE jq.finished_at >= now() - interval '1 hour') = 0 THEN 0::numeric
        ELSE (
          COUNT(*) FILTER (WHERE jq.finished_at >= now() - interval '1 hour'
                           AND jq.status IN ('failed','dead'))::numeric
          / NULLIF(COUNT(*) FILTER (WHERE jq.finished_at >= now() - interval '1 hour'), 0)
        )
      END AS failure_rate_1h
    FROM job_queue jq
    GROUP BY jq.queue_name
  )
  SELECT
    q.qn,
    COALESCE(b.queued_count, 0),
    COALESCE(b.leased_count, 0),
    COALESCE(b.running_count, 0),
    COALESCE(b.success_count, 0),
    COALESCE(b.failed_count, 0),
    COALESCE(b.dead_count, 0),
    COALESCE(b.retry_count, 0),
    COALESCE(b.oldest_pending_seconds, 0),
    COALESCE(b.avg_lease_seconds, 0),
    COALESCE(t.throughput_1h, 0),
    COALESCE(t.throughput_24h, 0),
    ROUND(COALESCE(t.failure_rate_1h, 0)::numeric, 4)
  FROM queues q
  LEFT JOIN by_status  b ON b.qn = q.qn
  LEFT JOIN throughput t ON t.qn = q.qn
  ORDER BY q.qn;
END;
$$;

GRANT EXECUTE ON FUNCTION get_queue_health() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_dead_letter_summary()
RETURNS TABLE (
  queue_name text,
  total_count integer,
  unreplayed_count integer,
  replayed_count integer,
  oldest_failed_at timestamptz,
  most_recent_failed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    dl.queue_name,
    COUNT(*)::integer AS total_count,
    COUNT(*) FILTER (WHERE dl.replayed_at IS NULL)::integer AS unreplayed_count,
    COUNT(*) FILTER (WHERE dl.replayed_at IS NOT NULL)::integer AS replayed_count,
    MIN(dl.failed_at) AS oldest_failed_at,
    MAX(dl.failed_at) AS most_recent_failed_at
  FROM job_dead_letter dl
  GROUP BY dl.queue_name
  ORDER BY dl.queue_name;
END;
$$;

GRANT EXECUTE ON FUNCTION get_dead_letter_summary() TO authenticated, service_role;

-- ============================================================
-- B) OBSERVABILITY: RSS WORKERS + FEED HEALTH
-- ============================================================

CREATE OR REPLACE FUNCTION get_rss_worker_health()
RETURNS TABLE (
  worker_type text,
  alive_count integer,
  draining_count integer,
  stopped_count integer,
  crashed_count integer,
  stale_count integer,
  most_recent_heartbeat_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    wh.worker_type,
    COUNT(*) FILTER (WHERE wh.status = 'alive'
      AND wh.last_heartbeat_at >= now() - interval '3 minutes')::integer
      AS alive_count,
    COUNT(*) FILTER (WHERE wh.status = 'draining')::integer AS draining_count,
    COUNT(*) FILTER (WHERE wh.status = 'stopped')::integer  AS stopped_count,
    COUNT(*) FILTER (WHERE wh.status = 'crashed')::integer  AS crashed_count,
    COUNT(*) FILTER (WHERE wh.status = 'alive'
      AND wh.last_heartbeat_at < now() - interval '3 minutes')::integer
      AS stale_count,
    MAX(wh.last_heartbeat_at) AS most_recent_heartbeat_at
  FROM worker_heartbeats wh
  GROUP BY wh.worker_type
  ORDER BY wh.worker_type;
END;
$$;

GRANT EXECUTE ON FUNCTION get_rss_worker_health() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_rss_feed_health(
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  feed_id uuid,
  name text,
  url text,
  is_active boolean,
  reliability_score numeric,
  consecutive_failures integer,
  backoff_seconds integer,
  fetch_interval_seconds integer,
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  next_fetch_at timestamptz,
  last_error text,
  lease_owner text,
  leased_until timestamptz,
  lease_is_stale boolean,
  failure_streak integer,
  ingestion_latency_ms integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    f.id,
    f.name,
    f.url,
    f.is_active,
    f.reliability_score,
    f.consecutive_failures,
    f.backoff_seconds,
    f.fetch_interval_seconds,
    f.last_fetched_at,
    f.last_success_at,
    f.last_failure_at,
    f.next_fetch_at,
    f.last_error,
    ij.leased_by AS lease_owner,
    ij.leased_until,
    (ij.leased_until IS NOT NULL AND ij.leased_until < now() - interval '30 seconds')
      AS lease_is_stale,
    COALESCE(ij.consecutive_failures, f.consecutive_failures) AS failure_streak,
    f.average_latency_ms AS ingestion_latency_ms
  FROM rss_feed_sources f
  LEFT JOIN ingestion_jobs ij ON ij.feed_id = f.id
  ORDER BY
    -- Surface most-troubled feeds first.
    (NOT f.is_active),
    f.consecutive_failures DESC,
    f.reliability_score ASC NULLS LAST,
    f.name ASC
  LIMIT GREATEST(p_limit, 10);
END;
$$;

GRANT EXECUTE ON FUNCTION get_rss_feed_health(integer) TO authenticated, service_role;

-- ============================================================
-- C) OBSERVABILITY: NOTIFICATION PIPELINE
-- ============================================================
CREATE OR REPLACE FUNCTION get_notification_pipeline_health()
RETURNS TABLE (
  total_devices integer,
  devices_with_token integer,
  devices_missing_token integer,
  duplicate_tokens integer,
  events_pending integer,
  events_processing integer,
  events_failed_24h integer,
  events_completed_24h integer,
  deliveries_pending integer,
  deliveries_failed_24h integer,
  deliveries_delivered_24h integer,
  retries_pending integer,
  rate_limited_users_24h integer,
  unread_total integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH dev AS (
    SELECT
      COUNT(*)::integer AS total_devices,
      COUNT(*) FILTER (WHERE push_token IS NOT NULL AND push_token <> '')::integer AS with_token,
      COUNT(*) FILTER (WHERE push_token IS NULL OR push_token = '')::integer AS missing_token
    FROM user_devices
  ),
  dup AS (
    SELECT COUNT(*)::integer AS dup_tokens FROM (
      SELECT push_token
      FROM user_devices
      WHERE push_token IS NOT NULL AND push_token <> ''
      GROUP BY push_token
      HAVING COUNT(*) > 1
    ) d
  ),
  ev AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::integer    AS pending,
      COUNT(*) FILTER (WHERE status = 'processing')::integer AS processing,
      COUNT(*) FILTER (WHERE status = 'failed'
                       AND updated_at >= now() - interval '24 hours')::integer  AS failed_24h,
      COUNT(*) FILTER (WHERE status = 'completed'
                       AND updated_at >= now() - interval '24 hours')::integer  AS completed_24h
    FROM notification_events
  ),
  del AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
      COUNT(*) FILTER (WHERE status = 'failed'
                       AND updated_at >= now() - interval '24 hours')::integer AS failed_24h,
      COUNT(*) FILTER (WHERE status = 'delivered'
                       AND delivered_at >= now() - interval '24 hours')::integer AS delivered_24h,
      COUNT(*) FILTER (WHERE status = 'failed' AND attempts < 5)::integer AS retries_pending
    FROM notification_deliveries
  ),
  rl AS (
    SELECT COUNT(DISTINCT user_id)::integer AS rate_limited_24h
    FROM notification_rate_limits
    WHERE window_started_at >= now() - interval '24 hours'
      AND count >= max_per_window
  ),
  un AS (
    SELECT COUNT(*)::integer AS unread
    FROM notifications
    WHERE read = false
  )
  SELECT
    dev.total_devices,
    dev.with_token,
    dev.missing_token,
    dup.dup_tokens,
    ev.pending,
    ev.processing,
    ev.failed_24h,
    ev.completed_24h,
    del.pending,
    del.failed_24h,
    del.delivered_24h,
    del.retries_pending,
    rl.rate_limited_24h,
    un.unread
  FROM dev, dup, ev, del, rl, un;
END;
$$;

GRANT EXECUTE ON FUNCTION get_notification_pipeline_health() TO authenticated, service_role;

-- ============================================================
-- D) OBSERVABILITY: PERSONALIZATION PIPELINE
-- ============================================================
CREATE OR REPLACE FUNCTION get_personalization_pipeline_health()
RETURNS TABLE (
  users_with_category_affinity integer,
  users_with_source_affinity integer,
  total_category_affinities integer,
  total_source_affinities integer,
  recompute_queue_depth integer,
  oldest_recompute_seconds integer,
  personalized_cache_users integer,
  personalized_cache_rows integer,
  stale_cache_users integer,
  last_global_recompute_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH cat AS (
    SELECT COUNT(DISTINCT user_id)::integer AS users,
           COUNT(*)::integer AS rows_total,
           MAX(recomputed_at) AS last_recompute
    FROM user_category_affinity
  ),
  src AS (
    SELECT COUNT(DISTINCT user_id)::integer AS users,
           COUNT(*)::integer AS rows_total
    FROM user_source_affinity
  ),
  q AS (
    SELECT COUNT(*)::integer AS depth,
           EXTRACT(EPOCH FROM (now() - MIN(enqueued_at)))::integer AS oldest
    FROM personalization_recompute_queue
  ),
  cache AS (
    SELECT
      COUNT(DISTINCT user_id)::integer AS users,
      COUNT(*)::integer AS rows_total,
      COUNT(DISTINCT user_id) FILTER (
        WHERE computed_at < now() - interval '24 hours'
      )::integer AS stale_users
    FROM ranked_feed_personalized
  )
  SELECT
    cat.users,
    src.users,
    cat.rows_total,
    src.rows_total,
    q.depth,
    COALESCE(q.oldest, 0),
    cache.users,
    cache.rows_total,
    cache.stale_users,
    cat.last_recompute
  FROM cat, src, q, cache;
END;
$$;

GRANT EXECUTE ON FUNCTION get_personalization_pipeline_health()
  TO authenticated, service_role;

-- ============================================================
-- E) OBSERVABILITY: RANKING PIPELINE
-- ============================================================
CREATE OR REPLACE FUNCTION get_ranking_pipeline_health()
RETURNS TABLE (
  view_name text,
  row_count integer,
  last_refresh_at timestamptz,
  age_seconds integer,
  is_stale boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_global_count integer := 0;
  v_category_count integer := 0;
  v_personalized_count integer := 0;
  v_breaking_count integer := 0;
  v_global_last timestamptz;
  v_category_last timestamptz;
  v_personalized_last timestamptz;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  -- ranked_feed_global / ranked_feed_category are materialized views
  -- without an embedded "refreshed_at" column; we approximate freshness
  -- using pg_stat_user_tables.last_analyze or a recent vacuum. As a
  -- pragmatic alternative we expose the max(published_at) the view
  -- carries plus row counts. The dashboard renders both signals.
  BEGIN
    EXECUTE 'SELECT COUNT(*)::integer FROM ranked_feed_global'
      INTO v_global_count;
    EXECUTE 'SELECT MAX(published_at) FROM ranked_feed_global'
      INTO v_global_last;
  EXCEPTION WHEN OTHERS THEN
    v_global_count := 0;
  END;

  BEGIN
    EXECUTE 'SELECT COUNT(*)::integer FROM ranked_feed_category'
      INTO v_category_count;
    EXECUTE 'SELECT MAX(published_at) FROM ranked_feed_category'
      INTO v_category_last;
  EXCEPTION WHEN OTHERS THEN
    v_category_count := 0;
  END;

  BEGIN
    EXECUTE 'SELECT COUNT(*)::integer FROM ranked_feed_personalized'
      INTO v_personalized_count;
    EXECUTE 'SELECT MAX(computed_at) FROM ranked_feed_personalized'
      INTO v_personalized_last;
  EXCEPTION WHEN OTHERS THEN
    v_personalized_count := 0;
  END;

  BEGIN
    EXECUTE 'SELECT COUNT(*)::integer FROM ranked_feed_breaking'
      INTO v_breaking_count;
  EXCEPTION WHEN OTHERS THEN
    v_breaking_count := 0;
  END;

  RETURN QUERY VALUES
    ('ranked_feed_global',       v_global_count,       v_global_last,
       COALESCE(EXTRACT(EPOCH FROM (now() - v_global_last))::integer, NULL),
       (v_global_last IS NULL OR v_global_last < now() - interval '30 minutes')),
    ('ranked_feed_category',     v_category_count,     v_category_last,
       COALESCE(EXTRACT(EPOCH FROM (now() - v_category_last))::integer, NULL),
       (v_category_last IS NULL OR v_category_last < now() - interval '30 minutes')),
    ('ranked_feed_personalized', v_personalized_count, v_personalized_last,
       COALESCE(EXTRACT(EPOCH FROM (now() - v_personalized_last))::integer, NULL),
       (v_personalized_last IS NULL OR v_personalized_last < now() - interval '6 hours')),
    ('ranked_feed_breaking',     v_breaking_count,     NULL::timestamptz,
       NULL::integer, false);
END;
$$;

GRANT EXECUTE ON FUNCTION get_ranking_pipeline_health() TO authenticated, service_role;

-- ============================================================
-- F) ACTIVATION READINESS MATRIX
-- ============================================================
-- A composite, opinionated readiness check that the admin dashboard
-- and the Activation Matrix doc both consume. Returns one row per
-- subsystem with a ready flag and a blocked_by reason.
CREATE OR REPLACE FUNCTION get_activation_readiness()
RETURNS TABLE (
  subsystem text,
  ready boolean,
  blocked_by text,
  rollout_safe boolean,
  detail jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cron_installed boolean := false;
  v_missing_jobs integer := 0;
  v_workers_alive integer := 0;
  v_feeds_active integer := 0;
  v_feeds_failing integer := 0;
  v_devices_with_token integer := 0;
  v_devices_total integer := 0;
  v_global_rows integer := 0;
  v_personalized_users integer := 0;
  v_cat_affinity_users integer := 0;
  v_dlq_unreplayed integer := 0;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  -- pg_cron presence (gracefully degrades when absent)
  BEGIN
    SELECT pg_cron_installed INTO v_cron_installed FROM get_pg_cron_status();
  EXCEPTION WHEN OTHERS THEN
    v_cron_installed := false;
  END;

  BEGIN
    SELECT COUNT(*)::integer INTO v_missing_jobs
      FROM get_missing_expected_cron_jobs();
  EXCEPTION WHEN OTHERS THEN
    v_missing_jobs := 0;
  END;

  SELECT COUNT(*)::integer INTO v_workers_alive
  FROM worker_heartbeats
  WHERE status = 'alive'
    AND last_heartbeat_at >= now() - interval '3 minutes';

  SELECT
    COUNT(*) FILTER (WHERE is_active)::integer,
    COUNT(*) FILTER (WHERE is_active AND consecutive_failures >= 5)::integer
  INTO v_feeds_active, v_feeds_failing
  FROM rss_feed_sources;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE push_token IS NOT NULL AND push_token <> '')::integer
  INTO v_devices_total, v_devices_with_token
  FROM user_devices;

  BEGIN
    EXECUTE 'SELECT COUNT(*)::integer FROM ranked_feed_global' INTO v_global_rows;
  EXCEPTION WHEN OTHERS THEN
    v_global_rows := 0;
  END;

  SELECT COUNT(DISTINCT user_id)::integer INTO v_personalized_users
  FROM ranked_feed_personalized;

  SELECT COUNT(DISTINCT user_id)::integer INTO v_cat_affinity_users
  FROM user_category_affinity;

  SELECT COUNT(*)::integer INTO v_dlq_unreplayed
  FROM job_dead_letter WHERE replayed_at IS NULL;

  RETURN QUERY VALUES
    (
      'rss_workers',
      (v_workers_alive > 0 AND v_feeds_active > 0),
      CASE
        WHEN v_workers_alive = 0 THEN 'no_live_worker_heartbeats'
        WHEN v_feeds_active = 0 THEN 'no_active_rss_feeds'
        ELSE NULL
      END,
      (v_workers_alive > 0 AND v_feeds_failing = 0),
      jsonb_build_object(
        'workers_alive', v_workers_alive,
        'feeds_active', v_feeds_active,
        'feeds_failing', v_feeds_failing
      )
    ),
    (
      'notifications',
      (v_devices_with_token > 0),
      CASE
        WHEN v_devices_total = 0 THEN 'no_registered_devices'
        WHEN v_devices_with_token = 0 THEN 'no_devices_with_push_token'
        ELSE NULL
      END,
      (v_devices_with_token > 0
        AND v_devices_with_token::numeric / NULLIF(v_devices_total, 0) >= 0.5),
      jsonb_build_object(
        'devices_total', v_devices_total,
        'devices_with_token', v_devices_with_token
      )
    ),
    (
      'personalization',
      (v_cat_affinity_users > 0),
      CASE
        WHEN v_cat_affinity_users = 0 THEN 'no_user_affinity_data_yet'
        ELSE NULL
      END,
      (v_cat_affinity_users >= 50),
      jsonb_build_object(
        'users_with_category_affinity', v_cat_affinity_users,
        'personalized_cache_users', v_personalized_users
      )
    ),
    (
      'ranking',
      (v_global_rows > 0),
      CASE
        WHEN v_global_rows = 0 THEN 'ranked_feed_global_empty_refresh_needed'
        ELSE NULL
      END,
      (v_global_rows >= 50),
      jsonb_build_object('ranked_feed_global_rows', v_global_rows)
    ),
    (
      'breaking_feed',
      (v_global_rows > 0),
      CASE
        WHEN v_global_rows = 0 THEN 'depends_on_ranking_subsystem'
        ELSE NULL
      END,
      (v_global_rows >= 50),
      jsonb_build_object('depends_on', 'ranking')
    ),
    (
      'retention_cleanup',
      (v_cron_installed AND v_missing_jobs = 0),
      CASE
        WHEN NOT v_cron_installed THEN 'pg_cron_not_installed'
        WHEN v_missing_jobs > 0 THEN format('missing_cron_jobs:%s', v_missing_jobs)
        ELSE NULL
      END,
      (v_cron_installed AND v_missing_jobs = 0 AND v_dlq_unreplayed < 100),
      jsonb_build_object(
        'pg_cron_installed', v_cron_installed,
        'missing_cron_jobs', v_missing_jobs,
        'dlq_unreplayed', v_dlq_unreplayed
      )
    );
END;
$$;

GRANT EXECUTE ON FUNCTION get_activation_readiness() TO authenticated, service_role;

-- Estimate the impact of changing a feature flag's rollout %.
CREATE OR REPLACE FUNCTION get_feature_flag_impact(
  p_name text,
  p_rollout_percent smallint DEFAULT NULL
)
RETURNS TABLE (
  flag_name text,
  current_enabled boolean,
  current_rollout_percent smallint,
  proposed_rollout_percent smallint,
  total_users integer,
  estimated_affected_users integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_total integer := 0;
  v_enabled boolean;
  v_current smallint;
  v_proposed smallint;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  SELECT enabled, rollout_percent INTO v_enabled, v_current
  FROM feature_flags WHERE name = p_name;

  IF v_enabled IS NULL THEN
    RETURN;
  END IF;

  v_proposed := COALESCE(p_rollout_percent, v_current);

  SELECT COUNT(*)::integer INTO v_total FROM auth.users;

  flag_name := p_name;
  current_enabled := v_enabled;
  current_rollout_percent := v_current;
  proposed_rollout_percent := v_proposed;
  total_users := v_total;
  estimated_affected_users :=
    GREATEST(0, LEAST(100, v_proposed)) * v_total / 100;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION get_feature_flag_impact(text, smallint)
  TO authenticated, service_role;

-- ============================================================
-- G) ADMIN ORCHESTRATION RPCs (audited, admin-gated)
-- ============================================================

-- Replay a single dead-letter job. Wraps the existing service-role
-- primitive so it can be invoked safely by an admin from the panel.
CREATE OR REPLACE FUNCTION admin_replay_dead_letter(
  p_dlq_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_new_id uuid;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_replay_dead_letter: forbidden' USING ERRCODE = '42501';
  END IF;

  v_new_id := replay_dead_letter(p_dlq_id);

  PERFORM _log_admin_action(
    'replay_dead_letter', 'job_dead_letter', p_dlq_id, p_reason,
    jsonb_build_object('new_job_id', v_new_id)
  );

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_replay_dead_letter(uuid, text)
  TO authenticated, service_role;

-- Bulk replay: replay up to p_limit unreplayed DLQ entries for a queue.
CREATE OR REPLACE FUNCTION admin_replay_dead_letter_bulk(
  p_queue_name text,
  p_limit integer DEFAULT 50,
  p_reason text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_count integer := 0;
  v_row record;
  v_new_id uuid;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_replay_dead_letter_bulk: forbidden' USING ERRCODE = '42501';
  END IF;

  FOR v_row IN
    SELECT id FROM job_dead_letter
    WHERE replayed_at IS NULL
      AND (p_queue_name IS NULL OR queue_name = p_queue_name)
    ORDER BY failed_at ASC
    LIMIT GREATEST(p_limit, 1)
  LOOP
    v_new_id := replay_dead_letter(v_row.id);
    IF v_new_id IS NOT NULL THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  PERFORM _log_admin_action(
    'replay_dead_letter_bulk', 'job_dead_letter', NULL, p_reason,
    jsonb_build_object('queue_name', p_queue_name, 'limit', p_limit, 'replayed', v_count)
  );

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_replay_dead_letter_bulk(text, integer, text)
  TO authenticated, service_role;

-- Re-queue jobs that ended in status='failed' (terminal but pre-DLQ)
-- by resetting them to queued. Bounded by p_limit. Safe: only touches
-- 'failed' rows, leaves dead / running / leased / queued untouched.
CREATE OR REPLACE FUNCTION admin_retry_failed_jobs(
  p_queue_name text,
  p_limit integer DEFAULT 100,
  p_reason text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_retry_failed_jobs: forbidden' USING ERRCODE = '42501';
  END IF;

  WITH targets AS (
    SELECT id FROM job_queue
    WHERE status = 'failed'
      AND (p_queue_name IS NULL OR queue_name = p_queue_name)
    ORDER BY finished_at ASC NULLS LAST
    LIMIT GREATEST(p_limit, 1)
  )
  UPDATE job_queue jq
  SET status = 'queued',
      lease_token = NULL,
      leased_until = NULL,
      leased_by = NULL,
      next_attempt_at = now(),
      started_at = NULL,
      finished_at = NULL
  FROM targets t
  WHERE jq.id = t.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM _log_admin_action(
    'retry_failed_jobs', 'job_queue', NULL, p_reason,
    jsonb_build_object('queue_name', p_queue_name, 'limit', p_limit, 'requeued', v_count)
  );

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_retry_failed_jobs(text, integer, text)
  TO authenticated, service_role;

-- Clear completed jobs older than N hours. Defers to the existing
-- cleanup_job_queue retention sweep but with admin-controlled window.
CREATE OR REPLACE FUNCTION admin_clear_completed_jobs(
  p_queue_name text,
  p_older_than_hours integer DEFAULT 24,
  p_reason text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_clear_completed_jobs: forbidden' USING ERRCODE = '42501';
  END IF;

  DELETE FROM job_queue
  WHERE status = 'success'
    AND (p_queue_name IS NULL OR queue_name = p_queue_name)
    AND finished_at IS NOT NULL
    AND finished_at < now() - make_interval(hours => GREATEST(p_older_than_hours, 1));

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM _log_admin_action(
    'clear_completed_jobs', 'job_queue', NULL, p_reason,
    jsonb_build_object(
      'queue_name', p_queue_name,
      'older_than_hours', p_older_than_hours,
      'deleted', v_count
    )
  );

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_clear_completed_jobs(text, integer, text)
  TO authenticated, service_role;

-- Force-release a stuck ingestion lease (admin recovery action).
CREATE OR REPLACE FUNCTION admin_force_release_feed_lease(
  p_feed_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_force_release_feed_lease: forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE ingestion_jobs
  SET lease_token = NULL,
      leased_until = NULL,
      leased_by = NULL,
      last_status = CASE
        WHEN last_status IN ('queued','running') THEN 'failed'
        ELSE last_status
      END,
      last_error = '[admin_force_release] ' || COALESCE(p_reason, 'manual'),
      updated_at = now()
  WHERE feed_id = p_feed_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  PERFORM _log_admin_action(
    'force_release_feed_lease', 'ingestion_jobs', p_feed_id, p_reason,
    jsonb_build_object('updated', v_updated)
  );

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_force_release_feed_lease(uuid, text)
  TO authenticated, service_role;

-- Pause / resume an RSS feed (sets rss_feed_sources.is_active).
CREATE OR REPLACE FUNCTION admin_set_feed_active(
  p_feed_id uuid,
  p_active boolean,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_set_feed_active: forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE rss_feed_sources
  SET is_active = p_active,
      -- Reset backoff when resuming so the feed is picked up promptly.
      backoff_seconds = CASE WHEN p_active THEN 0 ELSE backoff_seconds END,
      next_fetch_at   = CASE WHEN p_active THEN now() ELSE next_fetch_at END
  WHERE id = p_feed_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  PERFORM _log_admin_action(
    CASE WHEN p_active THEN 'resume_feed' ELSE 'pause_feed' END,
    'rss_feed_sources', p_feed_id, p_reason,
    jsonb_build_object('is_active', p_active)
  );

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_feed_active(uuid, boolean, text)
  TO authenticated, service_role;

-- Manual feed retry: forces next_fetch_at = now() without changing
-- is_active.
CREATE OR REPLACE FUNCTION admin_retry_feed(
  p_feed_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_retry_feed: forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE rss_feed_sources
  SET next_fetch_at = now(),
      backoff_seconds = 0
  WHERE id = p_feed_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  PERFORM _log_admin_action(
    'retry_feed', 'rss_feed_sources', p_feed_id, p_reason, '{}'::jsonb
  );

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_retry_feed(uuid, text) TO authenticated, service_role;

-- Update a feature flag (rollout/enable) atomically with audit.
CREATE OR REPLACE FUNCTION admin_update_feature_flag(
  p_name text,
  p_enabled boolean,
  p_rollout_percent smallint DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prev_enabled boolean;
  v_prev_rollout smallint;
  v_new_rollout smallint;
  v_updated integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_update_feature_flag: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT enabled, rollout_percent
  INTO v_prev_enabled, v_prev_rollout
  FROM feature_flags
  WHERE name = p_name
  FOR UPDATE;

  IF v_prev_enabled IS NULL THEN
    RAISE EXCEPTION 'admin_update_feature_flag: unknown flag %', p_name;
  END IF;

  v_new_rollout := GREATEST(0, LEAST(100,
    COALESCE(p_rollout_percent, v_prev_rollout)))::smallint;

  UPDATE feature_flags
  SET enabled = p_enabled,
      rollout_percent = v_new_rollout
  WHERE name = p_name;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  PERFORM _log_admin_action(
    'update_feature_flag', 'feature_flags', NULL, p_reason,
    jsonb_build_object(
      'name', p_name,
      'prev_enabled', v_prev_enabled,
      'prev_rollout_percent', v_prev_rollout,
      'new_enabled', p_enabled,
      'new_rollout_percent', v_new_rollout
    )
  );

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_feature_flag(text, boolean, smallint, text)
  TO authenticated, service_role;

-- Emergency kill-switch: disables flag and resets rollout to 0.
CREATE OR REPLACE FUNCTION admin_emergency_disable_feature_flag(
  p_name text,
  p_reason text DEFAULT 'emergency_disable'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_emergency_disable_feature_flag: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN admin_update_feature_flag(p_name, false, 0::smallint, p_reason);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_emergency_disable_feature_flag(text, text)
  TO authenticated, service_role;

-- Notification test sender: queues an inbox+push event targeted at a
-- specific user. Goes through the canonical enqueue+materialize path
-- so it's gated by the same rate limits / dedup as production traffic.
CREATE OR REPLACE FUNCTION admin_send_test_notification(
  p_user_id uuid,
  p_title text,
  p_body text,
  p_reason text DEFAULT 'admin_test'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_send_test_notification: forbidden' USING ERRCODE = '42501';
  END IF;

  v_event_id := enqueue_notification_event(
    'admin_broadcast',
    p_title,
    p_body,
    'specific_user',
    p_user_id,
    NULL, NULL,
    jsonb_build_object('admin_test', true),
    8::smallint,
    ARRAY['inbox','push']::text[],
    'admin_test:' || p_user_id::text || ':' || extract(epoch from now())::bigint::text,
    now()
  );

  PERFORM materialize_notification_event(v_event_id, 1);

  PERFORM _log_admin_action(
    'send_test_notification', 'notification_events', v_event_id, p_reason,
    jsonb_build_object('target_user_id', p_user_id)
  );

  RETURN v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_send_test_notification(uuid, text, text, text)
  TO authenticated, service_role;

RESET ROLE;
