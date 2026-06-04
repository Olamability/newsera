-- ============================================================
-- MIGRATION 062: Bridge admin-created sources → rss_feed_sources
--
-- Root cause:
--   The admin panel (Sources.jsx, PublisherApplication.jsx) inserts /
--   updates only the `sources` table. The RSS ingestion worker
--   (rss-worker.ts) reads exclusively from `rss_feed_sources` via
--   `lease_due_feeds()`. No sync existed between the two tables, so
--   any feed created/approved by an admin was permanently invisible
--   to the worker.
--
--   Seeded feeds worked because migrations 051/056/060 write directly
--   into `rss_feed_sources` with `is_active=true` and
--   `next_fetch_at=now()`.
--
-- This migration:
--   1. Adds trigger `trg_sync_source_to_rss_feeds` on `sources` — fires
--      after INSERT or UPDATE of (status, rss_url); if the row is active
--      with a non-null rss_url it upserts an rss_feed_sources row.
--   2. Adds `admin_activate_rss_feed(source_id, reason)` RPC — the
--      canonical admin-panel action; atomically sets sources.status=active
--      AND upserts rss_feed_sources, audit-logged.
--   3. Backfills all existing active sources that currently have no
--      corresponding rss_feed_sources row.
--   4. Verifies the backfill.
--
-- Strictly additive: no existing tables, columns, or policies are
-- modified. RLS on rss_feed_sources (service_role-only write policy)
-- is preserved; the trigger and RPC run as SECURITY DEFINER postgres.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Trigger function — sync sources → rss_feed_sources on activate
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _sync_source_to_rss_feed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Upsert rss_feed_sources when a source becomes active with a real rss_url.
  IF NEW.status = 'active' AND NEW.rss_url IS NOT NULL AND trim(NEW.rss_url) <> '' THEN
    INSERT INTO public.rss_feed_sources (
      name,
      url,
      source_id,
      is_active,
      next_fetch_at,
      priority,
      fetch_interval_seconds,
      backoff_seconds,
      consecutive_failures
    )
    VALUES (
      NEW.name,
      trim(NEW.rss_url),
      NEW.id,
      true,
      now(),  -- eligible immediately upon activation
      5,      -- default priority (matches column CHECK 1–10)
      600,    -- 10-minute default fetch interval
      0,
      0
    )
    ON CONFLICT (url) DO UPDATE
      SET name                 = EXCLUDED.name,
          -- Only adopt source_id if the existing row is unlinked.
          source_id            = COALESCE(rss_feed_sources.source_id, EXCLUDED.source_id),
          is_active            = true,
          -- Don't push back a feed that is already due sooner.
          next_fetch_at        = LEAST(
                                   COALESCE(rss_feed_sources.next_fetch_at, now()),
                                   now()
                                 ),
          backoff_seconds      = 0,
          consecutive_failures = 0,
          last_error           = NULL;
  END IF;

  -- Mirror deactivation: pause the feed rather than deleting it so
  -- history and reliability scores are preserved.
  IF NEW.status = 'inactive'
     AND (OLD.status IS DISTINCT FROM 'inactive')
     AND NEW.rss_url IS NOT NULL
     AND trim(NEW.rss_url) <> '' THEN
    UPDATE public.rss_feed_sources
       SET is_active = false
     WHERE url = trim(NEW.rss_url)
        OR source_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION _sync_source_to_rss_feed() OWNER TO postgres;

COMMENT ON FUNCTION _sync_source_to_rss_feed() IS
  'Trigger body: upserts rss_feed_sources whenever sources.status '
  'becomes active with a non-null rss_url. Mirrors deactivation.';

DROP TRIGGER IF EXISTS trg_sync_source_to_rss_feeds ON public.sources;
CREATE TRIGGER trg_sync_source_to_rss_feeds
AFTER INSERT OR UPDATE OF status, rss_url, name
ON public.sources
FOR EACH ROW
EXECUTE FUNCTION _sync_source_to_rss_feed();

COMMENT ON TRIGGER trg_sync_source_to_rss_feeds ON public.sources IS
  'Automatically syncs active sources into rss_feed_sources so the '
  'ingestion worker picks them up without any manual intervention. '
  'Added by migration 062 to close the admin-created feed ingestion gap.';

-- ------------------------------------------------------------
-- 2) Admin RPC: admin_activate_rss_feed(source_id, reason)
--
-- Atomically:
--   a) Sets sources.status = 'active'
--   b) Upserts the rss_feed_sources row (eligible immediately)
--   c) Writes to admin_audit_log
--
-- Call this from the admin panel instead of a raw UPDATE on sources.
-- The trigger (step 1) would also fire on a raw UPDATE, but this RPC
-- gives the admin panel a direct, audited, and atomic path.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_activate_rss_feed(
  p_source_id uuid,
  p_reason    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_source    record;
  v_feed_id   uuid;
  v_was_new   boolean;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_activate_rss_feed: admin caller required';
  END IF;

  SELECT id, name, rss_url, status
    INTO v_source
    FROM public.sources
   WHERE id = p_source_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_activate_rss_feed: source % not found', p_source_id;
  END IF;

  IF v_source.rss_url IS NULL OR trim(v_source.rss_url) = '' THEN
    RAISE EXCEPTION 'admin_activate_rss_feed: source % has no rss_url — '
                    'set rss_url before activating', p_source_id;
  END IF;

  -- (a) Activate the source row.
  UPDATE public.sources
     SET status = 'active'
   WHERE id = p_source_id;

  -- (b) Upsert rss_feed_sources (trigger will also fire via the UPDATE
  --     above, making this upsert doubly idempotent).
  INSERT INTO public.rss_feed_sources (
    name, url, source_id, is_active, next_fetch_at,
    priority, fetch_interval_seconds, backoff_seconds, consecutive_failures
  )
  VALUES (
    v_source.name,
    trim(v_source.rss_url),
    p_source_id,
    true,
    now(),
    5, 600, 0, 0
  )
  ON CONFLICT (url) DO UPDATE
    SET name                 = EXCLUDED.name,
        source_id            = COALESCE(rss_feed_sources.source_id, EXCLUDED.source_id),
        is_active            = true,
        next_fetch_at        = LEAST(
                                 COALESCE(rss_feed_sources.next_fetch_at, now()),
                                 now()
                               ),
        backoff_seconds      = 0,
        consecutive_failures = 0,
        last_error           = NULL
  RETURNING id, (xmax = 0) INTO v_feed_id, v_was_new;

  -- (c) Audit log.
  INSERT INTO public.admin_audit_log (
    admin_user_id, action, entity_type, entity_id, reason, metadata
  )
  VALUES (
    auth.uid(),
    'activate_rss_feed',
    'source',
    p_source_id,
    p_reason,
    jsonb_build_object(
      'source_name', v_source.name,
      'rss_url',     trim(v_source.rss_url),
      'feed_id',     v_feed_id,
      'feed_was_new', v_was_new
    )
  );

  RETURN jsonb_build_object(
    'source_id',    p_source_id,
    'feed_id',      v_feed_id,
    'feed_was_new', v_was_new,
    'eligible_at',  now()
  );
END;
$$;

ALTER FUNCTION public.admin_activate_rss_feed(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_activate_rss_feed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_activate_rss_feed(uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_activate_rss_feed(uuid, text) IS
  'Admin-only SECURITY DEFINER RPC. Atomically activates a source AND '
  'upserts its rss_feed_sources row so the ingestion worker picks it '
  'up on the next poll cycle (next_fetch_at = now()). Call from the '
  'admin panel Approve button instead of a raw sources UPDATE.';

-- ------------------------------------------------------------
-- 3) Backfill: sync all existing active sources that are absent from
--    (or disabled in) rss_feed_sources. Idempotent.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_inserted  integer := 0;
  v_refreshed integer := 0;
BEGIN
  WITH upsert AS (
    INSERT INTO public.rss_feed_sources (
      name, url, source_id, is_active, next_fetch_at,
      priority, fetch_interval_seconds, backoff_seconds, consecutive_failures
    )
    SELECT
      s.name,
      trim(s.rss_url),
      s.id,
      true,
      now(),
      5, 600, 0, 0
    FROM public.sources s
    WHERE s.status = 'active'
      AND s.rss_url IS NOT NULL
      AND trim(s.rss_url) <> ''
    ON CONFLICT (url) DO UPDATE
      SET source_id            = COALESCE(rss_feed_sources.source_id, EXCLUDED.source_id),
          is_active            = true,
          next_fetch_at        = LEAST(
                                   COALESCE(rss_feed_sources.next_fetch_at, now()),
                                   now()
                                 ),
          backoff_seconds      = 0,
          consecutive_failures = 0,
          last_error           = NULL
    RETURNING (xmax = 0) AS was_inserted
  )
  SELECT
    count(*) FILTER (WHERE was_inserted)::integer,
    count(*) FILTER (WHERE NOT was_inserted)::integer
  INTO v_inserted, v_refreshed
  FROM upsert;

  RAISE NOTICE 'migration 062 backfill: % rows inserted, % rows refreshed into rss_feed_sources',
    v_inserted, v_refreshed;
END $$;

-- ------------------------------------------------------------
-- 4) Verification: warn if any active sources still have no eligible
--    rss_feed_sources row (would indicate a URL mismatch).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_orphaned integer;
BEGIN
  SELECT count(*)::integer INTO v_orphaned
  FROM public.sources s
  WHERE s.status = 'active'
    AND s.rss_url IS NOT NULL
    AND trim(s.rss_url) <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM public.rss_feed_sources rfs
      WHERE rfs.url = trim(s.rss_url)
        AND rfs.is_active = true
    );

  IF v_orphaned > 0 THEN
    RAISE WARNING 'migration 062: % active sources still have no eligible '
                  'rss_feed_sources row — inspect for rss_url whitespace or '
                  'scheme (http vs https) mismatches', v_orphaned;
  ELSE
    RAISE NOTICE 'migration 062 verification PASSED: all active sources '
                 'have a live rss_feed_sources row.';
  END IF;
END $$;

RESET ROLE;

-- ============================================================
-- END OF MIGRATION 062
-- ============================================================
