-- ============================================================
-- MIGRATION 044: Scaling indexes, retention jobs, realtime scoping
-- - Additional pagination/feed indexes
-- - Retention RPCs for queue / DLQ / notifications / heartbeats
-- - pg_cron schedules for refresh / cleanup / reaping
-- - Realtime publication notes (scope to canonical tables only)
-- - All additive and idempotent
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Pagination + feed serving indexes
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_articles_status_published_at
  ON articles (status, published_at DESC NULLS LAST)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_articles_category_published_at
  ON articles (category_id, published_at DESC NULLS LAST)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_articles_source_published_at
  ON articles (source_id, published_at DESC NULLS LAST)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_article_clicks_user_clicked
  ON article_clicks (user_id, clicked_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_article_reactions_user_updated
  ON article_reactions (user_id, updated_at DESC);

-- ------------------------------------------------------------
-- 2) Retention RPCs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_job_queue(p_keep_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM job_queue
  WHERE status IN ('success', 'dead')
    AND finished_at < now() - make_interval(days => GREATEST(p_keep_days, 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_job_queue(integer) TO service_role;

CREATE OR REPLACE FUNCTION cleanup_job_dead_letter(p_keep_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM job_dead_letter
  WHERE failed_at < now() - make_interval(days => GREATEST(p_keep_days, 7))
    AND replayed_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_job_dead_letter(integer) TO service_role;

CREATE OR REPLACE FUNCTION cleanup_notification_events(p_keep_days integer DEFAULT 14)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM notification_events
  WHERE status IN ('completed', 'failed')
    AND processed_at < now() - make_interval(days => GREATEST(p_keep_days, 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_notification_events(integer) TO service_role;

CREATE OR REPLACE FUNCTION cleanup_notification_deliveries(p_keep_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM notification_deliveries
  WHERE status IN ('delivered', 'failed', 'skipped')
    AND COALESCE(delivered_at, sent_at, created_at)
        < now() - make_interval(days => GREATEST(p_keep_days, 7));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_notification_deliveries(integer) TO service_role;

CREATE OR REPLACE FUNCTION cleanup_worker_heartbeats(p_keep_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM worker_heartbeats
  WHERE status IN ('crashed', 'stopped')
    AND last_heartbeat_at < now() - make_interval(days => GREATEST(p_keep_days, 1));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_worker_heartbeats(integer) TO service_role;

CREATE OR REPLACE FUNCTION cleanup_stale_personalized_feeds(p_keep_hours integer DEFAULT 48)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM ranked_feed_personalized
  WHERE computed_at < now() - make_interval(hours => GREATEST(p_keep_hours, 6));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_stale_personalized_feeds(integer) TO service_role;

-- ------------------------------------------------------------
-- 3) pg_cron schedules (best-effort; skip silently if unavailable)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_jobs jsonb := '[
    {"name": "reap_expired_job_leases_1m",        "cron": "* * * * *",       "sql": "SELECT public.reap_expired_job_leases();"},
    {"name": "mark_stale_workers_crashed_2m",     "cron": "*/2 * * * *",     "sql": "SELECT public.mark_stale_workers_crashed(180);"},
    {"name": "refresh_ranked_feeds_5m",           "cron": "*/5 * * * *",     "sql": "SELECT public.refresh_ranked_feeds();"},
    {"name": "process_pending_personalization_1m","cron": "* * * * *",       "sql": "SELECT public.process_pending_personalization(100);"},
    {"name": "refresh_active_personalized_15m",   "cron": "*/15 * * * *",    "sql": "SELECT public.refresh_active_users_personalized_feeds(24, 200);"},
    {"name": "cleanup_job_queue_daily",           "cron": "15 3 * * *",      "sql": "SELECT public.cleanup_job_queue(7);"},
    {"name": "cleanup_job_dead_letter_weekly",    "cron": "30 3 * * 0",      "sql": "SELECT public.cleanup_job_dead_letter(30);"},
    {"name": "cleanup_notification_events_daily", "cron": "45 3 * * *",      "sql": "SELECT public.cleanup_notification_events(14);"},
    {"name": "cleanup_notification_deliveries_d", "cron": "50 3 * * *",      "sql": "SELECT public.cleanup_notification_deliveries(30);"},
    {"name": "cleanup_worker_heartbeats_daily",   "cron": "55 3 * * *",      "sql": "SELECT public.cleanup_worker_heartbeats(7);"},
    {"name": "cleanup_personalized_feeds_daily",  "cron": "5 4 * * *",       "sql": "SELECT public.cleanup_stale_personalized_feeds(48);"}
  ]'::jsonb;
  v_job jsonb;
  v_existing integer;
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN insufficient_privilege THEN RETURN;
    WHEN undefined_file        THEN RETURN;
  END;

  FOR v_job IN SELECT jsonb_array_elements(v_jobs) LOOP
    BEGIN
      SELECT jobid INTO v_existing
      FROM cron.job
      WHERE jobname = v_job->>'name'
      LIMIT 1;

      IF v_existing IS NOT NULL THEN
        PERFORM cron.unschedule(v_existing);
      END IF;

      PERFORM cron.schedule(
        v_job->>'name',
        v_job->>'cron',
        v_job->>'sql'
      );
    EXCEPTION
      WHEN undefined_table
        OR undefined_function
        OR invalid_schema_name THEN
        RETURN;
    END;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4) Realtime publication scoping
-- - Keep canonical engagement tables (already enrolled in 025).
-- - Do NOT add high-volume queue/delivery tables to realtime to avoid
--   over-broadcasting; observability is admin-pull, not client-push.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Ensure 'notifications' (canonical user inbox) is in realtime for
    -- in-app unread updates. Already may be enrolled; guard idempotently.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'notifications'
    ) THEN
      BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;
END $$;

RESET ROLE;
