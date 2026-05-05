-- ============================================================
-- MIGRATION 013: Rename bookmarks.news_id → article_id
--
-- The live database may still have a 'news_id' column from the
-- original schema.  This migration performs a safe, zero-data-loss
-- rename and adds the foreign-key constraint to articles.id.
--
-- The migration is fully idempotent:
--   • Only renames the column when 'news_id' still exists.
--   • Only adds the FK when it does not already exist.
-- ============================================================

DO $$
BEGIN
  -- 1. Rename news_id → article_id (only if the old column is still present)
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'bookmarks'
      AND  column_name  = 'news_id'
  ) THEN
    ALTER TABLE bookmarks RENAME COLUMN news_id TO article_id;
  END IF;

  -- 2. Add NOT NULL constraint when the column was nullable under the old name
  --    (article_id must always point to a valid article).
  --    Guard: only set NOT NULL when there are no NULLs (data safety check).
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

  -- 3. Add foreign key article_id → articles.id (only when absent)
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.referential_constraints rc
    JOIN   information_schema.key_column_usage        kcu
           ON kcu.constraint_name   = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
    WHERE  kcu.table_schema  = 'public'
      AND  kcu.table_name    = 'bookmarks'
      AND  kcu.column_name   = 'article_id'
  ) THEN
    ALTER TABLE bookmarks
      ADD CONSTRAINT bookmarks_article_id_fkey
      FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE;
  END IF;

  -- 4. Ensure the supporting index exists (idempotent via CREATE INDEX IF NOT EXISTS)
  --    The index is created outside the DO block (below) because DDL inside a
  --    DO block cannot use IF NOT EXISTS with CREATE INDEX in PostgreSQL < 9.5.
END $$;

-- 4. Index on article_id for efficient reverse-lookup (no-op if already present)
CREATE INDEX IF NOT EXISTS idx_bookmarks_article_id ON bookmarks (article_id);
