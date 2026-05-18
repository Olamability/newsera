-- ============================================================
-- MIGRATION 043: AI-assisted ranking pipeline
-- - ranked_feed_global       (materialized; trending across the platform)
-- - ranked_feed_category     (materialized; per-category trending)
-- - ranked_feed_breaking     (view; recent + high click velocity)
-- - ranked_feed_personalized (table; per-user precomputed top items)
-- - Refresh RPCs designed to be cacheable and cron-driven
-- - Builds on articles_engagement_feed without duplicating it
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Global ranked feed (materialized, combines engagement +
--    source reliability + freshness decay + diversity boost)
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS ranked_feed_global;

CREATE MATERIALIZED VIEW ranked_feed_global AS
WITH base AS (
  SELECT
    aef.id AS article_id,
    aef.category_id,
    aef.source_id,
    aef.published_at,
    aef.engagement_score,
    aef.likes_count,
    aef.comments_count,
    aef.shares_count,
    aef.views_count,
    COALESCE(rfs.reliability_score, 0.8)::numeric AS source_reliability,
    -- freshness decay (half-life 12h)
    exp(
      - (ln(2.0) / 12.0)
      * GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(aef.published_at, now()))) / 3600.0, 0.0)
    )::numeric AS freshness_factor
  FROM articles_engagement_feed aef
  LEFT JOIN sources s ON s.id = aef.source_id
  LEFT JOIN rss_feed_sources rfs ON rfs.source_id = s.id
),
scored AS (
  SELECT
    b.article_id,
    b.category_id,
    b.source_id,
    b.published_at,
    b.engagement_score,
    b.source_reliability,
    b.freshness_factor,
    (
      b.engagement_score
      * (0.5 + 0.5 * b.source_reliability)
      * (0.3 + 0.7 * b.freshness_factor)
    )::numeric(14,4) AS ranking_score
  FROM base b
),
-- Diversity boost: penalize already-dominant sources to surface variety.
diversified AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (PARTITION BY s.source_id ORDER BY s.ranking_score DESC) AS source_rank
  FROM scored s
)
SELECT
  article_id,
  category_id,
  source_id,
  published_at,
  ranking_score,
  source_reliability,
  freshness_factor,
  (ranking_score * (1.0 / (1.0 + 0.1 * (source_rank - 1))))::numeric(14,4) AS final_score,
  now() AS computed_at
FROM diversified
WHERE ranking_score IS NOT NULL
ORDER BY final_score DESC NULLS LAST
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranked_feed_global_article
  ON ranked_feed_global (article_id);

CREATE INDEX IF NOT EXISTS idx_ranked_feed_global_final_score
  ON ranked_feed_global (final_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_ranked_feed_global_category_final
  ON ranked_feed_global (category_id, final_score DESC NULLS LAST);

GRANT SELECT ON ranked_feed_global TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2) Per-category ranked feed (materialized)
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS ranked_feed_category;

CREATE MATERIALIZED VIEW ranked_feed_category AS
SELECT
  category_id,
  article_id,
  source_id,
  published_at,
  final_score,
  ROW_NUMBER() OVER (
    PARTITION BY category_id
    ORDER BY final_score DESC NULLS LAST
  ) AS category_rank,
  now() AS computed_at
FROM ranked_feed_global
WHERE category_id IS NOT NULL
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranked_feed_category_unique
  ON ranked_feed_category (category_id, article_id);

CREATE INDEX IF NOT EXISTS idx_ranked_feed_category_rank
  ON ranked_feed_category (category_id, category_rank);

GRANT SELECT ON ranked_feed_category TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Breaking news view (recent + high click velocity)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW ranked_feed_breaking AS
WITH velocity AS (
  SELECT
    article_id,
    COUNT(*)::integer AS clicks_last_15m
  FROM article_clicks_partitioned
  WHERE clicked_at >= now() - interval '15 minutes'
  GROUP BY article_id
)
SELECT
  a.id AS article_id,
  a.title,
  a.category_id,
  a.source_id,
  a.published_at,
  COALESCE(v.clicks_last_15m, 0) AS clicks_last_15m,
  (
    COALESCE(v.clicks_last_15m, 0)::numeric
    + (
      CASE
        WHEN a.published_at IS NULL THEN 0
        WHEN a.published_at >= now() - interval '15 minutes' THEN 50
        WHEN a.published_at >= now() - interval '1 hour' THEN 25
        WHEN a.published_at >= now() - interval '3 hours' THEN 10
        ELSE 0
      END
    )
  )::numeric(14,4) AS breaking_score
FROM articles a
LEFT JOIN velocity v ON v.article_id = a.id
WHERE a.status = 'published'
  AND a.published_at IS NOT NULL
  AND a.published_at >= now() - interval '6 hours'
  AND (COALESCE(v.clicks_last_15m, 0) >= 5 OR a.published_at >= now() - interval '15 minutes')
ORDER BY breaking_score DESC, a.published_at DESC;

GRANT SELECT ON ranked_feed_breaking TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4) Personalized feed cache (per-user precomputed top items)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ranked_feed_personalized (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  rank smallint NOT NULL,
  personal_score numeric(14,4) NOT NULL,
  category_id uuid,
  source_id uuid,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_ranked_feed_personalized_user_rank
  ON ranked_feed_personalized (user_id, rank);

CREATE INDEX IF NOT EXISTS idx_ranked_feed_personalized_computed
  ON ranked_feed_personalized (computed_at);

-- ------------------------------------------------------------
-- 5) Refresh RPCs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_ranked_feeds()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY ranked_feed_global;
  REFRESH MATERIALIZED VIEW CONCURRENTLY ranked_feed_category;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_ranked_feeds() TO service_role;

CREATE OR REPLACE FUNCTION refresh_personalized_feed_for_user(
  p_user_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Remove previously cached items for this user.
  DELETE FROM ranked_feed_personalized WHERE user_id = p_user_id;

  WITH candidate AS (
    SELECT
      g.article_id,
      g.category_id,
      g.source_id,
      g.final_score,
      COALESCE(uca.score, 0)::numeric AS cat_score,
      COALESCE(usa.score, 0)::numeric AS src_score
    FROM ranked_feed_global g
    LEFT JOIN user_category_affinity uca
      ON uca.user_id = p_user_id AND uca.category_id = g.category_id
    LEFT JOIN user_source_affinity usa
      ON usa.user_id = p_user_id AND usa.source_id = g.source_id
    WHERE
      -- Exclude articles the user has already read.
      NOT EXISTS (
        SELECT 1 FROM user_read_history urh
        WHERE urh.user_id = p_user_id AND urh.article_id = g.article_id
      )
  ),
  scored AS (
    SELECT
      c.article_id,
      c.category_id,
      c.source_id,
      (
        c.final_score
        * (1.0 + 0.5 * LEAST(c.cat_score, 50.0) / 50.0)
        * (1.0 + 0.3 * LEAST(c.src_score, 50.0) / 50.0)
      )::numeric(14,4) AS personal_score
    FROM candidate c
  ),
  ranked AS (
    SELECT
      article_id, category_id, source_id, personal_score,
      ROW_NUMBER() OVER (ORDER BY personal_score DESC NULLS LAST)::smallint AS rank
    FROM scored
    ORDER BY personal_score DESC NULLS LAST
    LIMIT GREATEST(p_limit, 10)
  )
  INSERT INTO ranked_feed_personalized (
    user_id, article_id, rank, personal_score,
    category_id, source_id, computed_at
  )
  SELECT p_user_id, article_id, rank, personal_score,
         category_id, source_id, now()
  FROM ranked;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_personalized_feed_for_user(uuid, integer) TO service_role;

-- Batch refresh: drive personalized cache for users with recent activity.
CREATE OR REPLACE FUNCTION refresh_active_users_personalized_feeds(
  p_active_within_hours integer DEFAULT 24,
  p_batch_size integer DEFAULT 100
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
    SELECT DISTINCT urh.user_id
    FROM user_read_history urh
    WHERE urh.read_at >= now() - make_interval(hours => GREATEST(p_active_within_hours, 1))
    LIMIT GREATEST(p_batch_size, 1)
  LOOP
    BEGIN
      PERFORM refresh_personalized_feed_for_user(v_user.user_id, 100);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- continue with next user
      NULL;
    END;
  END LOOP;

  RETURN v_processed;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_active_users_personalized_feeds(integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 6) RLS — global feeds readable by everyone, personalized own-only
-- ------------------------------------------------------------
ALTER TABLE ranked_feed_personalized ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ranked_feed_personalized_select_own ON ranked_feed_personalized;
DROP POLICY IF EXISTS ranked_feed_personalized_write_service_role ON ranked_feed_personalized;

CREATE POLICY ranked_feed_personalized_select_own
  ON ranked_feed_personalized
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY ranked_feed_personalized_write_service_role
  ON ranked_feed_personalized
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
