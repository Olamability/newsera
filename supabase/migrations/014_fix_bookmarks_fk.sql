-- ============================================================
-- MIGRATION 014: Fix bookmarks foreign key
--
-- The live database may have an old FK constraint
-- 'bookmarks_news_id_fkey' that references a 'news' table
-- instead of the 'articles' table, causing FK violations.
--
-- This migration is fully idempotent:
--   1. Drops the stale bookmarks_news_id_fkey constraint if present.
--   2. Renames news_id → article_id when the old column still exists.
--   3. Adds the correct FK (article_id → articles.id ON DELETE CASCADE)
--      when no FK on article_id is present yet.
--   4. Ensures a supporting index exists.
-- ============================================================

DO $$
BEGIN
  -- 1. Drop the old stale FK that points to the 'news' table
  IF EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_schema = 'public'
      AND  table_name        = 'bookmarks'
      AND  constraint_name   = 'bookmarks_news_id_fkey'
      AND  constraint_type   = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE bookmarks DROP CONSTRAINT bookmarks_news_id_fkey;
  END IF;

  -- 2. Rename news_id → article_id (only when the old column still exists)
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'bookmarks'
      AND  column_name  = 'news_id'
  ) THEN
    ALTER TABLE bookmarks RENAME COLUMN news_id TO article_id;
  END IF;

  -- 3. Set NOT NULL when the column is nullable and has no NULLs
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'bookmarks'
      AND  column_name  = 'article_id'
      AND  is_nullable  = 'YES'
  ) AND NOT EXISTS (
    SELECT 1 FROM bookmarks WHERE article_id IS NULL
  ) THEN
    ALTER TABLE bookmarks ALTER COLUMN article_id SET NOT NULL;
  END IF;

  -- 4. Add the correct FK (article_id → articles.id) if absent
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.referential_constraints rc
    JOIN   information_schema.key_column_usage        kcu
           ON kcu.constraint_name   = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
    WHERE  kcu.table_schema = 'public'
      AND  kcu.table_name   = 'bookmarks'
      AND  kcu.column_name  = 'article_id'
  ) THEN
    ALTER TABLE bookmarks
      ADD CONSTRAINT bookmarks_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE;
  END IF;
END $$;

-- 5. Supporting index (no-op if already present)
CREATE INDEX IF NOT EXISTS idx_bookmarks_article_id ON bookmarks (article_id);
