-- ============================================================
-- MIGRATION 048: Phase D — Personalization & AI Ranking Engine
--
-- Purely additive. Builds on:
--   * 042 (user_category_affinity, user_source_affinity,
--         recompute_user_affinity, personalization_recompute_queue)
--   * 043 (ranked_feed_global, ranked_feed_category,
--         ranked_feed_breaking, ranked_feed_personalized)
--   * 041 (notification_events, notification_deliveries,
--         materialize_notification_event, record_notification_delivery)
--   * 045 (feature_flags + is_feature_enabled — flags reused, not redefined)
--
-- Hard rules:
--   - NO destructive DDL.
--   - NO redefinition of existing tables or RPC signatures.
--   - All new mutation RPCs are SECURITY DEFINER, gated either by
--     service_role membership or by _is_admin_caller() (047).
--   - All new tables get RLS enabled; clients see only their own rows.
--   - Pre-existing ranked_feed_global / ranked_feed_personalized are
--     LEFT UNTOUCHED. The new personalized slice lives in
--     `ranked_feed_personalized_v2` so the rollout is flag-gated and
--     reversible at zero risk to the existing serving path.
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Negative-signal table
--    Hidden articles, blocked sources, skipped notifications,
--    fast-scroll-past articles, and dislike reactions all live here.
--    These rows REDUCE affinity (see apply_negative_signals_to_affinity).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_negative_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type text NOT NULL
    CHECK (signal_type IN (
      'hide_article',
      'block_source',
      'skip_notification',
      'fast_scroll',
      'dislike_reaction',
      'mute_category'
    )),
  article_id uuid REFERENCES articles(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  -- weight is multiplicative penalty applied to affinity (0..1, lower = stronger).
  weight numeric(5,4) NOT NULL DEFAULT 0.5
    CHECK (weight >= 0 AND weight <= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_negative_signals_user_created
  ON user_negative_signals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_negative_signals_user_source
  ON user_negative_signals (user_id, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_negative_signals_user_category
  ON user_negative_signals (user_id, category_id)
  WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_negative_signals_user_article
  ON user_negative_signals (user_id, article_id)
  WHERE article_id IS NOT NULL;

ALTER TABLE user_negative_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_negative_signals_select_own ON user_negative_signals;
DROP POLICY IF EXISTS user_negative_signals_write_service_role ON user_negative_signals;

CREATE POLICY user_negative_signals_select_own
  ON user_negative_signals
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_negative_signals_write_service_role
  ON user_negative_signals
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------
-- 2) Record-negative-signal RPC
--    The only sanctioned write path for negative signals. Clients call
--    via service-role RPCs; we never permit direct INSERTs.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_negative_signal(
  p_user_id uuid,
  p_signal_type text,
  p_article_id uuid DEFAULT NULL,
  p_source_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_weight numeric DEFAULT 0.5,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
  v_weight numeric(5,4);
BEGIN
  IF p_user_id IS NULL OR p_signal_type IS NULL THEN
    RETURN NULL;
  END IF;
  v_weight := GREATEST(0.0, LEAST(1.0, COALESCE(p_weight, 0.5)))::numeric(5,4);

  INSERT INTO user_negative_signals (
    user_id, signal_type, article_id, source_id, category_id, weight, metadata
  )
  VALUES (
    p_user_id, p_signal_type, p_article_id, p_source_id, p_category_id,
    v_weight, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  -- Mark the user as needing a recompute. Reuses 042's queue.
  PERFORM enqueue_personalization_recompute(p_user_id, 'negative_signal:' || p_signal_type);

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_negative_signal(uuid, text, uuid, uuid, uuid, numeric, jsonb)
  TO service_role;

-- ------------------------------------------------------------
-- 3) Apply negative signals to affinity scores
--    Run AFTER recompute_user_affinity() so positive scores exist; this
--    just multiplies the affected (user, source/category) cells by
--    the cumulative negative weight (clamped). Idempotent.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_negative_signals_to_affinity(
  p_user_id uuid,
  p_lookback_days integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(p_lookback_days, 1));
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Aggregate per-source penalty as product of (1 - weight) across signals
  -- so multiple negative signals compound but never invert score sign.
  WITH src_penalty AS (
    SELECT
      source_id,
      GREATEST(0.0,
        COALESCE(EXP(SUM(LN(GREATEST(1.0 - weight, 0.01)))), 1.0)
      )::numeric(10,4) AS factor
    FROM user_negative_signals
    WHERE user_id = p_user_id
      AND source_id IS NOT NULL
      AND created_at >= v_since
    GROUP BY source_id
  )
  UPDATE user_source_affinity usa
  SET score = (usa.score * sp.factor)::numeric(10,4),
      recomputed_at = now()
  FROM src_penalty sp
  WHERE usa.user_id = p_user_id
    AND usa.source_id = sp.source_id;

  WITH cat_penalty AS (
    SELECT
      category_id,
      GREATEST(0.0,
        COALESCE(EXP(SUM(LN(GREATEST(1.0 - weight, 0.01)))), 1.0)
      )::numeric(10,4) AS factor
    FROM user_negative_signals
    WHERE user_id = p_user_id
      AND category_id IS NOT NULL
      AND created_at >= v_since
    GROUP BY category_id
  )
  UPDATE user_category_affinity uca
  SET score = (uca.score * cp.factor)::numeric(10,4),
      recomputed_at = now()
  FROM cat_penalty cp
  WHERE uca.user_id = p_user_id
    AND uca.category_id = cp.category_id;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_negative_signals_to_affinity(uuid, integer)
  TO service_role;

-- ------------------------------------------------------------
-- 4) Per-user personalized feed slice (v2 — does NOT touch v1)
--    A plain table (not a materialized view) because rows are written
--    per-user via queue-driven `refresh_personalized_feed_v2`, never
--    via REFRESH MATERIALIZED VIEW. This is the architectural pivot
--    that lets us scale to 100k users without a global recompute storm.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ranked_feed_personalized_v2 (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  rank_position integer NOT NULL,
  personalized_score numeric(14,4) NOT NULL,
  global_score numeric(14,4) NOT NULL DEFAULT 0,
  affinity_weight numeric(8,4) NOT NULL DEFAULT 1.0,
  freshness_bonus numeric(8,4) NOT NULL DEFAULT 0,
  engagement_bonus numeric(8,4) NOT NULL DEFAULT 0,
  repetition_penalty numeric(8,4) NOT NULL DEFAULT 0,
  fatigue_penalty numeric(8,4) NOT NULL DEFAULT 0,
  is_exploration boolean NOT NULL DEFAULT false,
  source_id uuid,
  category_id uuid,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_rfpv2_user_rank
  ON ranked_feed_personalized_v2 (user_id, rank_position);
CREATE INDEX IF NOT EXISTS idx_rfpv2_user_computed
  ON ranked_feed_personalized_v2 (user_id, computed_at DESC);

ALTER TABLE ranked_feed_personalized_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rfpv2_select_own ON ranked_feed_personalized_v2;
DROP POLICY IF EXISTS rfpv2_write_service_role ON ranked_feed_personalized_v2;

CREATE POLICY rfpv2_select_own
  ON ranked_feed_personalized_v2
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY rfpv2_write_service_role
  ON ranked_feed_personalized_v2
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------
-- 5) refresh_personalized_feed_v2(p_user_id, p_limit)
--    SELECTIVE refresh — only the requested user. Triggered from the
--    `ranking` queue (`refresh_personalized_feed`). Replaces a row-set
--    transactionally; reads from the existing ranked_feed_global so
--    we never duplicate the global ranking pipeline.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_personalized_feed_v2(
  p_user_id uuid,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inserted integer := 0;
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 10);
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Replace this user's slice atomically inside the function body.
  DELETE FROM ranked_feed_personalized_v2 WHERE user_id = p_user_id;

  WITH global_top AS (
    SELECT
      g.article_id,
      g.source_id,
      g.category_id,
      g.final_score AS global_score,
      g.published_at
    FROM ranked_feed_global g
    ORDER BY g.final_score DESC NULLS LAST
    LIMIT v_limit * 4   -- 4x oversample to leave room for re-ranking + diversity
  ),
  scored AS (
    SELECT
      gt.article_id,
      gt.source_id,
      gt.category_id,
      gt.global_score,
      -- affinity weight = 1 + 0.5*cat_score + 0.5*source_score (clamped)
      LEAST(5.0, 1.0
        + 0.5 * COALESCE(uca.score, 0)
        + 0.5 * COALESCE(usa.score, 0)
      )::numeric(8,4) AS affinity_weight,
      -- freshness bonus mirrors global pipeline (24h half-life, cheaper)
      (0.5 * EXP(
        - (ln(2.0) / 24.0)
        * GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(gt.published_at, now()))) / 3600.0, 0.0)
      ))::numeric(8,4) AS freshness_bonus
    FROM global_top gt
    LEFT JOIN user_category_affinity uca
      ON uca.user_id = p_user_id AND uca.category_id = gt.category_id
    LEFT JOIN user_source_affinity usa
      ON usa.user_id = p_user_id AND usa.source_id = gt.source_id
  ),
  filtered AS (
    -- Suppress already-read + hidden + blocked-source content.
    SELECT s.*
    FROM scored s
    WHERE NOT EXISTS (
      SELECT 1 FROM user_read_history urh
      WHERE urh.user_id = p_user_id AND urh.article_id = s.article_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_negative_signals neg
      WHERE neg.user_id = p_user_id
        AND (
          (neg.signal_type = 'hide_article'  AND neg.article_id = s.article_id) OR
          (neg.signal_type = 'block_source'  AND neg.source_id  = s.source_id)  OR
          (neg.signal_type = 'mute_category' AND neg.category_id = s.category_id)
        )
    )
  ),
  finalized AS (
    SELECT
      f.*,
      (
        f.global_score * f.affinity_weight
        + f.freshness_bonus
      )::numeric(14,4) AS personalized_score
    FROM filtered f
  ),
  ordered AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (ORDER BY f.personalized_score DESC NULLS LAST) AS rn
    FROM finalized f
  )
  INSERT INTO ranked_feed_personalized_v2 (
    user_id, article_id, rank_position, personalized_score, global_score,
    affinity_weight, freshness_bonus, engagement_bonus,
    repetition_penalty, fatigue_penalty,
    is_exploration, source_id, category_id, computed_at
  )
  SELECT
    p_user_id,
    o.article_id,
    o.rn::integer,
    o.personalized_score,
    o.global_score,
    o.affinity_weight,
    o.freshness_bonus,
    0::numeric(8,4),
    0::numeric(8,4),
    0::numeric(8,4),
    false,
    o.source_id,
    o.category_id,
    now()
  FROM ordered o
  WHERE o.rn <= v_limit;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_personalized_feed_v2(uuid, integer) TO service_role;

-- ------------------------------------------------------------
-- 6) analytics_delivery_health
--    Tracks emitted / accepted / dropped / failed counts for
--    notification + analytics sinks. Each row is a tiny tick;
--    snapshots are aggregated on demand.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_delivery_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sink text NOT NULL CHECK (sink IN (
    'notification_fanout',
    'notification_push',
    'notification_inbox',
    'analytics_metrics',
    'ranking_feedback',
    'personalization_recompute'
  )),
  event text NOT NULL CHECK (event IN ('emitted','accepted','dropped','failed')),
  count integer NOT NULL DEFAULT 1 CHECK (count >= 0),
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adh_sink_event_time
  ON analytics_delivery_health (sink, event, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_adh_recorded_at
  ON analytics_delivery_health (recorded_at DESC);

ALTER TABLE analytics_delivery_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adh_select_admin ON analytics_delivery_health;
DROP POLICY IF EXISTS adh_write_service_role ON analytics_delivery_health;

CREATE POLICY adh_select_admin
  ON analytics_delivery_health
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY adh_write_service_role
  ON analytics_delivery_health
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION record_delivery_health_event(
  p_sink text,
  p_event text,
  p_count integer DEFAULT 1,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_sink IS NULL OR p_event IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO analytics_delivery_health (sink, event, count, reason, metadata)
  VALUES (
    p_sink, p_event,
    GREATEST(1, COALESCE(p_count, 1)),
    p_reason, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_delivery_health_event(text, text, integer, text, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION delivery_health_snapshot(
  p_lookback_minutes integer DEFAULT 60
)
RETURNS TABLE (
  sink text,
  emitted bigint,
  accepted bigint,
  dropped bigint,
  failed bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    sink,
    SUM(CASE WHEN event = 'emitted'  THEN count ELSE 0 END)::bigint AS emitted,
    SUM(CASE WHEN event = 'accepted' THEN count ELSE 0 END)::bigint AS accepted,
    SUM(CASE WHEN event = 'dropped'  THEN count ELSE 0 END)::bigint AS dropped,
    SUM(CASE WHEN event = 'failed'   THEN count ELSE 0 END)::bigint AS failed
  FROM analytics_delivery_health
  WHERE recorded_at >= now() - make_interval(mins => GREATEST(p_lookback_minutes, 1))
  GROUP BY sink
  ORDER BY sink;
$$;

GRANT EXECUTE ON FUNCTION delivery_health_snapshot(integer)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7) notification_fanout_chunks
--    Lineage table for the fanout chunker. One row per emitted chunk
--    job. Carries trace_id so observability can reconstruct a fanout
--    from a single trace.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_fanout_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_event_id uuid,
  parent_dedup_key text,
  trace_id text,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  chunk_total integer NOT NULL CHECK (chunk_total >= 1),
  recipient_count integer NOT NULL CHECK (recipient_count >= 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','dispatched','failed','dropped')),
  job_id uuid,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nfc_trace
  ON notification_fanout_chunks (trace_id)
  WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfc_parent_event
  ON notification_fanout_chunks (parent_event_id)
  WHERE parent_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfc_enqueued_at
  ON notification_fanout_chunks (enqueued_at DESC);

ALTER TABLE notification_fanout_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nfc_write_service_role ON notification_fanout_chunks;
DROP POLICY IF EXISTS nfc_select_admin ON notification_fanout_chunks;
CREATE POLICY nfc_select_admin
  ON notification_fanout_chunks
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');
CREATE POLICY nfc_write_service_role
  ON notification_fanout_chunks
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION record_fanout_chunk(
  p_parent_event_id uuid,
  p_parent_dedup_key text,
  p_trace_id text,
  p_chunk_index integer,
  p_chunk_total integer,
  p_recipient_count integer,
  p_job_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO notification_fanout_chunks (
    parent_event_id, parent_dedup_key, trace_id,
    chunk_index, chunk_total, recipient_count, job_id, status
  ) VALUES (
    p_parent_event_id, p_parent_dedup_key, p_trace_id,
    GREATEST(0, COALESCE(p_chunk_index, 0)),
    GREATEST(1, COALESCE(p_chunk_total, 1)),
    GREATEST(0, COALESCE(p_recipient_count, 0)),
    p_job_id,
    'queued'
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_fanout_chunk(uuid, text, text, integer, integer, integer, uuid)
  TO service_role;

-- ------------------------------------------------------------
-- 8) ranking_feedback_metrics
--    One row per "ranking feedback observation" — feed quality score,
--    bounce rate, long-session correlation. Drives feedbackLoop.ts.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ranking_feedback_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_variant text NOT NULL DEFAULT 'personalized_v2'
    CHECK (feed_variant IN ('global','personalized_v1','personalized_v2','breaking')),
  session_id text,
  session_dwell_ms bigint NOT NULL DEFAULT 0 CHECK (session_dwell_ms >= 0),
  bounce boolean NOT NULL DEFAULT false,
  quality_score numeric(5,4) NOT NULL DEFAULT 0
    CHECK (quality_score >= 0 AND quality_score <= 1),
  diversity_score numeric(5,4) NOT NULL DEFAULT 0
    CHECK (diversity_score >= 0 AND diversity_score <= 1),
  exploration_ratio numeric(5,4) NOT NULL DEFAULT 0
    CHECK (exploration_ratio >= 0 AND exploration_ratio <= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfm_user_time
  ON ranking_feedback_metrics (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfm_variant_time
  ON ranking_feedback_metrics (feed_variant, recorded_at DESC);

ALTER TABLE ranking_feedback_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rfm_select_own ON ranking_feedback_metrics;
DROP POLICY IF EXISTS rfm_write_service_role ON ranking_feedback_metrics;
CREATE POLICY rfm_select_own
  ON ranking_feedback_metrics
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY rfm_write_service_role
  ON ranking_feedback_metrics
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION record_ranking_feedback(
  p_user_id uuid,
  p_feed_variant text,
  p_session_id text,
  p_session_dwell_ms bigint,
  p_bounce boolean,
  p_quality_score numeric,
  p_diversity_score numeric DEFAULT 0,
  p_exploration_ratio numeric DEFAULT 0,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO ranking_feedback_metrics (
    user_id, feed_variant, session_id, session_dwell_ms, bounce,
    quality_score, diversity_score, exploration_ratio, metadata
  ) VALUES (
    p_user_id,
    COALESCE(NULLIF(p_feed_variant, ''), 'personalized_v2'),
    p_session_id,
    GREATEST(0, COALESCE(p_session_dwell_ms, 0)),
    COALESCE(p_bounce, false),
    GREATEST(0.0, LEAST(1.0, COALESCE(p_quality_score, 0)))::numeric(5,4),
    GREATEST(0.0, LEAST(1.0, COALESCE(p_diversity_score, 0)))::numeric(5,4),
    GREATEST(0.0, LEAST(1.0, COALESCE(p_exploration_ratio, 0)))::numeric(5,4),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_ranking_feedback(
  uuid, text, text, bigint, boolean, numeric, numeric, numeric, jsonb
) TO service_role;

CREATE OR REPLACE FUNCTION ranking_feedback_summary(
  p_lookback_minutes integer DEFAULT 60
)
RETURNS TABLE (
  feed_variant text,
  samples bigint,
  avg_dwell_ms numeric,
  bounce_rate numeric,
  avg_quality numeric,
  avg_diversity numeric,
  avg_exploration numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    feed_variant,
    COUNT(*)::bigint AS samples,
    COALESCE(AVG(session_dwell_ms), 0)::numeric AS avg_dwell_ms,
    CASE WHEN COUNT(*) > 0
      THEN (SUM(CASE WHEN bounce THEN 1 ELSE 0 END)::numeric / COUNT(*))
      ELSE 0 END AS bounce_rate,
    COALESCE(AVG(quality_score), 0)::numeric AS avg_quality,
    COALESCE(AVG(diversity_score), 0)::numeric AS avg_diversity,
    COALESCE(AVG(exploration_ratio), 0)::numeric AS avg_exploration
  FROM ranking_feedback_metrics
  WHERE recorded_at >= now() - make_interval(mins => GREATEST(p_lookback_minutes, 1))
  GROUP BY feed_variant
  ORDER BY feed_variant;
$$;

GRANT EXECUTE ON FUNCTION ranking_feedback_summary(integer)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 9) Personalization observability dashboard
--    A single RPC the admin panel can poll for the Phase D coverage
--    KPIs (affinity coverage %, ranking freshness, stale personalized
--    feeds, recommendation entropy proxy, suppression rate).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION personalization_dashboard(
  p_freshness_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_total_users bigint;
  v_users_with_affinity bigint;
  v_users_with_rfpv2 bigint;
  v_fresh_users bigint;
  v_stale_users bigint;
  v_avg_slice numeric;
  v_distinct_sources bigint;
  v_distinct_categories bigint;
  v_neg_recent bigint;
  v_freshness interval := make_interval(mins => GREATEST(p_freshness_minutes, 1));
BEGIN
  SELECT COUNT(*) INTO v_total_users FROM auth.users;
  SELECT COUNT(DISTINCT user_id) INTO v_users_with_affinity FROM user_category_affinity;
  SELECT COUNT(DISTINCT user_id) INTO v_users_with_rfpv2 FROM ranked_feed_personalized_v2;
  SELECT COUNT(DISTINCT user_id)
    INTO v_fresh_users
    FROM ranked_feed_personalized_v2
    WHERE computed_at >= now() - v_freshness;
  v_stale_users := GREATEST(v_users_with_rfpv2 - v_fresh_users, 0);

  SELECT COALESCE(AVG(slice_size), 0) INTO v_avg_slice
    FROM (
      SELECT COUNT(*) AS slice_size
      FROM ranked_feed_personalized_v2
      GROUP BY user_id
    ) s;

  SELECT
    COUNT(DISTINCT source_id),
    COUNT(DISTINCT category_id)
  INTO v_distinct_sources, v_distinct_categories
  FROM ranked_feed_personalized_v2;

  SELECT COUNT(*) INTO v_neg_recent
    FROM user_negative_signals
    WHERE created_at >= now() - v_freshness;

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'users_with_affinity', v_users_with_affinity,
    'affinity_coverage_pct',
      CASE WHEN v_total_users > 0
        THEN ROUND((v_users_with_affinity::numeric * 100) / v_total_users, 2)
        ELSE 0 END,
    'users_with_personalized_feed', v_users_with_rfpv2,
    'fresh_personalized_users', v_fresh_users,
    'stale_personalized_users', v_stale_users,
    'avg_slice_size', ROUND(v_avg_slice, 2),
    'distinct_sources_surfaced', v_distinct_sources,
    'distinct_categories_surfaced', v_distinct_categories,
    'negative_signals_window', v_neg_recent,
    'window_minutes', p_freshness_minutes,
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION personalization_dashboard(integer)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 10) Selective refresh trigger helper
--     Schedules a per-user personalized-feed refresh via the existing
--     `enqueue_job` RPC, NEVER recomputes globally. This is the only
--     supported invalidation entrypoint the worker calls into.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_personalized_feed_refresh(
  p_user_id uuid,
  p_reason text DEFAULT NULL,
  p_trace_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_job_id uuid;
  v_dedup text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- One pending refresh per user at a time; the dedup key collapses bursts.
  v_dedup := 'refresh_personalized_feed:' || p_user_id::text;

  v_job_id := enqueue_job(
    p_queue_name   => 'ranking',
    p_job_type     => 'refresh_personalized_feed',
    p_payload      => jsonb_build_object(
      'user_id', p_user_id,
      'reason', p_reason,
      'trace_id', p_trace_id
    ),
    p_dedup_key    => v_dedup,
    p_priority     => 5::smallint,
    p_max_attempts => 3
  );
  RETURN v_job_id;
END;
$$;

GRANT EXECUTE ON FUNCTION enqueue_personalized_feed_refresh(uuid, text, text)
  TO service_role;

RESET ROLE;
