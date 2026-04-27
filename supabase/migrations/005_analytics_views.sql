-- ============================================================
-- MIGRATION 005: Analytics helper views
-- Pre-aggregates click counts per source and provides an
-- all-time article click count view for the admin dashboard.
-- These views are read-only and never affect existing tables.
-- ============================================================

-- Per-source click totals (used by admin analytics dashboard)
CREATE VIEW source_click_counts AS
    SELECT source_id, COUNT(*) AS click_count
    FROM   article_clicks
    WHERE  source_id IS NOT NULL
    GROUP  BY source_id;

-- All-time article click totals (supplements the 24h trending view)
CREATE VIEW article_click_counts_alltime AS
    SELECT article_id, COUNT(*) AS click_count
    FROM   article_clicks
    GROUP  BY article_id;
