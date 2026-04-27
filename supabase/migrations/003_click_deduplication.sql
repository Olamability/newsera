-- ============================================================
-- MIGRATION 003: Click deduplication / spam protection
-- Adds device_id column to article_clicks for per-device
-- deduplication, plus a composite index for efficient lookups.
-- ============================================================

ALTER TABLE article_clicks
    ADD COLUMN device_id text;

-- Composite index used by the 30-second dedup query:
--   WHERE article_id = $1 AND device_id = $2 AND clicked_at >= now() - interval '30 seconds'
-- Including clicked_at in the index allows the range condition to be resolved within the index.
CREATE INDEX idx_article_clicks_device_article
    ON article_clicks (article_id, device_id, clicked_at);
