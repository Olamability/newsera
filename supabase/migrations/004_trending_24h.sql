-- ============================================================
-- MIGRATION 004: Time-based trending (last 24 hours)
-- Replaces the all-time article_click_counts view with one
-- that only aggregates clicks from the past 24 hours so that
-- "trending" reflects recent activity, not historical totals.
-- ============================================================

DROP VIEW IF EXISTS article_click_counts;

CREATE VIEW article_click_counts AS
    SELECT article_id, COUNT(*) AS click_count
    FROM   article_clicks
    WHERE  clicked_at >= now() - interval '24 hours'
    GROUP  BY article_id;
