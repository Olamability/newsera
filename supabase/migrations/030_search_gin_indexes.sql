-- ============================================================
-- MIGRATION 030: PostgreSQL full-text search groundwork
--
-- Adds tsvector columns and GIN indexes to the articles table
-- so that future search queries can leverage fast index scans
-- instead of slow sequential LIKE / ILIKE scans.
--
-- The current search API is unchanged — existing queries continue
-- to work.  This migration only adds the index infrastructure so
-- that a follow-up migration (or RPC) can opt into FTS.
-- ============================================================

-- 1) Add generated tsvector columns (English stemming + stop-word removal).
--    GENERATED ALWAYS keeps the columns automatically in sync on INSERT/UPDATE.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS fts_title tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS fts_content tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(title,   '') || ' ' ||
        coalesce(snippet, '') || ' ' ||
        coalesce(content, '')
      )
    ) STORED;

-- 2) GIN indexes on the tsvector columns for sub-millisecond FTS lookups.
CREATE INDEX IF NOT EXISTS idx_articles_fts_title
  ON articles USING GIN (fts_title);

CREATE INDEX IF NOT EXISTS idx_articles_fts_content
  ON articles USING GIN (fts_content);

-- 3) Supporting B-tree indexes that benefit both existing queries and future
--    filtered FTS (e.g. search within a category, ordered by date).
CREATE INDEX IF NOT EXISTS idx_articles_published_at
  ON articles (published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_articles_category_published
  ON articles (category_id, published_at DESC NULLS LAST);
