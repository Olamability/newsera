-- ============================================================
-- MIGRATION 035: Phase 3 production hardening layer
-- - Performance hardening (partition strategy, indexes, retention)
-- - Query optimization for engagement/feed joins
-- - Security hardening for personalization and reactions
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Partition strategy for article_clicks (staged, non-breaking)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_clicks_partitioned (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id text,
  PRIMARY KEY (id, clicked_at)
) PARTITION BY RANGE (clicked_at);

CREATE INDEX IF NOT EXISTS idx_article_clicks_part_article_clicked
  ON article_clicks_partitioned (article_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_clicks_part_source_clicked
  ON article_clicks_partitioned (source_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_clicks_part_user_clicked
  ON article_clicks_partitioned (user_id, clicked_at DESC);

CREATE TABLE IF NOT EXISTS article_clicks_partitioned_default
  PARTITION OF article_clicks_partitioned DEFAULT;

DO $$
DECLARE
  -- Rolling partition window for active traffic:
  -- previous month + current month + next two months.
  -- Older historical rows are routed into the DEFAULT partition during backfill.
  start_month date := (date_trunc('month', now()) - interval '1 month')::date;
  end_month date := (date_trunc('month', now()) + interval '2 months')::date;
  cursor_month date;
  partition_name text;
BEGIN
  cursor_month := start_month;

  WHILE cursor_month <= end_month LOOP
    partition_name := format('article_clicks_p_%s', to_char(cursor_month, 'YYYYMM'));

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF article_clicks_partitioned FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      cursor_month::timestamptz,
      (cursor_month + interval '1 month')::timestamptz
    );

    cursor_month := (cursor_month + interval '1 month')::date;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION mirror_article_clicks_to_partitioned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO article_clicks_partitioned (id, article_id, source_id, clicked_at, user_id, device_id)
  VALUES (
    NEW.id,
    NEW.article_id,
    NEW.source_id,
    COALESCE(NEW.clicked_at::timestamptz, now()),
    NEW.user_id,
    NEW.device_id
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_article_clicks_to_partitioned ON article_clicks;
CREATE TRIGGER trg_mirror_article_clicks_to_partitioned
AFTER INSERT ON article_clicks
FOR EACH ROW
EXECUTE FUNCTION mirror_article_clicks_to_partitioned();

-- One-time backfill into partitioned store.
-- user_id handling is defensive because historical environments may hold either
-- uuid-typed user_id (newer schema) or text-typed UUID strings (legacy schema).
INSERT INTO article_clicks_partitioned (id, article_id, source_id, clicked_at, user_id, device_id)
SELECT
  c.id,
  c.article_id,
  c.source_id,
  COALESCE(c.clicked_at::timestamptz, now()) AS clicked_at,
  CASE
    WHEN pg_typeof(c.user_id)::text = 'uuid' THEN c.user_id::uuid
    WHEN c.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN c.user_id::text::uuid
    ELSE NULL
  END,
  c.device_id
FROM article_clicks c
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 2) Retention cleanup strategy for rss_ingestion_log
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_rss_ingestion_log(p_keep_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer := 0;
BEGIN
  DELETE FROM rss_ingestion_log
  WHERE started_at < now() - make_interval(days => p_keep_days);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_rss_ingestion_log(integer) TO service_role;

DO $$
DECLARE
  existing_job_id integer;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN insufficient_privilege OR undefined_file THEN
      RETURN;
  END;

  BEGIN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'cleanup_rss_ingestion_log_daily'
    LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
      'cleanup_rss_ingestion_log_daily',
      '15 2 * * *',
      $job$SELECT public.cleanup_rss_ingestion_log(30);$job$
    );
  EXCEPTION
    WHEN undefined_table OR undefined_function OR invalid_schema_name THEN
      RETURN;
  END;
END $$;

-- ------------------------------------------------------------
-- 3) High-frequency index hardening
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_desc
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_user_created_desc
  ON inbox_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_comments_article_created_desc
  ON article_comments (article_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_reactions_article_type_updated_desc
  ON article_reactions (article_id, reaction_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_articles_feed_lookup
  ON articles (category_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_shares_article_created_desc
  ON article_shares (article_id, created_at DESC);

-- ------------------------------------------------------------
-- 4) Engagement/feed query optimization
-- ------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS articles_engagement_feed;

CREATE MATERIALIZED VIEW articles_engagement_feed AS
SELECT
  a.id,
  a.title,
  a.content,
  a.snippet,
  a.source_id,
  a.image_url,
  a.published_at,
  a.url,
  a.category_id,
  s.name AS source_name,
  s.website_url AS source_website_url,
  s.logo_url AS source_logo_url,
  c.name AS category_name,
  c.slug AS category_slug,
  COALESCE(r.likes_count, 0)::int AS likes_count,
  COALESCE(cm.comments_count, 0)::int AS comments_count,
  COALESCE(cm.replies_count, 0)::int AS replies_count,
  COALESCE(sh.shares_count, 0)::int AS shares_count,
  COALESCE(v.views_count, 0)::int AS views_count,
  (
    (COALESCE(r.likes_count, 0) * 1.0)
    + (COALESCE(cm.comments_count, 0) * 2.0)
    + (COALESCE(cm.replies_count, 0) * 1.5)
    + (COALESCE(sh.shares_count, 0) * 3.0)
    + (COALESCE(v.views_count, 0) * 0.2)
    - (
      GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, now()))) / 3600,
        0
      ) * 0.05
    )
  )::numeric(14,4) AS engagement_score
FROM articles a
LEFT JOIN sources s ON s.id = a.source_id
LEFT JOIN categories c ON c.id = a.category_id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*) FILTER (WHERE reaction_type = 'like')::int AS likes_count
  FROM article_reactions
  GROUP BY article_id
) r ON r.article_id = a.id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS comments_count,
    COUNT(*) FILTER (WHERE parent_id IS NOT NULL)::int AS replies_count
  FROM article_comments
  GROUP BY article_id
) cm ON cm.article_id = a.id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*)::int AS shares_count
  FROM article_shares
  GROUP BY article_id
) sh ON sh.article_id = a.id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*)::int AS views_count
  FROM article_clicks_partitioned
  GROUP BY article_id
) v ON v.article_id = a.id
WHERE (
  a.status = 'published'
  AND a.published_at IS NOT NULL
  AND a.published_at >= now() - interval '7 days'
)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aef_id
  ON articles_engagement_feed (id);

CREATE INDEX IF NOT EXISTS idx_aef_engagement_score
  ON articles_engagement_feed (engagement_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_aef_engagement_published
  ON articles_engagement_feed (engagement_score DESC NULLS LAST, published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_aef_category_id
  ON articles_engagement_feed (category_id);

GRANT SELECT ON articles_engagement_feed TO anon, authenticated;

CREATE OR REPLACE FUNCTION refresh_trending_feed()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY articles_engagement_feed;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_trending_feed() TO service_role;

-- ------------------------------------------------------------
-- 5) Security hardening
-- ------------------------------------------------------------
-- user_interests: remove globally-open policies and enforce owner-only access.
ALTER TABLE IF EXISTS user_interests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_interests_select_all" ON user_interests;
DROP POLICY IF EXISTS "user_interests_insert_all" ON user_interests;
DROP POLICY IF EXISTS "user_interests_update_all" ON user_interests;
DROP POLICY IF EXISTS user_interests_select_own ON user_interests;
DROP POLICY IF EXISTS user_interests_insert_own ON user_interests;
DROP POLICY IF EXISTS user_interests_update_own ON user_interests;
DROP POLICY IF EXISTS user_interests_delete_own ON user_interests;

CREATE POLICY user_interests_select_own
  ON user_interests
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id_uuid
    OR auth.uid()::text = user_id
  );

CREATE POLICY user_interests_insert_own
  ON user_interests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id_uuid
    OR auth.uid()::text = user_id
  );

CREATE POLICY user_interests_update_own
  ON user_interests
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id_uuid
    OR auth.uid()::text = user_id
  )
  WITH CHECK (
    auth.uid() = user_id_uuid
    OR auth.uid()::text = user_id
  );

CREATE POLICY user_interests_delete_own
  ON user_interests
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id_uuid
    OR auth.uid()::text = user_id
  );

-- user_read_history already owner-scoped in phase 2; ensure no broad policy exists.
ALTER TABLE IF EXISTS user_read_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_read_history_select_all ON user_read_history;
DROP POLICY IF EXISTS user_read_history_insert_all ON user_read_history;
DROP POLICY IF EXISTS user_read_history_update_all ON user_read_history;
DROP POLICY IF EXISTS user_read_history_delete_all ON user_read_history;

-- article_reactions: keep anonymous aggregate access via RPC only; table rows are auth-only.
ALTER TABLE IF EXISTS article_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS article_reactions_select_public ON article_reactions;
DROP POLICY IF EXISTS article_reactions_select_authenticated ON article_reactions;

CREATE POLICY article_reactions_select_authenticated
  ON article_reactions
  FOR SELECT
  TO authenticated
  USING (true);
