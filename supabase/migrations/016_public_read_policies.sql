-- ============================================================
-- MIGRATION 016: Confirm public read policies for core tables
--
-- Public content (articles, categories, sources, article_clicks,
-- article_likes, comments) must be readable without authentication
-- so the app functions correctly for anonymous users and when a
-- user's JWT has expired.
--
-- The policies below are idempotent — they are no-ops if the
-- policy already exists under the same name from an earlier
-- migration (001, 002, 012). They serve as documentation of
-- intentional public read access.
-- ============================================================

-- articles: public read (already set in 001, confirmed here)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'articles' AND policyname = 'articles_select_all'
  ) THEN
    CREATE POLICY "articles_select_all" ON articles
      FOR SELECT USING (true);
  END IF;
END $$;

-- categories: public read (already set in 001, confirmed here)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'categories' AND policyname = 'categories_select_all'
  ) THEN
    CREATE POLICY "categories_select_all" ON categories
      FOR SELECT USING (true);
  END IF;
END $$;

-- sources: public read (already set in 001, confirmed here)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sources' AND policyname = 'sources_select_all'
  ) THEN
    CREATE POLICY "sources_select_all" ON sources
      FOR SELECT USING (true);
  END IF;
END $$;

-- article_clicks: public read (already set in 002, confirmed here)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'article_clicks' AND policyname = 'article_clicks_select_all'
  ) THEN
    CREATE POLICY "article_clicks_select_all" ON article_clicks
      FOR SELECT USING (true);
  END IF;
END $$;

-- article_likes: public read (already set in 012, confirmed here)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'article_likes' AND policyname = 'Allow read article_likes'
  ) THEN
    CREATE POLICY "Allow read article_likes" ON article_likes
      FOR SELECT USING (true);
  END IF;
END $$;

-- comments / article_comments: public read
-- article_comments (used by commentService) — enable RLS + public SELECT if missing
ALTER TABLE IF EXISTS article_comments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'article_comments' AND policyname = 'article_comments_select_all'
  ) THEN
    CREATE POLICY "article_comments_select_all" ON article_comments
      FOR SELECT USING (true);
  END IF;
END $$;
