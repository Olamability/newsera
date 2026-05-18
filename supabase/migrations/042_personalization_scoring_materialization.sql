-- ============================================================
-- MIGRATION 042: Personalization scoring & materialization
-- - user_category_affinity:  per-user per-category preference score
-- - user_source_affinity:    per-user per-source preference score
-- - Decay-weighted recompute from clicks/read/bookmarks/reactions/shares
-- - Materialized view for fast feed serving
-- - Fully additive; legacy user_interests retained for compatibility
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Per-user × category affinity
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_category_affinity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  score numeric(10,4) NOT NULL DEFAULT 0
    CHECK (score >= 0),
  raw_signal_count integer NOT NULL DEFAULT 0,
  last_interaction_at timestamptz,
  recomputed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_user_category_affinity_user_score
  ON user_category_affinity (user_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_user_category_affinity_category_score
  ON user_category_affinity (category_id, score DESC);

-- ------------------------------------------------------------
-- 2) Per-user × source affinity
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_source_affinity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  score numeric(10,4) NOT NULL DEFAULT 0
    CHECK (score >= 0),
  raw_signal_count integer NOT NULL DEFAULT 0,
  last_interaction_at timestamptz,
  recomputed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_user_source_affinity_user_score
  ON user_source_affinity (user_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_user_source_affinity_source_score
  ON user_source_affinity (source_id, score DESC);

-- ------------------------------------------------------------
-- 3) Personalization-pending users queue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personalization_recompute_queue (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  reason text
);

-- ------------------------------------------------------------
-- 4) Decay-weighted recompute for a single user
-- Signal weights:
--   bookmark = 5, reaction = 4, share = 4, read = 3, click = 1
-- Time decay: half-life ~ 14 days (lambda = ln(2)/14)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_user_affinity(
  p_user_id uuid,
  p_lookback_days integer DEFAULT 60
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_half_life_days numeric := 14.0;
  v_lambda numeric := 0.6931471805599453 / 14.0;  -- ln(2) / 14
  v_since timestamptz := now() - make_interval(days => GREATEST(p_lookback_days, 1));
  v_signal_total bigint := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Build weighted signals from each engagement source.
  -- NOTE: article_clicks.user_id is text (legacy device-id compatible);
  -- only consider clicks whose user_id matches the auth uuid as text.
  -- PERFORM is required because data-modifying CTEs in plpgsql need a
  -- top-level statement without a result destination.
  WITH signals AS (
    -- clicks (text user_id; safe cast guard)
    SELECT
      a.category_id,
      a.source_id,
      1.0::numeric AS base_weight,
      ac.clicked_at AS happened_at
    FROM article_clicks ac
    JOIN articles a ON a.id = ac.article_id
    WHERE ac.user_id = p_user_id::text
      AND ac.clicked_at >= v_since
    UNION ALL
    -- reads
    SELECT
      a.category_id,
      a.source_id,
      3.0::numeric,
      urh.read_at
    FROM user_read_history urh
    JOIN articles a ON a.id = urh.article_id
    WHERE urh.user_id = p_user_id
      AND urh.read_at >= v_since
    UNION ALL
    -- bookmarks
    SELECT
      a.category_id,
      a.source_id,
      5.0::numeric,
      b.created_at
    FROM bookmarks b
    JOIN articles a ON a.id = b.article_id
    WHERE b.user_id = p_user_id
      AND b.created_at >= v_since
    UNION ALL
    -- reactions (likes counted positively, dislikes ignored for affinity)
    SELECT
      a.category_id,
      a.source_id,
      CASE WHEN ar.reaction_type = 'like' THEN 4.0 ELSE 0.0 END::numeric,
      ar.updated_at
    FROM article_reactions ar
    JOIN articles a ON a.id = ar.article_id
    WHERE ar.user_id = p_user_id
      AND ar.updated_at >= v_since
    UNION ALL
    -- shares
    SELECT
      a.category_id,
      a.source_id,
      4.0::numeric,
      sh.created_at
    FROM article_shares sh
    JOIN articles a ON a.id = sh.article_id
    WHERE sh.user_id = p_user_id
      AND sh.created_at >= v_since
  ),
  decayed AS (
    SELECT
      category_id,
      source_id,
      base_weight * exp(
        - v_lambda * GREATEST(EXTRACT(EPOCH FROM (now() - happened_at)) / 86400.0, 0.0)
      ) AS weighted,
      happened_at
    FROM signals
    WHERE base_weight > 0
  ),
  cat_scores AS (
    SELECT
      category_id,
      SUM(weighted)::numeric(10,4) AS score,
      COUNT(*)::integer AS signal_count,
      MAX(happened_at) AS last_at
    FROM decayed
    WHERE category_id IS NOT NULL
    GROUP BY category_id
  ),
  src_scores AS (
    SELECT
      source_id,
      SUM(weighted)::numeric(10,4) AS score,
      COUNT(*)::integer AS signal_count,
      MAX(happened_at) AS last_at
    FROM decayed
    WHERE source_id IS NOT NULL
    GROUP BY source_id
  ),
  upsert_cat AS (
    INSERT INTO user_category_affinity (
      user_id, category_id, score, raw_signal_count,
      last_interaction_at, recomputed_at
    )
    SELECT p_user_id, cs.category_id, cs.score, cs.signal_count,
           cs.last_at, now()
    FROM cat_scores cs
    ON CONFLICT (user_id, category_id) DO UPDATE
    SET score = EXCLUDED.score,
        raw_signal_count = EXCLUDED.raw_signal_count,
        last_interaction_at = EXCLUDED.last_interaction_at,
        recomputed_at = now()
    RETURNING 1
  ),
  upsert_src AS (
    INSERT INTO user_source_affinity (
      user_id, source_id, score, raw_signal_count,
      last_interaction_at, recomputed_at
    )
    SELECT p_user_id, ss.source_id, ss.score, ss.signal_count,
           ss.last_at, now()
    FROM src_scores ss
    ON CONFLICT (user_id, source_id) DO UPDATE
    SET score = EXCLUDED.score,
        raw_signal_count = EXCLUDED.raw_signal_count,
        last_interaction_at = EXCLUDED.last_interaction_at,
        recomputed_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) FROM (
    SELECT 1 FROM upsert_cat
    UNION ALL
    SELECT 1 FROM upsert_src
  ) sub
  INTO STRICT v_signal_total;

  -- Decay-out rows that received no signals in the lookback window
  -- (drift them toward 0 without deleting, so refresh stays cheap).
  UPDATE user_category_affinity
  SET score = score * 0.5,
      recomputed_at = now()
  WHERE user_id = p_user_id
    AND (last_interaction_at IS NULL OR last_interaction_at < v_since);

  UPDATE user_source_affinity
  SET score = score * 0.5,
      recomputed_at = now()
  WHERE user_id = p_user_id
    AND (last_interaction_at IS NULL OR last_interaction_at < v_since);

  DELETE FROM personalization_recompute_queue
  WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION recompute_user_affinity(uuid, integer) TO service_role;

-- ------------------------------------------------------------
-- 5) Enqueue user for recompute (trigger-friendly entry point)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_personalization_recompute(
  p_user_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO personalization_recompute_queue (user_id, reason)
  VALUES (p_user_id, p_reason)
  ON CONFLICT (user_id) DO UPDATE
  SET enqueued_at = now(),
      reason = COALESCE(EXCLUDED.reason, personalization_recompute_queue.reason);
END;
$$;

GRANT EXECUTE ON FUNCTION enqueue_personalization_recompute(uuid, text) TO service_role;

-- ------------------------------------------------------------
-- 6) Process pending recomputes (called by pg_cron in 044)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION process_pending_personalization(
  p_batch_size integer DEFAULT 50
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user record;
  v_processed integer := 0;
BEGIN
  FOR v_user IN
    SELECT user_id
    FROM personalization_recompute_queue
    ORDER BY enqueued_at ASC
    LIMIT GREATEST(p_batch_size, 1)
  LOOP
    BEGIN
      PERFORM recompute_user_affinity(v_user.user_id, 60);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Don't let one user halt the batch; clear queue entry so we move on.
      DELETE FROM personalization_recompute_queue WHERE user_id = v_user.user_id;
    END;
  END LOOP;

  RETURN v_processed;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_personalization(integer) TO service_role;

-- ------------------------------------------------------------
-- 7) Helper view: top N categories per user
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW user_top_categories AS
SELECT
  uca.user_id,
  uca.category_id,
  c.name AS category_name,
  c.slug AS category_slug,
  uca.score,
  uca.raw_signal_count,
  uca.last_interaction_at
FROM user_category_affinity uca
JOIN categories c ON c.id = uca.category_id
WHERE uca.score > 0;

GRANT SELECT ON user_top_categories TO authenticated, service_role;

-- ------------------------------------------------------------
-- 8) RLS
-- ------------------------------------------------------------
ALTER TABLE user_category_affinity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_source_affinity ENABLE ROW LEVEL SECURITY;
ALTER TABLE personalization_recompute_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_category_affinity_select_own ON user_category_affinity;
DROP POLICY IF EXISTS user_category_affinity_write_service_role ON user_category_affinity;

CREATE POLICY user_category_affinity_select_own
  ON user_category_affinity
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_category_affinity_write_service_role
  ON user_category_affinity
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS user_source_affinity_select_own ON user_source_affinity;
DROP POLICY IF EXISTS user_source_affinity_write_service_role ON user_source_affinity;

CREATE POLICY user_source_affinity_select_own
  ON user_source_affinity
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_source_affinity_write_service_role
  ON user_source_affinity
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS personalization_recompute_queue_service ON personalization_recompute_queue;
CREATE POLICY personalization_recompute_queue_service
  ON personalization_recompute_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
