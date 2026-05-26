-- ============================================================
-- MIGRATION 056: RSS feed bootstrap + RLS-safe default seeding
--
-- Production symptom
-- ------------------
--   * rss-worker:v2 is healthy (heartbeat OK, queue loop running,
--     lease_due_feeds no longer crashes, feature flags fixed,
--     Supabase connectivity verified)
--   * But the worker remains idle because
--         SELECT COUNT(*) FROM rss_feed_sources
--     returns 0.
--   * Manual INSERTs from the SQL editor fail with
--         "new row violates row-level security policy
--          for table rss_feed_sources"
--     because migration 034 locked write access to `service_role`
--     only, and the SQL-editor user is `authenticated` w/ admin
--     JWT — admin role currently only grants SELECT on the table.
--   * Migration 051 ("activation seed minimal") *did* INSERT a
--     handful of BBC rows, but it ran under the migration owner
--     (`postgres`) so any environment whose 051 was skipped /
--     partially restored / restored from a snapshot taken before
--     051 ends up permanently empty with no admin-callable path
--     to repair it.
--
-- Goal
-- ----
-- Give operators (and the worker itself) an additive, RLS-safe
-- way to seed/refresh the default feed catalogue, *without*:
--   * disabling RLS,
--   * removing the existing `rss_feed_sources_write_service_role`
--     policy,
--   * granting INSERT/UPDATE to `authenticated`,
--   * touching the worker architecture.
--
-- We do this with a `SECURITY DEFINER` RPC owned by `postgres`,
-- which sidesteps RLS the same way every other admin op RPC in
-- migrations 047/049/051 already does, gated by the canonical
-- `_is_admin_caller()` check (047).
--
-- This migration also adds a read-only observability RPC,
-- `get_rss_feed_stats()`, and a best-effort bootstrap so a fresh
-- deployment never silently idles on an empty table.
--
-- This migration is strictly additive:
--   * no schema columns are added, renamed, or dropped
--   * no existing function signatures change
--   * no existing policies are dropped or relaxed
--   * `lease_due_feeds` is unchanged (already uses canonical
--     `rss_feed_sources.url` — confirmed below)
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 0) Column reference audit
-- ------------------------------------------------------------
-- The canonical column on `rss_feed_sources` is `url`. There is
-- no `rss_url` and no `feed_url` column on this table. Migration
-- 054's `lease_due_feeds` already returns `f.url` and joins on
-- `rss_feed_sources f` exclusively. The only `rss_url` reference
-- anywhere in the codebase is on the legacy `sources` table
-- (migration 001) which is *not* the ingestion table. Likewise
-- `feed_url` only appears on `rss_ingestion_log` as a denormalized
-- snapshot of the URL at run time. No fix is required here; this
-- comment is the auditable record of that check.

-- ------------------------------------------------------------
-- 1) seed_default_rss_feeds()
-- ------------------------------------------------------------
-- Admin-only, idempotent. Inserts (or refreshes) the canonical
-- default feed catalogue using ONLY columns that physically exist
-- on `rss_feed_sources` per migrations 023 + 040:
--     name, url, category, country, language, is_active,
--     next_fetch_at, priority
--
-- `url` carries a UNIQUE constraint (migration 023), which gives
-- us a natural conflict target. On conflict we re-enable the row
-- and clear any stale failure state so a previously-disabled feed
-- doesn't keep the worker idle after a re-seed.
--
-- Returns a jsonb summary so operators / the worker bootstrap can
-- log exactly what changed.
CREATE OR REPLACE FUNCTION seed_default_rss_feeds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_before_total integer;
  v_after_total  integer;
  v_inserted     integer;
  v_refreshed    integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'seed_default_rss_feeds: admin caller required';
  END IF;

  SELECT count(*)::integer INTO v_before_total FROM rss_feed_sources;

  WITH upsert AS (
    INSERT INTO rss_feed_sources
      (name, url, category, country, language, is_active, next_fetch_at, priority)
    VALUES
      -- BBC (high-priority general/world/business/tech wire)
      ('BBC News — Top Stories',  'https://feeds.bbci.co.uk/news/rss.xml',                'general',  'GB', 'en', true, now(), 9),
      ('BBC News — World',        'https://feeds.bbci.co.uk/news/world/rss.xml',          'world',    'GB', 'en', true, now(), 9),
      ('BBC News — Business',     'https://feeds.bbci.co.uk/news/business/rss.xml',       'business', 'GB', 'en', true, now(), 8),
      ('BBC News — Technology',   'https://feeds.bbci.co.uk/news/technology/rss.xml',     'tech',     'GB', 'en', true, now(), 8),
      ('BBC News — Africa',       'https://feeds.bbci.co.uk/news/world/africa/rss.xml',   'world',    'NG', 'en', true, now(), 9),
      -- Reuters (top news wire — high priority)
      ('Reuters — Top News',      'https://feeds.reuters.com/reuters/topNews',            'general',  'US', 'en', true, now(), 9),
      ('Reuters — World News',    'https://feeds.reuters.com/Reuters/worldNews',          'world',    'US', 'en', true, now(), 8),
      -- Al Jazeera
      ('Al Jazeera English',      'https://www.aljazeera.com/xml/rss/all.xml',            'world',    'QA', 'en', true, now(), 8),
      -- CNN
      ('CNN — Top Stories',       'http://rss.cnn.com/rss/edition.rss',                   'general',  'US', 'en', true, now(), 8),
      ('CNN — World',             'http://rss.cnn.com/rss/edition_world.rss',             'world',    'US', 'en', true, now(), 7),
      -- Tech
      ('TechCrunch',              'https://techcrunch.com/feed/',                         'tech',     'US', 'en', true, now(), 7),
      ('Ars Technica',            'https://feeds.arstechnica.com/arstechnica/index',      'tech',     'US', 'en', true, now(), 7),
      -- Sport
      ('Goal — Latest News',      'https://www.goal.com/feeds/news?fmt=rss',              'sport',    'GB', 'en', true, now(), 6),
      ('ESPN — Top Headlines',    'https://www.espn.com/espn/rss/news',                   'sport',    'US', 'en', true, now(), 6)
    ON CONFLICT (url) DO UPDATE
    SET name                 = EXCLUDED.name,
        category             = EXCLUDED.category,
        country              = EXCLUDED.country,
        language             = EXCLUDED.language,
        is_active            = true,
        -- Re-eligible immediately on re-seed. Use LEAST so a feed
        -- already due sooner is not pushed back.
        next_fetch_at        = LEAST(
                                 COALESCE(rss_feed_sources.next_fetch_at, now()),
                                 now()
                               ),
        priority             = GREATEST(rss_feed_sources.priority, EXCLUDED.priority),
        -- Clear stale failure state so a previously-quarantined
        -- feed gets a fresh chance after operator intervention.
        last_error           = NULL,
        consecutive_failures = 0,
        backoff_seconds      = 0
    RETURNING (xmax = 0) AS was_inserted
  )
  SELECT
    count(*) FILTER (WHERE was_inserted)       ::integer,
    count(*) FILTER (WHERE NOT was_inserted)   ::integer
    INTO v_inserted, v_refreshed
  FROM upsert;

  SELECT count(*)::integer INTO v_after_total FROM rss_feed_sources;

  RETURN jsonb_build_object(
    'seeded',          true,
    'rows_inserted',   v_inserted,
    'rows_refreshed',  v_refreshed,
    'total_before',    v_before_total,
    'total_after',     v_after_total,
    'ran_at',          now()
  );
END;
$$;

ALTER FUNCTION seed_default_rss_feeds() OWNER TO postgres;
REVOKE ALL ON FUNCTION seed_default_rss_feeds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_default_rss_feeds() TO authenticated, service_role;

COMMENT ON FUNCTION seed_default_rss_feeds() IS
  'Admin-only SECURITY DEFINER RPC. Idempotently upserts the default '
  'RSS feed catalogue into rss_feed_sources (RLS-safe: bypasses the '
  'service_role-only write policy via SECURITY DEFINER, gated by '
  '_is_admin_caller()). Use to bootstrap a fresh environment or '
  'refresh stale entries.';

-- ------------------------------------------------------------
-- 2) get_rss_feed_stats()
-- ------------------------------------------------------------
-- Read-only observability counter for dashboards, the admin
-- panel, and operator psql sessions. Reports the four numbers
-- that disambiguate every common "why is the worker idle?"
-- failure mode at a glance.
--
-- The `eligible_feeds` definition matches the canonical
-- eligibility predicate enforced by `lease_due_feeds`
-- (migration 054, PART A) — keep these in sync.
CREATE OR REPLACE FUNCTION get_rss_feed_stats()
RETURNS TABLE (
  total_feeds    bigint,
  active_feeds   bigint,
  eligible_feeds bigint,
  leased_feeds   bigint,
  failed_feeds   bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    (SELECT count(*)::bigint FROM rss_feed_sources)                              AS total_feeds,
    (SELECT count(*)::bigint FROM rss_feed_sources WHERE is_active = true)       AS active_feeds,
    (
      SELECT count(*)::bigint
      FROM rss_feed_sources f
      WHERE f.is_active = true
        AND (f.next_fetch_at IS NULL OR f.next_fetch_at <= now())
        AND NOT EXISTS (
          SELECT 1
          FROM ingestion_jobs ij
          WHERE ij.feed_id = f.id
            AND ij.leased_until IS NOT NULL
            AND ij.leased_until > now()
        )
    )                                                                             AS eligible_feeds,
    (
      SELECT count(*)::bigint
      FROM ingestion_jobs ij
      WHERE ij.leased_until IS NOT NULL
        AND ij.leased_until > now()
    )                                                                             AS leased_feeds,
    (
      -- "Failed" = either chronic (≥5 consecutive failures, the
      -- quarantine-ish threshold used by record_feed_ingestion_outcome
      -- backoff in migration 040) OR currently carrying a non-NULL
      -- `last_error` from the most recent run. The two signals are
      -- independent and either alone is enough to flag a feed as
      -- unhealthy for the operator dashboard.
      SELECT count(*)::bigint
      FROM rss_feed_sources
      WHERE consecutive_failures >= 5
         OR last_error IS NOT NULL
    )                                                                             AS failed_feeds;
$$;

ALTER FUNCTION get_rss_feed_stats() OWNER TO postgres;
REVOKE ALL ON FUNCTION get_rss_feed_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_rss_feed_stats() TO authenticated, service_role;

COMMENT ON FUNCTION get_rss_feed_stats() IS
  'Read-only RSS feed observability counts: total / active / '
  'eligible (matches lease_due_feeds predicate) / leased / failed.';

-- ------------------------------------------------------------
-- 3) Best-effort bootstrap during migration
-- ------------------------------------------------------------
-- If the environment is brand new (or was restored from a
-- snapshot predating 051) and `rss_feed_sources` is empty, seed
-- it right now. This guarantees `rss-worker:v2` has work to
-- lease the moment it comes up.
--
-- Bootstrap must never block the migration: any failure is
-- logged via NOTICE and the RPC remains available for manual
-- invocation by ops.
DO $$
DECLARE
  v_count  integer;
  v_result jsonb;
BEGIN
  SELECT count(*)::integer INTO v_count FROM rss_feed_sources;
  IF v_count = 0 THEN
    -- _is_admin_caller() recognises session_user='postgres', so
    -- the admin gate inside seed_default_rss_feeds() passes here.
    v_result := seed_default_rss_feeds();
    RAISE NOTICE 'seed_default_rss_feeds bootstrap: %', v_result;
  ELSE
    RAISE NOTICE 'seed_default_rss_feeds bootstrap skipped: '
                 'rss_feed_sources already has % rows', v_count;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'seed_default_rss_feeds bootstrap failed (non-fatal): %', SQLERRM;
END $$;

-- ============================================================
-- END OF MIGRATION 056
-- ============================================================
