-- ============================================================
-- MIGRATION 032: Phase 3 performance hardening
-- ============================================================

-- 1) Trending feed: optimize sorting path and periodic refresh.
CREATE INDEX IF NOT EXISTS idx_aef_engagement_published
  ON articles_engagement_feed (
    engagement_score DESC NULLS LAST,
    published_at DESC NULLS LAST
  );

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aef_id
  ON articles_engagement_feed (id);

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

DO $$
DECLARE
  existing_job_id integer;
BEGIN
  -- pg_cron is available on Supabase hosted Postgres. If unavailable,
  -- skip silently so migration remains portable.
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RETURN;
    WHEN undefined_file THEN
      RETURN;
  END;

  BEGIN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'refresh_trending_feed_every_5m'
    LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
      'refresh_trending_feed_every_5m',
      '*/5 * * * *',
      $job$SELECT public.refresh_trending_feed();$job$
    );
  EXCEPTION
    WHEN undefined_table OR undefined_function OR invalid_schema_name THEN
      -- cron schema/function not available in this environment.
      RETURN;
  END;
END $$;

-- 2) Search: explicit title+snippet full-text vector + GIN index.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS fts_title_snippet tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'english',
        coalesce(title, '') || ' ' || coalesce(snippet, '')
      )
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_articles_fts_title_snippet
  ON articles USING GIN (fts_title_snippet);

-- 3) Reactions: SQL aggregation helper to avoid client-side full-row counting.
CREATE OR REPLACE FUNCTION get_article_reaction_counts(p_article_id uuid)
RETURNS TABLE (
  reaction_type text,
  reaction_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    ar.reaction_type,
    COUNT(*)::bigint AS reaction_count
  FROM article_reactions ar
  WHERE ar.article_id = p_article_id
  GROUP BY ar.reaction_type;
$$;

GRANT EXECUTE ON FUNCTION get_article_reaction_counts(uuid)
TO anon, authenticated;
