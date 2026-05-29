-- ============================================================
-- MIGRATION 059: Canonical source layer + scheduling helpers
--
-- Purpose
-- -------
-- Production has two source registries that have coexisted since the
-- ingestion pipeline was rebuilt:
--
--   * `sources`            (legacy publisher registry — `articles.source_id`
--                           is still FK'd here, so this remains authoritative
--                           for article display joins)
--   * `rss_feed_sources`   (active RSS ingestion registry — owns feed URLs,
--                           scheduling, reliability metrics)
--
-- They are linked by `rss_feed_sources.source_id -> sources.id` (see
-- migration 036), but downstream consumers (mobile app, admin panel, ad-hoc
-- diagnostics) have to know about both shapes which has caused subtle
-- "Unknown source" rendering bugs.
--
-- This migration is **purely additive**:
--
--   1. `canonical_sources` — a stable SQL VIEW that unifies both tables into
--      a single read-only logical surface keyed by the legacy `sources.id`
--      (which is what `articles.source_id` references). RSS rows that have a
--      `source_id` get merged onto the matching legacy row; orphan RSS rows
--      (no `source_id` link) are exposed under their own id and tagged as
--      `type = 'rss'`.
--
--   2. `get_feed_schedule_state(p_feed_id uuid)` — a read-only diagnostic RPC
--      that returns the scheduling state for a single feed (next_fetch_at,
--      fetch_interval_seconds, is_active, computed eligibility). No side
--      effects.
--
--   3. Widened crash-detection grace window — `mark_stale_workers_crashed`
--      and `get_rss_worker_health` now use a 5-minute tolerance so a
--      momentarily idle worker that is still heartbeating is never
--      misclassified as crashed.
--
-- Backward-compatibility guarantees
-- ---------------------------------
--   * No DROP / ALTER on existing tables or columns.
--   * No change to ingestion pipeline writes (`sources`, `rss_feed_sources`,
--     `articles`, `rss_ingestion_log`, `worker_heartbeats` schemas untouched).
--   * Existing RPCs (`get_rss_worker_health`, `mark_stale_workers_crashed`)
--     keep the same signature, return type, and grants — only thresholds
--     widened, behaviour stays observably the same for healthy workers.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) canonical_sources VIEW
--
-- Shape:
--   id           uuid        -- stable identifier (sources.id when known;
--                            -- rss_feed_sources.id only for orphan RSS rows)
--   name         text
--   type         text        -- 'legacy' (row originated in sources) or
--                            -- 'rss'   (orphan rss_feed_sources row with no
--                            --          link back to sources)
--   website_url  text
--   logo_url     text
--   category_id  uuid
--   status       text        -- 'active' | 'inactive' | 'pending' (legacy
--                            -- status), or for RSS rows: 'active' when
--                            -- is_active = true, else 'inactive'
--   rss_url      text        -- preferred rss feed URL when available
--   feed_id      uuid        -- rss_feed_sources.id when an RSS feed is
--                            -- attached; NULL otherwise
--   is_active    boolean     -- rss ingestion activation flag (NULL for
--                            -- legacy-only rows with no RSS feed attached)
--   updated_at   timestamptz -- best-effort last activity timestamp
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.canonical_sources AS
WITH rss_linked AS (
  -- RSS feeds that are tied to a legacy publisher row via source_id
  SELECT
    s.id                                AS id,
    COALESCE(NULLIF(btrim(s.name), ''),
             NULLIF(btrim(rfs.name), '')) AS name,
    'legacy'::text                      AS type,
    s.website_url                       AS website_url,
    s.logo_url                          AS logo_url,
    s.category_id                       AS category_id,
    s.status                            AS status,
    COALESCE(rfs.url, s.rss_url)        AS rss_url,
    rfs.id                              AS feed_id,
    rfs.is_active                       AS is_active,
    GREATEST(
      COALESCE(rfs.last_fetched_at, 'epoch'::timestamptz),
      COALESCE(s.created_at,        'epoch'::timestamptz)
    )                                   AS updated_at
  FROM public.sources s
  LEFT JOIN public.rss_feed_sources rfs
         ON rfs.source_id = s.id
),
rss_orphans AS (
  -- RSS feed rows that have no link back to the legacy sources table.
  -- Exposed under their own id so diagnostics can still find them, but
  -- tagged as type='rss' so the join layer can distinguish.
  SELECT
    rfs.id                              AS id,
    COALESCE(NULLIF(btrim(rfs.name), ''), 'Unknown source') AS name,
    'rss'::text                         AS type,
    NULL::text                          AS website_url,
    NULL::text                          AS logo_url,
    NULL::uuid                          AS category_id,
    CASE WHEN rfs.is_active THEN 'active' ELSE 'inactive' END AS status,
    rfs.url                             AS rss_url,
    rfs.id                              AS feed_id,
    rfs.is_active                       AS is_active,
    COALESCE(rfs.last_fetched_at, rfs.created_at) AS updated_at
  FROM public.rss_feed_sources rfs
  WHERE rfs.source_id IS NULL
)
SELECT * FROM rss_linked
UNION ALL
SELECT * FROM rss_orphans;

COMMENT ON VIEW public.canonical_sources IS
  'Unified read-only surface over public.sources and public.rss_feed_sources. '
  'Use this for diagnostics and any new source-resolution code paths. '
  'Existing writers (RSS ingestion, admin source CRUD) MUST continue to '
  'target the underlying tables directly — this view is not updatable.';

GRANT SELECT ON public.canonical_sources TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2) get_feed_schedule_state(p_feed_id uuid) — diagnostic RPC
--
-- Read-only; no side effects. Returns the scheduling state for a single
-- feed plus a computed `eligible_now` boolean that mirrors the eligibility
-- predicate used by the lease_due_feeds() planner (active AND
-- next_fetch_at <= now()).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_feed_schedule_state(p_feed_id uuid)
RETURNS TABLE (
  feed_id                uuid,
  name                   text,
  url                    text,
  is_active              boolean,
  next_fetch_at          timestamptz,
  fetch_interval_seconds integer,
  backoff_seconds        integer,
  last_fetched_at        timestamptz,
  last_success_at        timestamptz,
  last_failure_at        timestamptz,
  consecutive_failures   integer,
  reliability_score      numeric,
  seconds_until_due      integer,
  eligible_now           boolean,
  reason                 text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_feed_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    f.id                                                       AS feed_id,
    f.name                                                     AS name,
    f.url                                                      AS url,
    f.is_active                                                AS is_active,
    f.next_fetch_at                                            AS next_fetch_at,
    f.fetch_interval_seconds                                   AS fetch_interval_seconds,
    f.backoff_seconds                                          AS backoff_seconds,
    f.last_fetched_at                                          AS last_fetched_at,
    f.last_success_at                                          AS last_success_at,
    f.last_failure_at                                          AS last_failure_at,
    f.consecutive_failures                                     AS consecutive_failures,
    f.reliability_score                                        AS reliability_score,
    GREATEST(
      0,
      EXTRACT(EPOCH FROM (f.next_fetch_at - now()))::integer
    )                                                          AS seconds_until_due,
    (f.is_active = true AND f.next_fetch_at <= now())          AS eligible_now,
    CASE
      WHEN NOT f.is_active                       THEN 'paused'
      WHEN f.next_fetch_at > now()               THEN 'scheduled'
      WHEN f.backoff_seconds > 0
       AND f.last_failure_at IS NOT NULL
       AND f.last_failure_at + make_interval(secs => f.backoff_seconds) > now()
                                                 THEN 'backing_off'
      ELSE                                            'eligible'
    END                                                        AS reason
  FROM public.rss_feed_sources f
  WHERE f.id = p_feed_id;
END;
$$;

COMMENT ON FUNCTION public.get_feed_schedule_state(uuid) IS
  'Read-only diagnostic for RSS scheduling state. Safe to call from the '
  'admin panel; performs no writes and has no side effects.';

GRANT EXECUTE ON FUNCTION public.get_feed_schedule_state(uuid)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Widen crash-detection grace window
--
-- The previous 3-minute window was too tight for the realistic spread of
-- heartbeat-interval (default 30s) + cron-cadence (worker_health_cron typically
-- runs every 1 minute). A transient stall (single missed heartbeat right
-- before the cron tick) flipped workers to `crashed` even though they were
-- still serving the queue, producing the "false positive crash" pages.
--
-- Both the marking function (writer) and the health view (reader) move to a
-- 300-second / 5-minute tolerance. Existing callers that pass an explicit
-- `p_stale_after_seconds` keep their requested behaviour — only the default
-- changes, so the signature stays compatible.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_stale_workers_crashed(
  p_stale_after_seconds integer DEFAULT 300
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.worker_heartbeats
  SET status = 'crashed'
  WHERE status = 'alive'
    AND last_heartbeat_at < now() - make_interval(secs => GREATEST(p_stale_after_seconds, 30));

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_stale_workers_crashed(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.get_rss_worker_health()
RETURNS TABLE (
  worker_type              text,
  alive_count              integer,
  draining_count           integer,
  stopped_count            integer,
  crashed_count            integer,
  stale_count              integer,
  most_recent_heartbeat_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    wh.worker_type,
    COUNT(*) FILTER (WHERE wh.status = 'alive'
      AND wh.last_heartbeat_at >= now() - interval '5 minutes')::integer
      AS alive_count,
    COUNT(*) FILTER (WHERE wh.status = 'draining')::integer AS draining_count,
    COUNT(*) FILTER (WHERE wh.status = 'stopped')::integer  AS stopped_count,
    COUNT(*) FILTER (WHERE wh.status = 'crashed')::integer  AS crashed_count,
    COUNT(*) FILTER (WHERE wh.status = 'alive'
      AND wh.last_heartbeat_at < now() - interval '5 minutes')::integer
      AS stale_count,
    MAX(wh.last_heartbeat_at) AS most_recent_heartbeat_at
  FROM public.worker_heartbeats wh
  GROUP BY wh.worker_type
  ORDER BY wh.worker_type;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_rss_worker_health() TO authenticated, service_role;

RESET ROLE;
