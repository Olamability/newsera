-- ============================================================
-- DIAGNOSTIC AND FIX SCRIPT: Admin RSS Feeds Not Being Ingested
-- ============================================================
-- Run this script to diagnose why admin-created RSS feeds are not
-- being picked up by the ingestion workers, and apply fixes.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- STEP 1: DIAGNOSTIC QUERIES
-- ------------------------------------------------------------

-- 1a) Show all feeds with their eligibility status
SELECT 
  f.id,
  f.name,
  f.url,
  f.is_active,
  f.next_fetch_at,
  f.backoff_seconds,
  f.consecutive_failures,
  f.last_error,
  f.source_id,
  f.created_at,
  CASE 
    WHEN NOT f.is_active THEN 'INACTIVE'
    WHEN f.next_fetch_at IS NULL THEN 'NULL next_fetch_at'
    WHEN f.next_fetch_at > now() THEN 'FUTURE next_fetch_at (' || (f.next_fetch_at - now())::text || ')'
    WHEN EXISTS (
      SELECT 1 FROM ingestion_jobs ij
      WHERE ij.feed_id = f.id
        AND ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    ) THEN 'LEASED'
    ELSE 'ELIGIBLE'
  END AS eligibility_status,
  ij.last_status as job_status,
  ij.leased_until as job_leased_until,
  ij.last_run_at as job_last_run
FROM rss_feed_sources f
LEFT JOIN ingestion_jobs ij ON ij.feed_id = f.id
ORDER BY f.created_at DESC
LIMIT 20;

-- 1b) Count feeds by eligibility status
SELECT 
  COUNT(*) FILTER (WHERE NOT f.is_active) as inactive_count,
  COUNT(*) FILTER (WHERE f.is_active AND f.next_fetch_at IS NULL) as null_next_fetch_count,
  COUNT(*) FILTER (WHERE f.is_active AND f.next_fetch_at > now()) as future_next_fetch_count,
  COUNT(*) FILTER (WHERE 
    f.is_active 
    AND f.next_fetch_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_jobs ij
      WHERE ij.feed_id = f.id
        AND ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    )
  ) as eligible_count,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM ingestion_jobs ij
    WHERE ij.feed_id = f.id
      AND ij.leased_until IS NOT NULL
      AND ij.leased_until > now()
  )) as leased_count,
  COUNT(*) as total_count
FROM rss_feed_sources f;

-- 1c) Show feeds that should be eligible but might have issues
SELECT 
  f.id,
  f.name,
  f.url,
  f.is_active,
  f.next_fetch_at,
  f.backoff_seconds,
  f.consecutive_failures,
  f.last_error,
  f.created_at,
  'Missing next_fetch_at or in backoff' as issue
FROM rss_feed_sources f
WHERE f.is_active = true
  AND (
    f.next_fetch_at IS NULL 
    OR f.next_fetch_at > now() + interval '10 minutes'
    OR f.backoff_seconds > 3600
    OR f.consecutive_failures >= 5
  )
ORDER BY f.created_at DESC;

-- 1d) Check if there are any feeds without ingestion_jobs rows
SELECT 
  f.id,
  f.name,
  f.url,
  f.is_active,
  f.next_fetch_at,
  'No ingestion_jobs row' as status
FROM rss_feed_sources f
WHERE NOT EXISTS (
  SELECT 1 FROM ingestion_jobs ij WHERE ij.feed_id = f.id
)
AND f.is_active = true;

-- 1e) Show the exact eligibility check result (what lease_due_feeds sees)
WITH eligible AS (
  SELECT 
    f.id,
    f.name,
    f.url,
    f.is_active,
    f.next_fetch_at,
    f.priority,
    f.reliability_score
  FROM rss_feed_sources f
  WHERE f.is_active = true
    AND f.next_fetch_at <= now()
    AND NOT EXISTS (
      SELECT 1
      FROM ingestion_jobs ij
      WHERE ij.feed_id = f.id
        AND ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    )
  ORDER BY f.priority DESC, f.next_fetch_at ASC
  LIMIT 10
)
SELECT * FROM eligible;

-- ------------------------------------------------------------
-- STEP 2: FIX - Backfill problematic feeds
-- ------------------------------------------------------------

-- 2a) Fix feeds with NULL next_fetch_at
UPDATE rss_feed_sources
SET next_fetch_at = now()
WHERE is_active = true
  AND next_fetch_at IS NULL;

-- 2b) Fix feeds with future next_fetch_at (more than 1 hour ahead)
UPDATE rss_feed_sources
SET next_fetch_at = now()
WHERE is_active = true
  AND next_fetch_at > now() + interval '1 hour';

-- 2c) Reset feeds stuck in backoff for more than 6 hours
UPDATE rss_feed_sources
SET backoff_seconds = 0,
    next_fetch_at = now(),
    consecutive_failures = 0,
    last_error = NULL
WHERE is_active = true
  AND backoff_seconds > 21600; -- 6 hours

-- 2d) Reset feeds with high consecutive failures
UPDATE rss_feed_sources
SET consecutive_failures = 0,
    backoff_seconds = 0,
    next_fetch_at = now(),
    last_error = NULL
WHERE is_active = true
  AND consecutive_failures >= 5;

-- ------------------------------------------------------------
-- STEP 3: VERIFY FIXES
-- ------------------------------------------------------------

-- 3a) Re-run eligibility check
SELECT 
  COUNT(*) as eligible_feeds_after_fix
FROM rss_feed_sources f
WHERE f.is_active = true
  AND f.next_fetch_at <= now()
  AND NOT EXISTS (
    SELECT 1
    FROM ingestion_jobs ij
    WHERE ij.feed_id = f.id
      AND ij.leased_until IS NOT NULL
      AND ij.leased_until > now()
  );

-- 3b) Show feeds that are now eligible
SELECT 
  f.id,
  f.name,
  f.url,
  f.next_fetch_at,
  f.priority,
  'NOW ELIGIBLE' as status
FROM rss_feed_sources f
WHERE f.is_active = true
  AND f.next_fetch_at <= now()
  AND NOT EXISTS (
    SELECT 1
    FROM ingestion_jobs ij
    WHERE ij.feed_id = f.id
      AND ij.leased_until IS NOT NULL
      AND ij.leased_until > now()
  )
ORDER BY f.priority DESC, f.next_fetch_at ASC
LIMIT 10;

-- ------------------------------------------------------------
-- STEP 4: OPTIONAL - Add safeguard trigger for future inserts
-- ------------------------------------------------------------

-- Create trigger to ensure next_fetch_at is always set
CREATE OR REPLACE FUNCTION ensure_rss_feed_next_fetch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Ensure next_fetch_at is set to now() if NULL or too far in future
  IF NEW.next_fetch_at IS NULL THEN
    NEW.next_fetch_at := now();
  ELSIF NEW.next_fetch_at > now() + interval '1 day' THEN
    -- If someone sets it more than 1 day in future, cap it to 1 day
    NEW.next_fetch_at := now() + interval '1 day';
  END IF;
  
  -- Ensure is_active defaults to true if not explicitly set
  IF NEW.is_active IS NULL THEN
    NEW.is_active := true;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS trg_rss_feed_sources_ensure_next_fetch ON rss_feed_sources;

CREATE TRIGGER trg_rss_feed_sources_ensure_next_fetch
BEFORE INSERT ON rss_feed_sources
FOR EACH ROW
EXECUTE FUNCTION ensure_rss_feed_next_fetch();

-- ------------------------------------------------------------
-- STEP 5: Summary report
-- ------------------------------------------------------------

DO $$
DECLARE
  v_stats jsonb;
BEGIN
  SELECT jsonb_build_object(
    'timestamp', now(),
    'total_feeds', (SELECT COUNT(*) FROM rss_feed_sources),
    'active_feeds', (SELECT COUNT(*) FROM rss_feed_sources WHERE is_active = true),
    'eligible_feeds', (
      SELECT COUNT(*)
      FROM rss_feed_sources f
      WHERE f.is_active = true
        AND f.next_fetch_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM ingestion_jobs ij
          WHERE ij.feed_id = f.id
            AND ij.leased_until IS NOT NULL
            AND ij.leased_until > now()
        )
    ),
    'leased_feeds', (
      SELECT COUNT(*)
      FROM ingestion_jobs ij
      WHERE ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    ),
    'feeds_with_errors', (
      SELECT COUNT(*) FROM rss_feed_sources WHERE last_error IS NOT NULL
    )
  ) INTO v_stats;
  
  RAISE NOTICE 'RSS Feed Health Summary: %', v_stats;
END $$;

RESET ROLE;

-- ============================================================
-- END OF DIAGNOSTIC AND FIX SCRIPT
-- ============================================================
