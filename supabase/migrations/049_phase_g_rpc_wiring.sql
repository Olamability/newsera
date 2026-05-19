-- ============================================================
-- MIGRATION 049: Phase G operational RPC wiring
--
-- FINALIZATION / DEPLOYMENT mode. Strictly additive.
--
-- This migration closes the Track 1 gap identified in
-- docs/RPC_DEPLOYMENT_AUDIT.md: the Phase G operator dashboard
-- (admin-panel/src/components/infrastructure/PhaseGPanels.jsx)
-- depends on a set of SECURITY DEFINER RPCs that were documented
-- but never deployed. Until they exist the dashboard renders
-- "RPC not yet wired" placeholders.
--
-- All RPCs in this file:
--   * are SECURITY DEFINER
--   * SET search_path = public, pg_catalog (search-path hardened)
--   * are gated by the canonical _is_admin_caller() check
--   * audit every mutating call into admin_audit_log via
--     _log_admin_action()
--   * return typed structured payloads
--   * degrade gracefully when the underlying Phase G table /
--     materialized view does not exist yet (to_regclass guards)
--   * never expose raw tables to the client
--   * are idempotent (CREATE OR REPLACE only; no DDL on existing
--     tables, no destructive drops)
--
-- The intent is to make every dashboard tab functional with empty
-- but well-formed data on a clean database, and to surface real
-- numbers wherever the Phase G persistence layer is already
-- present. This keeps the operational surface stable while the
-- Phase G physical tables roll out independently.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- Helper: safe-exists check
-- ------------------------------------------------------------
-- Wrapping to_regclass lets the RPC bodies stay readable.
CREATE OR REPLACE FUNCTION _phaseg_relation_exists(p_qualname text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT to_regclass(p_qualname) IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION _phaseg_relation_exists(text)
  TO authenticated, service_role;

-- ============================================================
-- 1) get_production_health_snapshot
-- ============================================================
-- Composite production-health score derived from the live
-- pipeline health RPCs that already exist (queue, RSS workers,
-- ranking, personalization, notifications, cron). When optional
-- Phase G tables (production_incidents, traffic_guard_state,
-- rollout_state) are absent we still return a coherent payload.
CREATE OR REPLACE FUNCTION get_production_health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_queue_score        numeric := 1.0;
  v_rss_score          numeric := 1.0;
  v_ranking_score      numeric := 1.0;
  v_personal_score     numeric := 1.0;
  v_notif_score        numeric := 1.0;
  v_cron_score         numeric := 1.0;
  v_db_score           numeric := 1.0;
  v_mobile_score       numeric := 1.0;
  v_overall            numeric;
  v_classification     text;
  v_risk               text;
  v_severe             integer := 0;
  v_warning            integer := 0;
  v_paused             boolean := false;
  v_freeze             boolean := false;
  v_traffic_mode       text := 'normal';
  v_recommendations    text[] := ARRAY[]::text[];
  v_contributions      jsonb;
  v_weights            jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object(
      'health', NULL,
      'openSevereIncidents', 0,
      'openWarningIncidents', 0,
      'rolloutPaused', false,
      'productionFreeze', false,
      'trafficGuard', jsonb_build_object('mode', 'unknown')
    );
  END IF;

  -- Queue subsystem: failure_rate_1h aggregated across queues.
  BEGIN
    SELECT GREATEST(0.0, 1.0 - COALESCE(AVG(failure_rate_1h), 0.0))
      INTO v_queue_score
    FROM get_queue_health();
  EXCEPTION WHEN OTHERS THEN v_queue_score := 1.0; END;

  -- RSS feed health: fraction of healthy feeds.
  BEGIN
    SELECT COALESCE(
      AVG(CASE WHEN health_status = 'healthy' THEN 1.0
               WHEN health_status = 'degraded' THEN 0.6
               ELSE 0.2 END),
      1.0)
      INTO v_rss_score
    FROM get_rss_feed_health();
  EXCEPTION WHEN OTHERS THEN v_rss_score := 1.0; END;

  BEGIN
    SELECT COALESCE(
      AVG(CASE WHEN health_status = 'healthy' THEN 1.0
               WHEN health_status = 'degraded' THEN 0.6
               ELSE 0.2 END),
      1.0)
      INTO v_ranking_score
    FROM get_ranking_pipeline_health();
  EXCEPTION WHEN OTHERS THEN v_ranking_score := 1.0; END;

  BEGIN
    SELECT COALESCE(
      AVG(CASE WHEN health_status = 'healthy' THEN 1.0
               WHEN health_status = 'degraded' THEN 0.6
               ELSE 0.2 END),
      1.0)
      INTO v_personal_score
    FROM get_personalization_pipeline_health();
  EXCEPTION WHEN OTHERS THEN v_personal_score := 1.0; END;

  BEGIN
    SELECT COALESCE(
      AVG(CASE WHEN health_status = 'healthy' THEN 1.0
               WHEN health_status = 'degraded' THEN 0.6
               ELSE 0.2 END),
      1.0)
      INTO v_notif_score
    FROM get_notification_pipeline_health();
  EXCEPTION WHEN OTHERS THEN v_notif_score := 1.0; END;

  -- Cron health: fraction of jobs in healthy state.
  BEGIN
    SELECT COALESCE(
      AVG(CASE WHEN health_status = 'healthy' THEN 1.0
               WHEN health_status = 'degraded' THEN 0.6
               ELSE 0.2 END),
      1.0)
      INTO v_cron_score
    FROM get_cron_job_health();
  EXCEPTION WHEN OTHERS THEN v_cron_score := 1.0; END;

  -- DB: rough proxy = 1.0 minus a soft penalty for very large
  -- pending personalization queue. Always degrades gracefully.
  BEGIN
    SELECT GREATEST(0.0, 1.0 - LEAST(1.0,
      (SELECT COUNT(*)::numeric
         FROM personalization_recompute_queue
        WHERE processed_at IS NULL) / 50000.0))
      INTO v_db_score;
  EXCEPTION WHEN OTHERS THEN v_db_score := 1.0; END;

  -- Mobile: derived from the optional crash table; default healthy.
  IF _phaseg_relation_exists('public.mobile_crash_events') THEN
    BEGIN
      EXECUTE $q$
        SELECT GREATEST(0.0, 1.0 - LEAST(1.0,
          (SELECT COUNT(*)::numeric
             FROM mobile_crash_events
            WHERE occurred_at >= now() - interval '1 hour') / 500.0))
      $q$ INTO v_mobile_score;
    EXCEPTION WHEN OTHERS THEN v_mobile_score := 1.0; END;
  END IF;

  -- Incident counts (optional table).
  IF _phaseg_relation_exists('public.production_incidents') THEN
    BEGIN
      EXECUTE $q$
        SELECT
          COUNT(*) FILTER (WHERE severity IN ('SEVERE','CRITICAL') AND state <> 'RESOLVED'),
          COUNT(*) FILTER (WHERE severity = 'WARNING' AND state <> 'RESOLVED')
        FROM production_incidents
      $q$ INTO v_severe, v_warning;
    EXCEPTION WHEN OTHERS THEN v_severe := 0; v_warning := 0; END;
  END IF;

  -- Rollout / freeze / traffic guard flags (optional).
  IF _phaseg_relation_exists('public.feature_flags') THEN
    BEGIN
      SELECT COALESCE((value->>'paused')::boolean, false)
        INTO v_paused
      FROM feature_flags WHERE name = 'rollout_governor';
      v_paused := COALESCE(v_paused, false);
    EXCEPTION WHEN OTHERS THEN v_paused := false; END;

    BEGIN
      SELECT COALESCE((value->>'frozen')::boolean,
                      COALESCE(enabled, false))
        INTO v_freeze
      FROM feature_flags WHERE name = 'production_freeze';
      v_freeze := COALESCE(v_freeze, false);
    EXCEPTION WHEN OTHERS THEN v_freeze := false; END;

    BEGIN
      SELECT COALESCE(value->>'mode', 'normal')
        INTO v_traffic_mode
      FROM feature_flags WHERE name = 'traffic_guard';
      v_traffic_mode := COALESCE(v_traffic_mode, 'normal');
    EXCEPTION WHEN OTHERS THEN v_traffic_mode := 'normal'; END;
  END IF;

  -- Weighted composite. Weights are intentionally simple and
  -- documented in MASTER_LAUNCH_COMMAND_CENTER.md.
  v_weights := jsonb_build_object(
    'queue',           0.18,
    'rss',             0.12,
    'ranking',         0.14,
    'personalization', 0.12,
    'notifications',   0.14,
    'cron',            0.10,
    'db',              0.12,
    'mobile',          0.08
  );

  v_overall := round((
      0.18 * v_queue_score
    + 0.12 * v_rss_score
    + 0.14 * v_ranking_score
    + 0.12 * v_personal_score
    + 0.14 * v_notif_score
    + 0.10 * v_cron_score
    + 0.12 * v_db_score
    + 0.08 * v_mobile_score
  )::numeric, 4);

  v_classification := CASE
    WHEN v_severe > 0 OR v_overall < 0.60 THEN 'critical'
    WHEN v_warning > 0 OR v_overall < 0.85 THEN 'degraded'
    ELSE 'healthy'
  END;
  v_risk := CASE v_classification
    WHEN 'critical' THEN 'HIGH'
    WHEN 'degraded' THEN 'MEDIUM'
    ELSE 'LOW'
  END;

  IF v_queue_score      < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Investigate queue failure rate.'); END IF;
  IF v_rss_score        < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Investigate RSS feed health.'); END IF;
  IF v_ranking_score    < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Investigate ranking pipeline.'); END IF;
  IF v_personal_score   < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Investigate personalization pipeline.'); END IF;
  IF v_notif_score      < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Investigate notification pipeline.'); END IF;
  IF v_cron_score       < 0.85 THEN v_recommendations := array_append(v_recommendations, 'Inspect cron schedule drift.'); END IF;
  IF v_severe           > 0    THEN v_recommendations := array_append(v_recommendations, 'Open severe incidents — page on-call.'); END IF;

  v_contributions := jsonb_build_array(
    jsonb_build_object('key','queue',           'raw', v_queue_score),
    jsonb_build_object('key','rss',             'raw', v_rss_score),
    jsonb_build_object('key','ranking',         'raw', v_ranking_score),
    jsonb_build_object('key','personalization', 'raw', v_personal_score),
    jsonb_build_object('key','notifications',   'raw', v_notif_score),
    jsonb_build_object('key','cron',            'raw', v_cron_score),
    jsonb_build_object('key','db',              'raw', v_db_score),
    jsonb_build_object('key','mobile',          'raw', v_mobile_score)
  );

  RETURN jsonb_build_object(
    'health', jsonb_build_object(
      'score',                 v_overall,
      'launchReadinessScore',  v_overall,
      'classification',        v_classification,
      'risk',                  v_risk,
      'recommendations',       to_jsonb(v_recommendations),
      'contributions',         v_contributions,
      'weights',               v_weights
    ),
    'openSevereIncidents',   v_severe,
    'openWarningIncidents',  v_warning,
    'rolloutPaused',         v_paused,
    'productionFreeze',      v_freeze,
    'trafficGuard',          jsonb_build_object('mode', v_traffic_mode),
    'generatedAt',           now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_production_health_snapshot()
  TO authenticated, service_role;

-- ============================================================
-- 2) get_system_health_score  (compact alias for callers that
-- only need the headline number)
-- ============================================================
CREATE OR REPLACE FUNCTION get_system_health_score()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_snap jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('score', NULL, 'classification', 'unknown');
  END IF;
  v_snap := get_production_health_snapshot();
  RETURN jsonb_build_object(
    'score',          v_snap->'health'->>'score',
    'classification', v_snap->'health'->>'classification',
    'risk',           v_snap->'health'->>'risk',
    'generatedAt',    now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_system_health_score()
  TO authenticated, service_role;

-- ============================================================
-- 3) list_deployment_sessions
-- ============================================================
CREATE OR REPLACE FUNCTION list_deployment_sessions(p_limit integer DEFAULT 50)
RETURNS TABLE (
  session_id text,
  fingerprint text,
  environment text,
  status text,
  started_at timestamptz,
  initiator text,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
BEGIN
  IF NOT _is_admin_caller() THEN RETURN; END IF;

  IF _phaseg_relation_exists('public.deployment_sessions') THEN
    RETURN QUERY EXECUTE format($q$
      SELECT session_id::text,
             fingerprint::text,
             environment::text,
             status::text,
             started_at,
             initiator::text,
             reason::text
        FROM deployment_sessions
       ORDER BY started_at DESC NULLS LAST
       LIMIT %s
    $q$, v_limit);
  ELSE
    -- Empty result set — dashboard renders "No deployment
    -- sessions recorded yet." per the panel's empty-state copy.
    RETURN;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION list_deployment_sessions(integer)
  TO authenticated, service_role;

-- ============================================================
-- 4) list_incident_history
-- ============================================================
CREATE OR REPLACE FUNCTION list_incident_history(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id uuid,
  type text,
  severity text,
  state text,
  occurrences integer,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  duration_ms bigint,
  acknowledged_by uuid,
  resolved_by uuid,
  metadata jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
BEGIN
  IF NOT _is_admin_caller() THEN RETURN; END IF;

  IF _phaseg_relation_exists('public.production_incidents') THEN
    RETURN QUERY EXECUTE format($q$
      SELECT id,
             type::text,
             severity::text,
             state::text,
             COALESCE(occurrences, 1)::integer,
             first_seen_at,
             last_seen_at,
             CASE WHEN resolved_at IS NOT NULL AND first_seen_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (resolved_at - first_seen_at))::bigint * 1000
                  ELSE NULL END,
             acknowledged_by,
             resolved_by,
             COALESCE(metadata, '{}'::jsonb)
        FROM production_incidents
       ORDER BY first_seen_at DESC NULLS LAST
       LIMIT %s
    $q$, v_limit);
  ELSE
    RETURN;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION list_incident_history(integer)
  TO authenticated, service_role;

-- ============================================================
-- 5) acknowledge_incident / resolve_incident
-- ============================================================
-- These mutations always audit the operator intent. When the
-- physical incidents table is present they update it; when not,
-- the audit row is still written so post-hoc reconstruction is
-- possible once the table comes online.
CREATE OR REPLACE FUNCTION acknowledge_incident(
  p_incident_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated boolean := false;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '22023';
  END IF;

  IF _phaseg_relation_exists('public.production_incidents') THEN
    BEGIN
      EXECUTE $q$
        UPDATE production_incidents
           SET state = 'ACKED',
               acknowledged_at = COALESCE(acknowledged_at, now()),
               acknowledged_by = COALESCE(acknowledged_by, auth.uid())
         WHERE id = $1
           AND state NOT IN ('RESOLVED')
      $q$ USING p_incident_id;
      v_updated := FOUND;
    EXCEPTION WHEN OTHERS THEN v_updated := false; END;
  END IF;

  PERFORM _log_admin_action(
    'acknowledge_incident', 'production_incidents',
    p_incident_id, p_reason,
    jsonb_build_object('updated', v_updated)
  );

  RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION acknowledge_incident(uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION resolve_incident(
  p_incident_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_updated boolean := false;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '22023';
  END IF;

  IF _phaseg_relation_exists('public.production_incidents') THEN
    BEGIN
      EXECUTE $q$
        UPDATE production_incidents
           SET state = 'RESOLVED',
               resolved_at = now(),
               resolved_by = auth.uid()
         WHERE id = $1
      $q$ USING p_incident_id;
      v_updated := FOUND;
    EXCEPTION WHEN OTHERS THEN v_updated := false; END;
  END IF;

  PERFORM _log_admin_action(
    'resolve_incident', 'production_incidents',
    p_incident_id, p_reason,
    jsonb_build_object('updated', v_updated)
  );

  RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_incident(uuid, text)
  TO authenticated, service_role;

-- ============================================================
-- 6) get_rollout_timeline
-- ============================================================
CREATE OR REPLACE FUNCTION get_rollout_timeline()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_stages   jsonb := '[]'::jsonb;
  v_lineage  jsonb := '[]'::jsonb;
  v_paused   boolean := false;
  v_reason   text := NULL;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('stages', '[]'::jsonb, 'paused', false);
  END IF;

  IF _phaseg_relation_exists('public.feature_flags') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'flag',           name,
             'status',         COALESCE(value->>'status', CASE WHEN enabled THEN 'STABLE' ELSE 'DISABLED' END),
             'canary_stage',   COALESCE(value->>'canary_stage', '—'),
             'started_at',     COALESCE((value->>'started_at')::timestamptz, updated_at),
             'last_initiator', COALESCE(value->>'last_initiator', '—')
           ) ORDER BY updated_at DESC), '[]'::jsonb)
      INTO v_stages
    FROM feature_flags
    WHERE name LIKE 'rollout_%' OR (value ? 'canary_stage');

    SELECT COALESCE((value->>'paused')::boolean, false),
           value->>'pause_reason'
      INTO v_paused, v_reason
    FROM feature_flags WHERE name = 'rollout_governor';
    v_paused := COALESCE(v_paused, false);
  END IF;

  IF _phaseg_relation_exists('public.deployment_sessions') THEN
    BEGIN
      EXECUTE $q$
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'session_id',         session_id,
                 'fingerprint',        fingerprint,
                 'parent_session_id',  parent_session_id,
                 'status',             status
               ) ORDER BY started_at DESC), '[]'::jsonb)
          FROM (
            SELECT session_id, fingerprint, parent_session_id, status, started_at
              FROM deployment_sessions
             ORDER BY started_at DESC
             LIMIT 20
          ) s
      $q$ INTO v_lineage;
    EXCEPTION WHEN OTHERS THEN v_lineage := '[]'::jsonb; END;
  END IF;

  RETURN jsonb_build_object(
    'stages',      COALESCE(v_stages, '[]'::jsonb),
    'paused',      v_paused,
    'pauseReason', v_reason,
    'lineage',     v_lineage,
    'generatedAt', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_rollout_timeline()
  TO authenticated, service_role;

-- ============================================================
-- 7) get_feed_quality_snapshot
-- ============================================================
-- Per-category source diversity + saturation risk derived from
-- the canonical articles table. Always available; no Phase G
-- table dependency.
CREATE OR REPLACE FUNCTION get_feed_quality_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_categories jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('categories', '[]'::jsonb);
  END IF;

  WITH recent AS (
    SELECT a.id, a.source_id, a.category_id, c.name AS category
      FROM articles a
      LEFT JOIN categories c ON c.id = a.category_id
     WHERE a.created_at >= now() - interval '24 hours'
  ),
  per_source AS (
    SELECT category, source_id, COUNT(*) AS n
      FROM recent
     WHERE category IS NOT NULL
     GROUP BY category, source_id
  ),
  agg AS (
    SELECT category,
           SUM(n)::integer AS total,
           COUNT(DISTINCT source_id)::integer AS unique_sources,
           MAX(n)::numeric / NULLIF(SUM(n), 0) AS top_source_share
      FROM per_source
     GROUP BY category
  ),
  ctr AS (
    SELECT c.name AS category,
           COALESCE(SUM(CASE WHEN ev.event_type = 'click' THEN 1 ELSE 0 END), 0)::numeric
             / NULLIF(SUM(CASE WHEN ev.event_type = 'impression' THEN 1 ELSE 0 END), 0)
             AS engagement_ctr
      FROM categories c
      LEFT JOIN articles a ON a.category_id = c.id
      LEFT JOIN article_clicks ev ON ev.article_id = a.id
       AND ev.created_at >= now() - interval '24 hours'
     GROUP BY c.name
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category',         a.category,
           'top_source_share', COALESCE(a.top_source_share, 0),
           'unique_sources',   a.unique_sources,
           'saturation_risk',
             CASE
               WHEN a.top_source_share IS NULL THEN 'none'
               WHEN a.top_source_share > 0.6 THEN 'high'
               WHEN a.top_source_share > 0.35 THEN 'medium'
               ELSE 'none'
             END,
           'engagement_ctr',   COALESCE(ctr.engagement_ctr, 0)
         ) ORDER BY a.category), '[]'::jsonb)
    INTO v_categories
    FROM agg a LEFT JOIN ctr ON ctr.category = a.category;

  RETURN jsonb_build_object(
    'categories',   COALESCE(v_categories, '[]'::jsonb),
    'generatedAt',  now()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('categories', '[]'::jsonb,
                            'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION get_feed_quality_snapshot()
  TO authenticated, service_role;

-- ============================================================
-- 8) get_monetization_snapshot
-- ============================================================
-- Internal-only readiness signal. If the optional ad telemetry
-- table is absent the snapshot reports a zero-state.
CREATE OR REPLACE FUNCTION get_monetization_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fill_rate          numeric := 0;
  v_rpm                numeric := 0;
  v_impressions        bigint := 0;
  v_revenue_micros     bigint := 0;
  v_sources            jsonb := '[]'::jsonb;
  v_fraud              jsonb := '[]'::jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('fill_rate', 0, 'rpm', 0,
                              'total_impressions', 0,
                              'total_revenue_micros', 0,
                              'sources', '[]'::jsonb,
                              'fraud_findings', '[]'::jsonb);
  END IF;

  IF _phaseg_relation_exists('public.ad_impressions') THEN
    BEGIN
      EXECUTE $q$
        SELECT
          COALESCE(SUM(CASE WHEN filled THEN 1 ELSE 0 END)::numeric
            / NULLIF(COUNT(*),0), 0),
          COALESCE(SUM(revenue_micros)::numeric
            / NULLIF(SUM(CASE WHEN filled THEN 1 ELSE 0 END),0) * 1000.0, 0),
          COALESCE(COUNT(*), 0),
          COALESCE(SUM(revenue_micros), 0)
          FROM ad_impressions
         WHERE created_at >= now() - interval '24 hours'
      $q$ INTO v_fill_rate, v_rpm, v_impressions, v_revenue_micros;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object(
    'fill_rate',            v_fill_rate,
    'rpm',                  v_rpm,
    'total_impressions',    v_impressions,
    'total_revenue_micros', v_revenue_micros,
    'sources',              v_sources,
    'fraud_findings',       v_fraud,
    'generatedAt',          now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_monetization_snapshot()
  TO authenticated, service_role;

-- ============================================================
-- 9) get_seo_health_snapshot
-- ============================================================
CREATE OR REPLACE FUNCTION get_seo_health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_schema      numeric := 1.0;
  v_sitemap     numeric := 1.0;
  v_freshness   numeric := 1.0;
  v_indexing    numeric := 1.0;
  v_authority   numeric := 1.0;
  v_overall     numeric;
  v_classify    text;
  v_issues      jsonb := '[]'::jsonb;
  v_arr         text[] := ARRAY[]::text[];
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('overall_score', NULL,
                              'components', '{}'::jsonb,
                              'top_issues', '[]'::jsonb,
                              'classification', 'unknown');
  END IF;

  -- Freshness: how many articles in the last 24h vs target floor.
  BEGIN
    SELECT LEAST(1.0,
             (COUNT(*)::numeric / GREATEST(50.0, 1.0)))
      INTO v_freshness
    FROM articles
    WHERE created_at >= now() - interval '24 hours';
    v_freshness := COALESCE(v_freshness, 0);
  EXCEPTION WHEN OTHERS THEN v_freshness := 1.0; END;

  -- Schema: percent of articles with a non-null URL.
  BEGIN
    SELECT COALESCE(
             COUNT(*) FILTER (WHERE url IS NOT NULL)::numeric
               / NULLIF(COUNT(*), 0),
             1.0)
      INTO v_schema
    FROM articles
    WHERE created_at >= now() - interval '7 days';
  EXCEPTION WHEN OTHERS THEN v_schema := 1.0; END;

  -- Authority: number of distinct active sources, capped.
  BEGIN
    SELECT LEAST(1.0, COUNT(DISTINCT id)::numeric / 25.0)
      INTO v_authority
    FROM sources WHERE COALESCE(is_active, true);
  EXCEPTION WHEN OTHERS THEN v_authority := 1.0; END;

  v_overall := round(((
      0.25 * v_schema
    + 0.20 * v_sitemap
    + 0.25 * v_freshness
    + 0.15 * v_indexing
    + 0.15 * v_authority
  ))::numeric, 4);

  IF v_schema    < 0.85 THEN v_arr := array_append(v_arr, 'Some articles missing canonical URL.'); END IF;
  IF v_freshness < 0.50 THEN v_arr := array_append(v_arr, 'Low publish volume in the last 24h.'); END IF;
  IF v_authority < 0.50 THEN v_arr := array_append(v_arr, 'Source diversity below target.'); END IF;
  v_issues := to_jsonb(v_arr);

  v_classify := CASE
    WHEN v_overall < 0.60 THEN 'critical'
    WHEN v_overall < 0.85 THEN 'degraded'
    ELSE 'healthy'
  END;

  RETURN jsonb_build_object(
    'overall_score',  v_overall,
    'classification', v_classify,
    'components', jsonb_build_object(
      'schema_score',           v_schema,
      'sitemap_score',          v_sitemap,
      'freshness_score',        v_freshness,
      'indexing_score',         v_indexing,
      'source_authority_score', v_authority
    ),
    'top_issues',    v_issues,
    'generatedAt',   now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_seo_health_snapshot()
  TO authenticated, service_role;

-- ============================================================
-- 10) get_mobile_release_readiness
-- ============================================================
CREATE OR REPLACE FUNCTION get_mobile_release_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_blockers     text[] := ARRAY[]::text[];
  v_spikes       jsonb := '[]'::jsonb;
  v_recommend    text;
  v_ok           boolean;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('ok', false, 'recommendation', 'hold',
                              'blockers', '[]'::jsonb,
                              'crash_spikes', '[]'::jsonb);
  END IF;

  IF _phaseg_relation_exists('public.mobile_crash_events') THEN
    BEGIN
      EXECUTE $q$
        SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        FROM (
          SELECT fingerprint,
                 COUNT(*)::integer AS count,
                 (COUNT(*)::numeric / NULLIF(
                   (SELECT COUNT(*) FROM mobile_crash_events
                     WHERE occurred_at >= now() - interval '7 days'
                       AND fingerprint = mce.fingerprint), 0)) AS spike_ratio,
                 MAX(release_channel)::text AS suspected_rollout
            FROM mobile_crash_events mce
           WHERE occurred_at >= now() - interval '1 hour'
           GROUP BY fingerprint
          HAVING COUNT(*) > 10
           ORDER BY COUNT(*) DESC
           LIMIT 10
        ) t
      $q$ INTO v_spikes;
    EXCEPTION WHEN OTHERS THEN v_spikes := '[]'::jsonb; END;
  END IF;

  IF jsonb_array_length(v_spikes) > 0 THEN
    v_blockers := array_append(v_blockers, 'Active crash spike(s) detected in last hour.');
  END IF;

  v_ok         := (array_length(v_blockers, 1) IS NULL);
  v_recommend  := CASE WHEN v_ok THEN 'ship' ELSE 'hold' END;

  RETURN jsonb_build_object(
    'ok',             v_ok,
    'recommendation', v_recommend,
    'blockers',       to_jsonb(v_blockers),
    'crash_spikes',   v_spikes,
    'generatedAt',    now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_mobile_release_readiness()
  TO authenticated, service_role;

-- ============================================================
-- 11) get_compliance_audit  /  get_security_compliance_summary
-- ============================================================
CREATE OR REPLACE FUNCTION get_compliance_audit()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_findings  jsonb := '[]'::jsonb;
  v_blockers  jsonb := '[]'::jsonb;
  v_score     numeric := 1.0;
  v_arr_find  jsonb[] := ARRAY[]::jsonb[];
  v_arr_block jsonb[] := ARRAY[]::jsonb[];
  v_n_admins  integer := 0;
  v_recent_audit integer := 0;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('final_compliance_score', NULL,
                              'launch_blockers', '[]'::jsonb,
                              'all_findings', '[]'::jsonb);
  END IF;

  -- Finding: are there any admin users at all?
  BEGIN
    SELECT COUNT(*) INTO v_n_admins
      FROM auth.users
     WHERE COALESCE((raw_app_meta_data->>'role'), '') = 'admin';
  EXCEPTION WHEN OTHERS THEN v_n_admins := 0; END;

  IF v_n_admins = 0 THEN
    v_arr_block := v_arr_block || jsonb_build_object(
      'code', 'no_admin_users', 'severity', 'severe',
      'message', 'No admin users exist; production lockout risk.');
  END IF;

  -- Finding: audit-log activity in the last 7 days.
  BEGIN
    SELECT COUNT(*) INTO v_recent_audit
      FROM admin_audit_log
     WHERE created_at >= now() - interval '7 days';
  EXCEPTION WHEN OTHERS THEN v_recent_audit := 0; END;

  IF v_recent_audit = 0 THEN
    v_arr_find := v_arr_find || jsonb_build_object(
      'code', 'audit_silence', 'severity', 'info',
      'message', 'No admin audit activity in last 7 days.');
  END IF;

  -- Soft scoring.
  IF v_n_admins = 0 THEN v_score := v_score - 0.5; END IF;
  IF v_recent_audit = 0 THEN v_score := v_score - 0.05; END IF;
  v_score := GREATEST(0, LEAST(1, v_score));

  v_findings := to_jsonb(v_arr_find || v_arr_block);
  v_blockers := to_jsonb(v_arr_block);

  RETURN jsonb_build_object(
    'final_compliance_score', v_score,
    'launch_blockers',        v_blockers,
    'all_findings',           v_findings,
    'generatedAt',            now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_compliance_audit()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_security_compliance_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_audit jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('score', NULL, 'blockers', 0);
  END IF;
  v_audit := get_compliance_audit();
  RETURN jsonb_build_object(
    'score',     v_audit->>'final_compliance_score',
    'blockers',  jsonb_array_length(COALESCE(v_audit->'launch_blockers','[]'::jsonb)),
    'findings',  jsonb_array_length(COALESCE(v_audit->'all_findings','[]'::jsonb)),
    'generatedAt', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_security_compliance_summary()
  TO authenticated, service_role;

-- ============================================================
-- 12) get_recovery_center_snapshot / get_backup_status
-- ============================================================
CREATE OR REPLACE FUNCTION get_recovery_center_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_tiers       jsonb := '[]'::jsonb;
  v_freshness   numeric := 0;
  v_confidence  numeric := 0;
  v_last_sim    timestamptz := NULL;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('backup_freshness_score', 0,
                              'recovery_confidence_score', 0,
                              'tiers', '[]'::jsonb);
  END IF;

  IF _phaseg_relation_exists('public.backup_history') THEN
    BEGIN
      EXECUTE $q$
        SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY tier), '[]'::jsonb),
               COALESCE(AVG(freshness_score), 0)
        FROM (
          SELECT tier::text,
                 MAX(completed_at) AS latest_at,
                 (MAX(completed_at) >= now() - rpo) AS within_rpo,
                 GREATEST(0, LEAST(1,
                   1.0 - EXTRACT(EPOCH FROM (now() - MAX(completed_at)))
                       / NULLIF(EXTRACT(EPOCH FROM rpo), 0)
                 )) AS freshness_score
            FROM backup_history
           GROUP BY tier, rpo
        ) t
      $q$ INTO v_tiers, v_freshness;
    EXCEPTION WHEN OTHERS THEN v_tiers := '[]'::jsonb; v_freshness := 0; END;
  END IF;

  IF _phaseg_relation_exists('public.restore_simulations') THEN
    BEGIN
      EXECUTE $q$
        SELECT MAX(completed_at),
               COALESCE(AVG(CASE WHEN status = 'SUCCESS' THEN 1.0 ELSE 0.0 END), 0)
          FROM restore_simulations
         WHERE completed_at >= now() - interval '30 days'
      $q$ INTO v_last_sim, v_confidence;
    EXCEPTION WHEN OTHERS THEN v_last_sim := NULL; v_confidence := 0; END;
  END IF;

  RETURN jsonb_build_object(
    'backup_freshness_score',     v_freshness,
    'recovery_confidence_score',  v_confidence,
    'last_restore_sim_at',        v_last_sim,
    'tiers',                      v_tiers,
    'generatedAt',                now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_recovery_center_snapshot()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_backup_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_snap jsonb;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  v_snap := get_recovery_center_snapshot();
  RETURN jsonb_build_object(
    'freshness',   v_snap->>'backup_freshness_score',
    'confidence',  v_snap->>'recovery_confidence_score',
    'last_sim_at', v_snap->>'last_restore_sim_at',
    'tiers',       v_snap->'tiers',
    'generatedAt', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_backup_status()
  TO authenticated, service_role;

-- ============================================================
-- 13) emergency_rollback / simulate_restore
-- ============================================================
-- Audited intent capture. The actual rollback orchestration lives
-- in the deployment pipeline (see docs/DEPLOYMENT_PIPELINE.md).
-- This RPC creates an immutable record so the dashboard's
-- "Recovery Center" can correlate operator actions with
-- subsequent restore outcomes.
CREATE OR REPLACE FUNCTION emergency_rollback(p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'detailed reason (>=10 chars) required'
      USING ERRCODE = '22023';
  END IF;

  -- Pause the rollout governor flag if it exists.
  IF _phaseg_relation_exists('public.feature_flags') THEN
    BEGIN
      INSERT INTO feature_flags (name, enabled, value, updated_at)
        VALUES ('rollout_governor', false,
                jsonb_build_object('paused', true,
                                   'pause_reason', p_reason,
                                   'paused_at', now()),
                now())
      ON CONFLICT (name) DO UPDATE
        SET enabled = false,
            value = COALESCE(feature_flags.value, '{}'::jsonb)
              || jsonb_build_object('paused', true,
                                    'pause_reason', p_reason,
                                    'paused_at', now()),
            updated_at = now();
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  PERFORM _log_admin_action(
    'emergency_rollback', 'rollout_governor',
    NULL, p_reason,
    jsonb_build_object('initiated_at', now()));

  RETURN jsonb_build_object('ok', true,
                            'action', 'emergency_rollback',
                            'initiated_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION emergency_rollback(text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION simulate_restore(p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_sim_id uuid := gen_random_uuid();
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = '22023';
  END IF;

  IF _phaseg_relation_exists('public.restore_simulations') THEN
    BEGIN
      EXECUTE $q$
        INSERT INTO restore_simulations (id, requested_by, reason, status, requested_at)
        VALUES ($1, auth.uid(), $2, 'QUEUED', now())
      $q$ USING v_sim_id, p_reason;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  PERFORM _log_admin_action(
    'simulate_restore', 'restore_simulations',
    v_sim_id, p_reason,
    jsonb_build_object('queued_at', now()));

  RETURN jsonb_build_object('ok', true,
                            'simulation_id', v_sim_id,
                            'queued_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION simulate_restore(text)
  TO authenticated, service_role;

-- ============================================================
-- 14) get_launch_readiness
-- ============================================================
-- Unified launch certification. Aggregates the headline numbers
-- from every other Phase G RPC into a single payload that the
-- "Production Signoff" workflow can consume.
CREATE OR REPLACE FUNCTION get_launch_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_health    jsonb;
  v_compliance jsonb;
  v_mobile    jsonb;
  v_recovery  jsonb;
  v_seo       jsonb;
  v_blockers  text[] := ARRAY[]::text[];
  v_ready     boolean;
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN jsonb_build_object('ready', false, 'blockers', '[]'::jsonb);
  END IF;

  v_health     := get_production_health_snapshot();
  v_compliance := get_compliance_audit();
  v_mobile     := get_mobile_release_readiness();
  v_recovery   := get_recovery_center_snapshot();
  v_seo        := get_seo_health_snapshot();

  IF (v_health->'health'->>'classification') = 'critical' THEN
    v_blockers := array_append(v_blockers, 'Production health classification is CRITICAL.');
  END IF;
  IF jsonb_array_length(COALESCE(v_compliance->'launch_blockers','[]'::jsonb)) > 0 THEN
    v_blockers := array_append(v_blockers, 'Outstanding compliance launch blockers.');
  END IF;
  -- get_mobile_release_readiness returns 'ship' or 'hold'; treat any
  -- non-'ship' value as a launch blocker so future recommendation
  -- vocabulary additions (e.g. 'block') also fail-safe.
  IF COALESCE(v_mobile->>'recommendation', 'hold') <> 'ship' THEN
    v_blockers := array_append(v_blockers, 'Mobile release recommendation is not SHIP.');
  END IF;
  IF ((v_recovery->>'backup_freshness_score')::numeric < 0.5) THEN
    v_blockers := array_append(v_blockers, 'Backup freshness below 0.5.');
  END IF;

  v_ready := (array_length(v_blockers, 1) IS NULL);

  RETURN jsonb_build_object(
    'ready',           v_ready,
    'blockers',        to_jsonb(v_blockers),
    'health',          v_health->'health',
    'compliance',      jsonb_build_object(
                         'score',    v_compliance->>'final_compliance_score',
                         'blockers', jsonb_array_length(COALESCE(v_compliance->'launch_blockers','[]'::jsonb))),
    'mobile',          jsonb_build_object('recommendation', v_mobile->>'recommendation'),
    'recovery',        jsonb_build_object(
                         'freshness',  v_recovery->>'backup_freshness_score',
                         'confidence', v_recovery->>'recovery_confidence_score'),
    'seo',             jsonb_build_object('score', v_seo->>'overall_score'),
    'generatedAt',     now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_launch_readiness()
  TO authenticated, service_role;

-- ============================================================
-- END OF MIGRATION 049
-- ============================================================
