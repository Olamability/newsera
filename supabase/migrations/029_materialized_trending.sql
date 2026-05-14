-- ============================================================
-- MIGRATION 029: Materialize the trending engagement feed
-- ============================================================

-- Drop old live view
DROP VIEW IF EXISTS articles_engagement_feed;

-- ============================================================
-- CREATE MATERIALIZED VIEW
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS articles_engagement_feed AS
SELECT
  a.id,
  a.title,
  a.content,
  a.snippet,
  a.source_id,
  a.image_url,
  a.published_at,
  a.url,
  a.category_id,

  s.name        AS source_name,
  s.website_url AS source_website_url,
  s.logo_url    AS source_logo_url,

  c.name        AS category_name,
  c.slug        AS category_slug,

  COALESCE(l.likes_count, 0)::int      AS likes_count,
  COALESCE(cm.comments_count, 0)::int  AS comments_count,
  COALESCE(cm.replies_count, 0)::int   AS replies_count,
  0::int                               AS shares_count,
  COALESCE(v.views_count, 0)::int      AS views_count,

  (
    (COALESCE(l.likes_count, 0) * 1.0)
    + (COALESCE(cm.comments_count, 0) * 2.0)
    + (COALESCE(cm.replies_count, 0) * 1.5)
    + (COALESCE(v.views_count, 0) * 0.2)
    - (
        GREATEST(
          EXTRACT(EPOCH FROM (
            now() - COALESCE(a.published_at, now())
          )) / 3600,
          0
        ) * 0.05
      )
  )::numeric(14,4) AS engagement_score

FROM articles a

LEFT JOIN sources s
  ON s.id = a.source_id

LEFT JOIN categories c
  ON c.id = a.category_id

LEFT JOIN (
  SELECT
    article_id,
    COUNT(*)::int AS likes_count
  FROM article_likes
  GROUP BY article_id
) l
  ON l.article_id = a.id

LEFT JOIN (
  SELECT
    article_id,
    COUNT(*) FILTER (
      WHERE parent_id IS NULL
    )::int AS comments_count,

    COUNT(*) FILTER (
      WHERE parent_id IS NOT NULL
    )::int AS replies_count

  FROM article_comments
  GROUP BY article_id
) cm
  ON cm.article_id = a.id

LEFT JOIN (
  SELECT
    article_id,
    COUNT(*)::int AS views_count
  FROM article_clicks
  GROUP BY article_id
) v
  ON v.article_id = a.id

-- Keep trending lightweight and recent
WHERE (
  a.published_at >= now() - INTERVAL '7 days'
  OR a.published_at IS NULL
)

WITH DATA;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_aef_id
  ON articles_engagement_feed (id);

CREATE INDEX IF NOT EXISTS idx_aef_engagement_score
  ON articles_engagement_feed (
    engagement_score DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS idx_aef_published_at
  ON articles_engagement_feed (
    published_at DESC NULLS LAST
  );

CREATE INDEX IF NOT EXISTS idx_aef_category_id
  ON articles_engagement_feed (category_id);

-- ============================================================
-- PERMISSIONS
-- ============================================================

GRANT SELECT ON articles_engagement_feed
TO anon, authenticated;

-- ============================================================
-- REFRESH FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_trending_feed()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW articles_engagement_feed;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_trending_feed()
TO service_role;
