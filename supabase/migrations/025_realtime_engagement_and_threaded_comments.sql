-- ============================================================
-- MIGRATION 025: Realtime engagement + threaded comments
--
-- Adds:
-- - article_comments.parent_id for nested replies
-- - realtime publication enrollment for engagement tables
-- - replica identity for reliable DELETE payloads in realtime
-- - engagement-scored trending view for feed ranking
-- ============================================================

-- 1) Threaded comments (Twitter-style)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'parent_id'
  ) THEN
    ALTER TABLE article_comments
      ADD COLUMN parent_id uuid NULL REFERENCES article_comments(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_article_comments_parent_id
  ON article_comments (parent_id);

CREATE INDEX IF NOT EXISTS idx_article_comments_article_parent_created
  ON article_comments (article_id, parent_id, created_at);

-- 2) Realtime payload support for INSERT/DELETE engagement events
ALTER TABLE IF EXISTS article_likes REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS article_comments REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS article_clicks REPLICA IDENTITY FULL;

-- 3) Ensure core engagement tables are in Supabase realtime publication
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'article_likes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE article_likes;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'article_comments'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE article_comments;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'article_clicks'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE article_clicks;
    END IF;
  END IF;
END $$;

-- 4) Engagement-scored article feed view (Option A: query-time computation)
CREATE OR REPLACE VIEW articles_engagement_feed AS
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
  s.name AS source_name,
  s.website_url AS source_website_url,
  s.logo_url AS source_logo_url,
  c.name AS category_name,
  c.slug AS category_slug,
  COALESCE(l.likes_count, 0)::int AS likes_count,
  COALESCE(cm.comments_count, 0)::int AS comments_count,
  COALESCE(cm.replies_count, 0)::int AS replies_count,
  0::int AS shares_count,
  COALESCE(v.views_count, 0)::int AS views_count,
  (
    (COALESCE(l.likes_count, 0) * 1.0)
    + (COALESCE(cm.comments_count, 0) * 2.0)
    + (COALESCE(cm.replies_count, 0) * 1.5)
    + 0.0 -- shares_count * 3.0 (placeholder until share tracking table is introduced)
    + (COALESCE(v.views_count, 0) * 0.2)
    - (
      GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, now()))) / 3600,
        0
      ) * 0.05
    )
  )::numeric(14,4) AS engagement_score
FROM articles a
LEFT JOIN sources s ON s.id = a.source_id
LEFT JOIN categories c ON c.id = a.category_id
LEFT JOIN (
  SELECT article_id, COUNT(*)::int AS likes_count
  FROM article_likes
  GROUP BY article_id
) l ON l.article_id = a.id
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
  FROM article_clicks
  GROUP BY article_id
) v ON v.article_id = a.id;

GRANT SELECT ON TABLE articles_engagement_feed TO anon, authenticated;
