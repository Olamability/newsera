-- ============================================================
-- MIGRATION 015: Ensure articles.category_id FK to categories
--
-- The initial schema (001) defined this FK, but on databases
-- that were set up before that schema was applied the constraint
-- may be absent, which causes Supabase's relational query
-- (categories join) to return null.
--
-- This migration is fully idempotent: it only adds the FK when
-- it does not already exist.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.referential_constraints rc
    JOIN   information_schema.key_column_usage        kcu
           ON kcu.constraint_name   = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
    WHERE  kcu.table_schema = 'public'
      AND  kcu.table_name   = 'articles'
      AND  kcu.column_name  = 'category_id'
  ) THEN
    ALTER TABLE articles
      ADD CONSTRAINT articles_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL;
  END IF;
END $$;
