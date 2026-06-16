-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 063 · Article Outbound Click Tracking
-- ─────────────────────────────────────────────────────────────────────────────
-- Purpose:
--   Record every outbound click to a publisher's website so we can:
--     1. Report "NewsEra sent X visits this month" to publishers.
--     2. Confirm UTM parameters are being appended correctly.
--     3. Provide traffic attribution data to Google Analytics via utm_url.
--
-- This is SEPARATE from article_clicks (internal engagement / trending score).
-- article_clicks  = "user read/viewed this article inside the app"
-- article_outbound_clicks = "user left the app to the publisher's website"
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS article_outbound_clicks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  uuid        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id   uuid        REFERENCES sources(id) ON DELETE SET NULL,
  -- Nullable: guests produce a click with only device_id
  user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Always present — either auth user id or anonymous device id
  device_id   text        NOT NULL,
  clicked_at  timestamptz NOT NULL DEFAULT now(),
  -- 'ios' | 'android' | 'web'  (from Platform.OS)
  device_type text,
  -- The full URL that was actually opened, including UTM query params
  utm_url     text        NOT NULL
);

COMMENT ON TABLE article_outbound_clicks IS
  'Tracks every outbound tap to a publisher website. Use for traffic attribution reports to publishers and Google Analytics UTM verification.';

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Primary lookup: "how many clicks did article X get?"
CREATE INDEX IF NOT EXISTS idx_aoc_article_id
  ON article_outbound_clicks (article_id);

-- Publisher report: "how many clicks did source Y get this month?"
CREATE INDEX IF NOT EXISTS idx_aoc_source_id
  ON article_outbound_clicks (source_id)
  WHERE source_id IS NOT NULL;

-- Time-range queries for analytics dashboards
CREATE INDEX IF NOT EXISTS idx_aoc_clicked_at
  ON article_outbound_clicks (clicked_at DESC);

-- User history: "what external links has user Z clicked?"
CREATE INDEX IF NOT EXISTS idx_aoc_user_id
  ON article_outbound_clicks (user_id)
  WHERE user_id IS NOT NULL;

-- Composite index for deduplication queries (device + article + time window)
CREATE INDEX IF NOT EXISTS idx_aoc_dedup
  ON article_outbound_clicks (article_id, device_id, clicked_at DESC);

-- ── Row-Level Security ───────────────────────────────────────────────────────

ALTER TABLE article_outbound_clicks ENABLE ROW LEVEL SECURITY;

-- Any authenticated or anonymous (anon key) client can insert a click record.
-- No SELECT is needed from the client; analytics are read by service_role only.
CREATE POLICY "public_can_log_outbound_click"
  ON article_outbound_clicks
  FOR INSERT
  WITH CHECK (true);

-- Authenticated users can view their own click history (e.g., "recently visited").
CREATE POLICY "user_can_view_own_outbound_clicks"
  ON article_outbound_clicks
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role retains full access for admin analytics and publisher reports.
-- (No explicit policy needed — service_role bypasses RLS by default in Supabase.)

-- ── Publisher Traffic Summary View ───────────────────────────────────────────
-- A convenience view for the admin panel to show publisher traffic reports.

CREATE OR REPLACE VIEW publisher_traffic_summary AS
SELECT
  s.id                                    AS source_id,
  s.name                                  AS source_name,
  s.website_url                           AS source_website,
  COUNT(aoc.id)                           AS total_outbound_clicks,
  COUNT(aoc.id) FILTER (
    WHERE aoc.clicked_at >= date_trunc('month', now())
  )                                       AS clicks_this_month,
  COUNT(aoc.id) FILTER (
    WHERE aoc.clicked_at >= date_trunc('day', now())
  )                                       AS clicks_today,
  COUNT(DISTINCT aoc.device_id)           AS unique_devices,
  MAX(aoc.clicked_at)                     AS last_click_at
FROM sources s
LEFT JOIN article_outbound_clicks aoc ON aoc.source_id = s.id
GROUP BY s.id, s.name, s.website_url
ORDER BY clicks_this_month DESC;

COMMENT ON VIEW publisher_traffic_summary IS
  'Admin panel view: outbound click counts per publisher/source for traffic attribution reports.';
