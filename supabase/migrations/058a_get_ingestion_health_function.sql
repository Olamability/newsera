-- ============================================================================
-- 058a_get_ingestion_health_function.sql
-- Adds or updates ingestion health monitoring function
-- ============================================================================

CREATE OR REPLACE FUNCTION get_ingestion_health()
RETURNS TABLE (
  active_workers                 integer,
  recent_jobs                   integer,
  failed_jobs                   integer,
  latest_article_at            timestamp without time zone,
  latest_successful_ingestion_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT

    -- active workers in last 2 minutes
    COALESCE((
      SELECT COUNT(DISTINCT worker_id)::integer
      FROM worker_heartbeats
      WHERE status = 'alive'
        AND last_heartbeat_at > now() - interval '2 minutes'
    ), 0),

    -- recent ingestion activity
    COALESCE((
      SELECT COUNT(*)::integer
      FROM ingestion_jobs
      WHERE COALESCE(completed_at, started_at, last_run_at, updated_at)
            > now() - interval '1 hour'
    ), 0),

    -- failed jobs (last 24h)
    COALESCE((
      SELECT COUNT(*)::integer
      FROM ingestion_jobs
      WHERE COALESCE(status, last_status) = 'failed'
        AND COALESCE(completed_at, last_run_at, updated_at)
            > now() - interval '24 hours'
    ), 0),

    -- latest article timestamp (KEEP AS TIMESTAMP WITHOUT TIMEZONE)
    (SELECT MAX(published_at)::timestamp without time zone FROM articles),

    -- latest successful ingestion
    (SELECT MAX(COALESCE(completed_at, last_run_at))
     FROM ingestion_jobs
     WHERE COALESCE(status, last_status) = 'success');

END;
$$;
