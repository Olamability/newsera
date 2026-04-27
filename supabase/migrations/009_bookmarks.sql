-- ============================================================
-- MIGRATION 009: Recreate bookmarks table with article_id
--
-- The initial schema (001) created bookmarks with news_id
-- referencing the 'news' table. The app uses the 'articles'
-- table (as referenced in migrations 002+). This migration
-- drops the old bookmarks table and recreates it with
-- article_id referencing articles, with proper RLS.
-- ============================================================

-- Drop old bookmarks table from migration 001 (news_id variant)
DROP TABLE IF EXISTS bookmarks;

-- ============================================================
-- TABLE: bookmarks
-- ============================================================
CREATE TABLE bookmarks (
    id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    article_id uuid        NOT NULL REFERENCES articles (id)   ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bookmarks_user_article_unique UNIQUE (user_id, article_id)
);

-- Index for fast look-up of a user's bookmarks
CREATE INDEX idx_bookmarks_user_id    ON bookmarks (user_id);
CREATE INDEX idx_bookmarks_article_id ON bookmarks (article_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- Users can only read/write their own bookmarks
-- ============================================================
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bookmarks_select_own" ON bookmarks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "bookmarks_insert_own" ON bookmarks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bookmarks_delete_own" ON bookmarks
    FOR DELETE USING (auth.uid() = user_id);
