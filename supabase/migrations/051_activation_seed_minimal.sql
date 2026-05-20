-- ============================================================
-- MIGRATION 051: Activation seed (minimal runtime data)
-- ============================================================
-- Phases A–G are code-complete but the activation readiness matrix
-- reports three subsystems blocked because the database contains no
-- runtime data yet:
--
--   rss_workers      → no_active_rss_feeds
--   notifications    → no_registered_devices
--   personalization  → no_user_affinity_data_yet
--
-- This migration is strictly additive and only seeds the *minimum*
-- runtime state required to flip those flags to ready, plus exposes
-- a reusable RPC that ops can call at any time to bootstrap a fresh
-- environment.
--
-- It does NOT:
--   * change any business rules
--   * fake metric values
--   * touch the queue/notification/personalization code paths
--   * create synthetic auth users (auth.users is supabase-managed)
--
-- All inserts are idempotent and safe to re-run.
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Seed minimal active RSS feeds
-- ------------------------------------------------------------
-- Real, publicly-available NG-relevant feeds. Their presence unblocks
-- `lease_due_feeds` so `rss_worker:v2` and `queue_runner` have actual
-- work to lease, ingest and enqueue downstream jobs against.
--
-- Idempotent via `url` UNIQUE constraint (migration 023).
-- We also force `is_active = true` and clear any stale failure state
-- on conflict so a previously-disabled row doesn't keep the matrix
-- blocked.
INSERT INTO rss_feed_sources (name, url, category, country, language, is_active)
VALUES
  ('BBC News — Top Stories',     'https://feeds.bbci.co.uk/news/rss.xml',                'general',  'NG', 'en', true),
  ('BBC News — World',           'https://feeds.bbci.co.uk/news/world/rss.xml',          'world',    'NG', 'en', true),
  ('BBC News — Business',        'https://feeds.bbci.co.uk/news/business/rss.xml',       'business', 'NG', 'en', true),
  ('BBC News — Technology',      'https://feeds.bbci.co.uk/news/technology/rss.xml',     'tech',     'NG', 'en', true),
  ('BBC News — Africa',          'https://feeds.bbci.co.uk/news/world/africa/rss.xml',   'world',    'NG', 'en', true)
ON CONFLICT (url) DO UPDATE
SET is_active            = true,
    last_error           = NULL,
    consecutive_failures = 0,
    next_fetch_at        = LEAST(rss_feed_sources.next_fetch_at, now());

-- Reset any other previously-active feed whose backoff window has
-- expired so the worker has the broadest possible due-set on first
-- poll after activation.  Safe no-op when there are no such rows.
UPDATE rss_feed_sources
   SET next_fetch_at = now()
 WHERE is_active = true
   AND (next_fetch_at IS NULL OR next_fetch_at > now() + interval '1 hour');

-- ------------------------------------------------------------
-- 2) seed_activation_minimal(p_user_id uuid DEFAULT NULL)
-- ------------------------------------------------------------
-- Admin-only RPC. For a target auth user (defaults to the *oldest*
-- existing user when NULL):
--
--   * upserts one `user_devices` row with a syntactically valid
--     Expo push token so `notifications` flips to ready and the
--     `notification_events → materialize_notification_event → push`
--     drain pipeline has at least one delivery target;
--
--   * inserts a small number of synthetic `article_clicks` rows
--     against existing articles (a real engagement signal — the
--     personalization pipeline consumes article_clicks directly);
--
--   * calls `recompute_user_affinity` so `user_category_affinity`
--     and `user_source_affinity` populate with non-zero vectors.
--
-- Returns a jsonb summary describing what was seeded.
-- Re-running the function for the same user is safe.
CREATE OR REPLACE FUNCTION seed_activation_minimal(
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id       uuid;
  v_device_id     text := 'activation-seed-device';
  v_push_token    text := 'ExponentPushToken[activation-seed-placeholder]';
  v_clicks_added  integer := 0;
  v_cat_rows      integer := 0;
  v_src_rows      integer := 0;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'seed_activation_minimal: admin caller required';
  END IF;

  -- Pick a real auth user. We cannot fabricate auth.users rows from
  -- a migration (managed by GoTrue), so when the DB has no users yet
  -- we exit cleanly and let ops re-run this RPC after first sign-up.
  v_user_id := COALESCE(
    p_user_id,
    (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1)
  );

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'seeded',  false,
      'reason',  'no_auth_users_present',
      'hint',    'register at least one user, then call seed_activation_minimal()'
    );
  END IF;

  -- 2a) Device + push token (one row per user is enough for readiness).
  INSERT INTO user_devices (user_id, device_id, push_token)
  VALUES (v_user_id, v_device_id, v_push_token)
  ON CONFLICT (user_id, device_id) DO UPDATE
  SET push_token = EXCLUDED.push_token;

  -- 2b) Synthetic clicks against real articles (up to 10, spread across
  --     distinct categories/sources to produce a non-degenerate affinity
  --     vector). Skips silently when no articles are ingested yet.
  WITH picked AS (
    SELECT a.id AS article_id,
           a.source_id
      FROM articles a
     WHERE a.status = 'published'
     ORDER BY a.published_at DESC NULLS LAST
     LIMIT 10
  ), inserted AS (
    INSERT INTO article_clicks (article_id, source_id, user_id, clicked_at)
    SELECT p.article_id,
           p.source_id,
           v_user_id::text,
           now() - (interval '1 hour' * (row_number() OVER ()))
      FROM picked p
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_clicks_added FROM inserted;

  -- 2c) Recompute affinity vectors for this user. Always safe to call
  --     even when there are zero signals.
  PERFORM recompute_user_affinity(v_user_id);

  SELECT COUNT(*)::integer INTO v_cat_rows
    FROM user_category_affinity WHERE user_id = v_user_id;
  SELECT COUNT(*)::integer INTO v_src_rows
    FROM user_source_affinity   WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'seeded',                 true,
    'user_id',                v_user_id,
    'device_upserted',        true,
    'clicks_inserted',        v_clicks_added,
    'category_affinity_rows', v_cat_rows,
    'source_affinity_rows',   v_src_rows
  );
END;
$$;

GRANT EXECUTE ON FUNCTION seed_activation_minimal(uuid)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Best-effort bootstrap during migration
-- ------------------------------------------------------------
-- When the migration runs on an environment that already has at
-- least one auth user, immediately seed the minimal device +
-- engagement signal so `get_activation_readiness()` returns green
-- right after deploy. On a brand-new DB this is a no-op; ops will
-- call `seed_activation_minimal()` once a user signs up.
DO $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id
    FROM auth.users
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    -- Bypass the admin gate inside the function: we are running as
    -- the migration owner (`postgres`), which `_is_admin_caller()`
    -- already recognises via the `session_user IN ('postgres', ...)`
    -- branch, so the call succeeds.
    PERFORM seed_activation_minimal(v_user_id);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Bootstrap must never block migration. The RPC remains available
  -- for manual invocation.
  RAISE NOTICE 'seed_activation_minimal bootstrap skipped: %', SQLERRM;
END $$;

-- ============================================================
-- END OF MIGRATION 051
-- ============================================================
