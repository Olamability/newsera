-- ============================================================
-- MIGRATION 029: Materialize the trending engagement feed
--
-- Converts articles_engagement_feed from a live query-time view
-- (which recalculates expensive aggregates on every request) into
-- a MATERIALIZED VIEW backed by a periodic refresh function.
--
-- Performance goal: trending queries stay fast at 100K+ articles
-- and millions of reactions/comments.
--
-- Refresh strategy:
--   Call refresh_trending_feed() from a cron job or Supabase
--   Edge Function on whatever cadence suits the traffic pattern
--   (e.g. every 5 minutes via pg_cron or an external scheduler).
-- ============================================================

-- 1) Drop the live view so we can replace it with a materialized view.
--    We keep the same name so existing client queries require no changes.
DROP VIEW IF EXISTS articles_engagement_feed;

-- 2) Create the materialized view with the same shape as the old view.
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
  s.name               AS source_name,
  s.website_url        AS source_website_url,
  s.logo_url           AS source_logo_url,
  c.name               AS category_name,
  c.slug               AS category_slug,
  COALESCE(l.likes_count, 0)::int                         AS likes_count,
  COALESCE(cm.comments_count, 0)::int                     AS comments_count,
  COALESCE(cm.replies_count, 0)::int                      AS replies_count,
  0::int                                                   AS shares_count,
  COALESCE(v.views_count, 0)::int                         AS views_count,
  (
    (COALESCE(l.likes_count, 0) * 1.0)
    + (COALESCE(cm.comments_count, 0) * 2.0)
    + (COALESCE(cm.replies_count, 0) * 1.5)
    + (COALESCE(v.views_count, 0) * 0.2)
    - (
        GREATEST(
          EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, now()))) / 3600,
          0
        ) * 0.05
      )
  )::numeric(14,4) AS engagement_score
FROM articles a
-- Limit to articles published in the last 7 days to keep the materialized
-- view compact and the refresh fast.  Older articles rarely re-enter trending.
WHERE a.published_at >= now() - INTERVAL '7 days'
   OR a.published_at IS NULL
LEFT JOIN sources     s  ON s.id  = a.source_id
LEFT JOIN categories  c  ON c.id  = a.category_id
LEFT JOIN (
  SELECT article_id, COUNT(*)::int AS likes_count
  FROM   article_likes
  GROUP  BY article_id
) l  ON l.article_id = a.id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS comments_count,
    COUNT(*) FILTER (WHERE parent_id IS NOT NULL)::int AS replies_count
  FROM article_comments
  GROUP BY article_id
) cm ON cm.article_id = a.id
LEFT JOIN (
  SELECT article_id, COUNT(*)::int AS views_count
  FROM   article_clicks
  GROUP  BY article_id
) v  ON v.article_id = a.id
WITH DATA;

-- 3) Indexes on the materialized view for fast feed queries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aef_id
  ON articles_engagement_feed (id);

CREATE INDEX IF NOT EXISTS idx_aef_engagement_score
  ON articles_engagement_feed (engagement_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_aef_published_at
  ON articles_engagement_feed (published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_aef_category_id
  ON articles_engagement_feed (category_id);

-- 4) Grant public read access (same as the old view).
GRANT SELECT ON articles_engagement_feed TO anon, authenticated;

-- 5) Refresh helper function called by the scheduler.
-- NOTE: REFRESH MATERIALIZED VIEW CONCURRENTLY requires the unique index
-- (idx_aef_id) to already exist.  The initial run of this migration creates
-- both the view and the index in one transaction, so CONCURRENTLY is safe for
-- all subsequent calls.  If for any reason the unique index is dropped, fall
-- back to a regular (non-concurrent, locking) refresh.
CREATE OR REPLACE FUNCTION refresh_trending_feed()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'articles_engagement_feed'
       AND indexname  = 'idx_aef_id'
  ) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY articles_engagement_feed;
  ELSE
    REFRESH MATERIALIZED VIEW articles_engagement_feed;
  END IF;
END;
$$;

-- Grant execute to service_role so it can be called from Edge Functions / cron.
GRANT EXECUTE ON FUNCTION refresh_trending_feed() TO service_role;
