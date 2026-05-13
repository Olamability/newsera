-- ============================================================
-- MIGRATION 026: Fix comment posting FK/RLS consistency
--
-- Goal:
-- - Ensure comment tables use article_id (not legacy news_id)
-- - Ensure authenticated inserts are allowed for owning user
-- - Ensure public read access exists for comments
-- ============================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'news_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'article_id'
  ) THEN
    ALTER TABLE article_comments RENAME COLUMN news_id TO article_id;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'comments'
      AND column_name = 'news_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'comments'
      AND column_name = 'article_id'
  ) THEN
    ALTER TABLE comments RENAME COLUMN news_id TO article_id;
  END IF;
END $$;

ALTER TABLE IF EXISTS article_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS comments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'article_comments'
      AND policyname = 'article_comments_select_all'
  ) THEN
    CREATE POLICY "article_comments_select_all"
      ON article_comments
      FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'article_comments'
      AND policyname = 'Allow authenticated users to insert comments'
  ) THEN
    CREATE POLICY "Allow authenticated users to insert comments"
      ON article_comments
      FOR INSERT
      TO authenticated
      WITH CHECK (
        auth.uid() IS NOT NULL
        AND auth.uid()::text = user_id
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'comments'
      AND policyname = 'Allow read comments'
  ) THEN
    CREATE POLICY "Allow read comments"
      ON comments
      FOR SELECT
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'comments'
      AND policyname = 'Allow authenticated insert'
  ) THEN
    CREATE POLICY "Allow authenticated insert"
      ON comments
      FOR INSERT
      TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
