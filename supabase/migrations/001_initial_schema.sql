-- Enable UUID generation extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: categories
-- ============================================================
CREATE TABLE categories (
    id   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name text NOT NULL,
    slug text NOT NULL,
    CONSTRAINT categories_name_unique UNIQUE (name),
    CONSTRAINT categories_slug_unique UNIQUE (slug)
);

-- ============================================================
-- TABLE: sources
-- ============================================================
CREATE TABLE sources (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        text NOT NULL,
    website_url text,
    rss_url     text,
    logo_url    text,
    category_id uuid REFERENCES categories (id) ON DELETE SET NULL,
    status      text NOT NULL DEFAULT 'pending',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sources_status_check CHECK (status IN ('pending', 'active', 'inactive'))
);

-- Index for filtering sources by category and status
CREATE INDEX idx_sources_category_id ON sources (category_id);
CREATE INDEX idx_sources_status       ON sources (status);

-- ============================================================
-- TABLE: news
-- ============================================================
CREATE TABLE news (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    title        text NOT NULL,
    content      text,
    snippet      text,
    source_id    uuid REFERENCES sources (id) ON DELETE SET NULL,
    image_url    text,
    published_at timestamptz,
    url          text NOT NULL,
    category_id  uuid REFERENCES categories (id) ON DELETE SET NULL,
    CONSTRAINT news_url_unique UNIQUE (url)
);

-- Indexes optimised for the most common query patterns:
--   • sort / filter by publication date
--   • combined category + date queries (also covers category-only queries)
CREATE INDEX idx_news_published_at   ON news (published_at DESC);
CREATE INDEX idx_news_category_date  ON news (category_id, published_at DESC);
CREATE INDEX idx_news_source_id      ON news (source_id);

-- ============================================================
-- TABLE: bookmarks
-- ============================================================
CREATE TABLE bookmarks (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    news_id    uuid NOT NULL REFERENCES news (id)       ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bookmarks_user_news_unique UNIQUE (user_id, news_id)
);

-- Indexes for fetching a user's bookmarks and for reverse-lookup
CREATE INDEX idx_bookmarks_user_id ON bookmarks (user_id);
CREATE INDEX idx_bookmarks_news_id ON bookmarks (news_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- categories: publicly readable, only service-role can write
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "categories_select_all" ON categories
    FOR SELECT USING (true);

-- sources: publicly readable, only service-role can write
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sources_select_all" ON sources
    FOR SELECT USING (true);

-- news: publicly readable, only service-role can write
ALTER TABLE news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "news_select_all" ON news
    FOR SELECT USING (true);

-- bookmarks: users can only read/write their own bookmarks
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bookmarks_select_own" ON bookmarks
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "bookmarks_insert_own" ON bookmarks
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "bookmarks_delete_own" ON bookmarks
    FOR DELETE USING (auth.uid() = user_id);
