-- ============================================================
-- TABLE: article_clicks
-- Tracks every time a user opens a full article URL
-- ============================================================
CREATE TABLE article_clicks (
    id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id  uuid        NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    source_id   uuid                 REFERENCES sources  (id) ON DELETE CASCADE,
    clicked_at  timestamptz NOT NULL DEFAULT now(),
    user_id     text
);

-- Indexes for performant aggregation and filtering
CREATE INDEX idx_article_clicks_article_id ON article_clicks (article_id);
CREATE INDEX idx_article_clicks_source_id  ON article_clicks (source_id);

-- ============================================================
-- VIEW: article_click_counts
-- Pre-aggregates click counts per article for efficient trending queries
-- ============================================================
CREATE VIEW article_click_counts AS
    SELECT article_id, COUNT(*) AS click_count
    FROM article_clicks
    GROUP BY article_id;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE article_clicks ENABLE ROW LEVEL SECURITY;

-- Anyone (incl. anon) can insert a click (anonymous tracking)
CREATE POLICY "article_clicks_insert_all" ON article_clicks
    FOR INSERT WITH CHECK (true);

-- Click data is readable by all (needed for trending queries)
CREATE POLICY "article_clicks_select_all" ON article_clicks
    FOR SELECT USING (true);
