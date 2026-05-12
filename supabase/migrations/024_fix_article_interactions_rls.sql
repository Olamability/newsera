-- ============================================================
-- MIGRATION 024: Fix RLS for article comments and likes
--
-- Goal:
-- - Public read for comments/likes
-- - Authenticated-only inserts
-- - Owner-only deletes
-- - No guest like/comment inserts
-- ============================================================

ALTER TABLE IF EXISTS article_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS article_likes ENABLE ROW LEVEL SECURITY;

-- ── article_comments ─────────────────────────────────────────

DROP POLICY IF EXISTS "Allow insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow delete own comment" ON article_comments;
DROP POLICY IF EXISTS "Allow authenticated users to insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow users to delete own comments" ON article_comments;

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

CREATE POLICY "Allow authenticated users to insert comments"
  ON article_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid()::text = user_id
  );

CREATE POLICY "Allow users to delete own comments"
  ON article_comments
  FOR DELETE
  TO authenticated
  USING (auth.uid()::text = user_id);

-- ── article_likes ────────────────────────────────────────────

DROP POLICY IF EXISTS "Allow insert like (auth)" ON article_likes;
DROP POLICY IF EXISTS "Allow insert like (guest)" ON article_likes;
DROP POLICY IF EXISTS "Allow delete own like" ON article_likes;
DROP POLICY IF EXISTS "Allow authenticated users to insert likes" ON article_likes;
DROP POLICY IF EXISTS "Allow users to delete own likes" ON article_likes;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'article_likes'
      AND policyname = 'Allow read article_likes'
  ) THEN
    CREATE POLICY "Allow read article_likes"
      ON article_likes
      FOR SELECT
      USING (true);
  END IF;
END $$;

CREATE POLICY "Allow authenticated users to insert likes"
  ON article_likes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid()::text = user_id
  );

CREATE POLICY "Allow users to delete own likes"
  ON article_likes
  FOR DELETE
  TO authenticated
  USING (auth.uid()::text = user_id);
