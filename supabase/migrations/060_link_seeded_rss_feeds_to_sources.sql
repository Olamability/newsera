-- ============================================================
-- MIGRATION 060: Link seeded RSS feeds to canonical `sources`
--                rows + backfill orphan `articles.source_id`
--
-- Production symptom
-- ------------------
--   * Articles ingested from the BBC / Reuters / Al Jazeera / CNN /
--     TechCrunch / Ars Technica / Goal / ESPN feeds seeded by
--     migrations 051 + 056 render in the mobile feed (and admin
--     panel) under the label "Unknown source".
--
-- Root cause
-- ----------
-- The seed migrations insert rows into `rss_feed_sources` but never
-- populate `rss_feed_sources.source_id`, the FK to the legacy
-- `sources` table that `articles.source_id` references.  The mobile
-- app joins `articles → sources(name)` for the source pill (see
-- `mobile-app/services/articleUtils.ts` + `shareService.ts`), so an
-- article whose `source_id` is NULL — or whose `source_id` points at
-- a nonexistent legacy row — has nothing to join on, and the client
-- falls back to the `UNKNOWN_SOURCE_LABEL` constant ("Unknown
-- source").  Migration 037 (canonical convergence backfill) does
-- not cover this case because the seeded rows were inserted *after*
-- 037 ran, by 051 / 056 themselves.
--
-- Migration 059 added a `canonical_sources` view that surfaces
-- orphan RSS rows under their own id, but the mobile app reads
-- the physical `sources` table directly via the PostgREST join
-- selector (`'*, sources(id, name, ...)'`), so the view does not
-- repair the rendering bug on its own — the physical FK still
-- needs to resolve.
--
-- Fix
-- ---
-- This migration is strictly additive and idempotent.  It:
--
--   1. Upserts one canonical `sources` row per seeded publisher
--      (BBC, Reuters, Al Jazeera, CNN, TechCrunch, Ars Technica,
--      Goal, ESPN), using a stable (name, website_url) match so
--      re-running the migration never duplicates rows.
--
--   2. Backfills `rss_feed_sources.source_id` for every seeded
--      feed URL so the next ingestion run writes articles with a
--      resolvable `source_id` and the rendering bug stops
--      recurring.
--
--   3. Backfills `articles.source_id` for already-ingested rows
--      that are currently orphaned (NULL source_id, or pointing
--      at a sources row that no longer exists) by matching the
--      article URL's host to the publisher's known domains.
--
--   4. Rewrites `seed_default_rss_feeds()` (introduced in 056) so
--      future re-seeds always link `source_id` for the catalogue,
--      eliminating the regression at the source.  Signature,
--      grants, ownership, return shape, and ON CONFLICT semantics
--      are preserved.
--
-- This migration is RLS-safe (uses `SECURITY DEFINER` for the RPC
-- exactly like the existing 056 implementation) and never disables
-- RLS, never drops or relaxes any policy, and never widens the
-- existing service-role-only write grant on `rss_feed_sources`.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Canonical publisher catalogue
-- ------------------------------------------------------------
-- (name, website_url, logo_url, host_patterns)
--
-- `host_patterns` lists every URL host substring we consider
-- authoritative for the publisher.  Used both to attach seeded
-- `rss_feed_sources` rows AND to backfill orphan
-- `articles.source_id` rows.  Each pattern is matched with a
-- case-insensitive `LIKE '%pattern%'` against the article URL,
-- which is robust to scheme (http/https), subdomain (www, edition,
-- feeds, ...), and path differences.
--
-- We use a regular table in the `public` schema under a
-- migration-versioned private name (`_seed_publishers_060`) rather
-- than a `TEMP … ON COMMIT DROP` table.  TEMP tables only survive
-- inside the session/transaction that created them, which breaks
-- when this migration is executed by a runner that commits between
-- statements or re-pools to a different backend mid-script — e.g.
-- the Supabase Dashboard SQL editor, the MCP `sql` endpoint, or
-- PgBouncer in transaction pooling mode.  Re-running the migration
-- against an existing table is made safe by `IF NOT EXISTS` plus a
-- `TRUNCATE` before each load, and the explicit `DROP TABLE IF
-- EXISTS` at the bottom of this file removes the staging tables
-- once the migration has finished its work.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._seed_publishers_060 (
  name          text NOT NULL,
  website_url   text NOT NULL,
  logo_url      text,
  host_patterns text[] NOT NULL
);

TRUNCATE public._seed_publishers_060;

INSERT INTO public._seed_publishers_060 (name, website_url, logo_url, host_patterns) VALUES
  ('BBC News',     'https://www.bbc.com',          NULL, ARRAY['bbc.com',         'bbc.co.uk',     'bbci.co.uk']),
  ('Reuters',      'https://www.reuters.com',      NULL, ARRAY['reuters.com']),
  ('Al Jazeera',   'https://www.aljazeera.com',    NULL, ARRAY['aljazeera.com']),
  ('CNN',          'https://www.cnn.com',          NULL, ARRAY['cnn.com',         'cnn.it']),
  ('TechCrunch',   'https://techcrunch.com',       NULL, ARRAY['techcrunch.com']),
  ('Ars Technica', 'https://arstechnica.com',      NULL, ARRAY['arstechnica.com']),
  ('Goal',         'https://www.goal.com',         NULL, ARRAY['goal.com']),
  ('ESPN',         'https://www.espn.com',         NULL, ARRAY['espn.com',        'espn.co.uk']);

-- ------------------------------------------------------------
-- 2) Upsert one `sources` row per publisher, capturing the id
-- ------------------------------------------------------------
-- `sources` carries no UNIQUE constraint on (name) or (website_url)
-- — see migration 001 — so we cannot use ON CONFLICT.  Instead we
-- match an existing row by (name, website_url) and only insert when
-- none is found.  This is idempotent across re-runs.
--
-- The `status='active'` write is intentional: the seeded publishers
-- are real, live wires, and leaving them at the table default
-- 'pending' would keep them out of any admin filters that require
-- `status='active'`.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._seed_publisher_ids_060 (
  name        text PRIMARY KEY,
  source_id   uuid NOT NULL
);

TRUNCATE public._seed_publisher_ids_060;

DO $$
DECLARE
  r           record;
  v_source_id uuid;
BEGIN
  FOR r IN SELECT * FROM public._seed_publishers_060 LOOP
    SELECT s.id INTO v_source_id
      FROM public.sources s
     WHERE s.name = r.name
       AND COALESCE(s.website_url, '') = COALESCE(r.website_url, '')
     LIMIT 1;

    IF v_source_id IS NULL THEN
      -- Fall back to a name-only match so we adopt any pre-existing
      -- row whose website_url drifted (e.g. http vs https) instead
      -- of creating a duplicate.
      SELECT s.id INTO v_source_id
        FROM public.sources s
       WHERE s.name = r.name
       ORDER BY s.created_at ASC
       LIMIT 1;
    END IF;

    IF v_source_id IS NULL THEN
      INSERT INTO public.sources (name, website_url, logo_url, status)
      VALUES (r.name, r.website_url, r.logo_url, 'active')
      RETURNING id INTO v_source_id;
    ELSE
      -- Refresh the canonical fields on the existing row without
      -- demoting status.  Only writes when the new value differs to
      -- avoid spurious updated-timestamp churn (sources has no
      -- updated_at column today, but a future addition would still
      -- be unaffected).
      UPDATE public.sources
         SET website_url = COALESCE(NULLIF(website_url, ''), r.website_url),
             logo_url    = COALESCE(logo_url, r.logo_url),
             status      = CASE WHEN status = 'inactive' THEN status ELSE 'active' END
       WHERE id = v_source_id
         AND (
              COALESCE(website_url, '') IS DISTINCT FROM COALESCE(NULLIF(website_url, ''), r.website_url)
           OR logo_url IS DISTINCT FROM COALESCE(logo_url, r.logo_url)
           OR (status = 'pending')
         );
    END IF;

    INSERT INTO public._seed_publisher_ids_060 (name, source_id)
    VALUES (r.name, v_source_id);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3) Link seeded `rss_feed_sources` rows to their publisher
-- ------------------------------------------------------------
-- Match by any of the publisher's host patterns appearing in the
-- feed URL.  We only overwrite a NULL `source_id` so we never
-- clobber a row that an operator has manually linked elsewhere.
-- ------------------------------------------------------------
UPDATE public.rss_feed_sources rfs
   SET source_id = pi.source_id
  FROM public._seed_publishers_060 p
  JOIN public._seed_publisher_ids_060 pi ON pi.name = p.name
 WHERE rfs.source_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM unnest(p.host_patterns) AS pat(host)
      WHERE rfs.url ILIKE '%' || pat.host || '%'
   );

-- ------------------------------------------------------------
-- 4) Backfill orphan `articles.source_id`
-- ------------------------------------------------------------
-- For every article whose source_id is NULL (or points at a row
-- that no longer exists in `sources`), match the article URL host
-- against the publisher catalogue and adopt the canonical id.
-- This repairs the rendering for content already ingested before
-- the link in step (3) was in place.
--
-- Bounded to a single UPDATE per publisher to keep the migration
-- predictable on large tables; the URL index established by
-- migration 030 (`idx_articles_url`? – url is UNIQUE, so the
-- backing index suffices) keeps the ILIKE on `articles.url`
-- reasonable in practice.  Worst case this is a one-off bulk
-- update at activation time.
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_pattern text;
  v_clause  text;
  v_filters text[];
  v_updated bigint := 0;
  v_total   bigint := 0;
BEGIN
  FOR r IN
    SELECT p.host_patterns, pi.source_id, p.name
      FROM public._seed_publishers_060 p
      JOIN public._seed_publisher_ids_060 pi ON pi.name = p.name
  LOOP
    v_filters := ARRAY[]::text[];
    FOREACH v_pattern IN ARRAY r.host_patterns LOOP
      v_filters := v_filters || format('a.url ILIKE %L', '%' || v_pattern || '%');
    END LOOP;

    v_clause := array_to_string(v_filters, ' OR ');

    EXECUTE format($f$
      WITH upd AS (
        UPDATE public.articles a
           SET source_id = %L::uuid
         WHERE (
                 a.source_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = a.source_id)
             )
           AND (%s)
        RETURNING 1
      )
      SELECT COUNT(*) FROM upd
    $f$, r.source_id, v_clause)
    INTO v_updated;

    v_total := v_total + COALESCE(v_updated, 0);
    RAISE NOTICE 'articles.source_id backfilled for %: % rows', r.name, v_updated;
  END LOOP;

  RAISE NOTICE 'articles.source_id backfill complete: % rows total', v_total;
END $$;

-- ------------------------------------------------------------
-- 5) Rewrite `seed_default_rss_feeds()` to keep source_id linked
-- ------------------------------------------------------------
-- Migration 056 introduced this RPC; we preserve its signature,
-- return shape, ownership, grants, and ON CONFLICT semantics, but
-- extend the upsert to populate `source_id` from a CTE that
-- ensures one `sources` row per publisher.  Idempotent.
-- ------------------------------------------------------------
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
  v_bbc_id          uuid;
  v_reuters_id      uuid;
  v_aljazeera_id    uuid;
  v_cnn_id          uuid;
  v_techcrunch_id   uuid;
  v_arstechnica_id  uuid;
  v_goal_id         uuid;
  v_espn_id         uuid;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'seed_default_rss_feeds: admin caller required';
  END IF;

  -- Ensure a canonical `sources` row exists for each publisher.
  -- Mirrors step (2) of this migration so an operator-triggered
  -- re-seed on a fresh environment is self-sufficient.
  v_bbc_id         := _ensure_seed_publisher_source('BBC News',     'https://www.bbc.com');
  v_reuters_id     := _ensure_seed_publisher_source('Reuters',      'https://www.reuters.com');
  v_aljazeera_id   := _ensure_seed_publisher_source('Al Jazeera',   'https://www.aljazeera.com');
  v_cnn_id         := _ensure_seed_publisher_source('CNN',          'https://www.cnn.com');
  v_techcrunch_id  := _ensure_seed_publisher_source('TechCrunch',   'https://techcrunch.com');
  v_arstechnica_id := _ensure_seed_publisher_source('Ars Technica', 'https://arstechnica.com');
  v_goal_id        := _ensure_seed_publisher_source('Goal',         'https://www.goal.com');
  v_espn_id        := _ensure_seed_publisher_source('ESPN',         'https://www.espn.com');

  SELECT count(*)::integer INTO v_before_total FROM rss_feed_sources;

  WITH upsert AS (
    INSERT INTO rss_feed_sources
      (name, url, category, country, language, is_active, next_fetch_at, priority, source_id)
    VALUES
      ('BBC News — Top Stories',  'https://feeds.bbci.co.uk/news/rss.xml',                'general',  'GB', 'en', true, now(), 9, v_bbc_id),
      ('BBC News — World',        'https://feeds.bbci.co.uk/news/world/rss.xml',          'world',    'GB', 'en', true, now(), 9, v_bbc_id),
      ('BBC News — Business',     'https://feeds.bbci.co.uk/news/business/rss.xml',       'business', 'GB', 'en', true, now(), 8, v_bbc_id),
      ('BBC News — Technology',   'https://feeds.bbci.co.uk/news/technology/rss.xml',     'tech',     'GB', 'en', true, now(), 8, v_bbc_id),
      ('BBC News — Africa',       'https://feeds.bbci.co.uk/news/world/africa/rss.xml',   'world',    'NG', 'en', true, now(), 9, v_bbc_id),
      ('Reuters — Top News',      'https://feeds.reuters.com/reuters/topNews',            'general',  'US', 'en', true, now(), 9, v_reuters_id),
      ('Reuters — World News',    'https://feeds.reuters.com/Reuters/worldNews',          'world',    'US', 'en', true, now(), 8, v_reuters_id),
      ('Al Jazeera English',      'https://www.aljazeera.com/xml/rss/all.xml',            'world',    'QA', 'en', true, now(), 8, v_aljazeera_id),
      ('CNN — Top Stories',       'http://rss.cnn.com/rss/edition.rss',                   'general',  'US', 'en', true, now(), 8, v_cnn_id),
      ('CNN — World',             'http://rss.cnn.com/rss/edition_world.rss',             'world',    'US', 'en', true, now(), 7, v_cnn_id),
      ('TechCrunch',              'https://techcrunch.com/feed/',                         'tech',     'US', 'en', true, now(), 7, v_techcrunch_id),
      ('Ars Technica',            'https://feeds.arstechnica.com/arstechnica/index',      'tech',     'US', 'en', true, now(), 7, v_arstechnica_id),
      ('Goal — Latest News',      'https://www.goal.com/feeds/news?fmt=rss',              'sport',    'GB', 'en', true, now(), 6, v_goal_id),
      ('ESPN — Top Headlines',    'https://www.espn.com/espn/rss/news',                   'sport',    'US', 'en', true, now(), 6, v_espn_id)
    ON CONFLICT (url) DO UPDATE
    SET name                 = EXCLUDED.name,
        category             = EXCLUDED.category,
        country              = EXCLUDED.country,
        language             = EXCLUDED.language,
        is_active            = true,
        next_fetch_at        = LEAST(
                                 COALESCE(rss_feed_sources.next_fetch_at, now()),
                                 now()
                               ),
        priority             = GREATEST(rss_feed_sources.priority, EXCLUDED.priority),
        last_error           = NULL,
        consecutive_failures = 0,
        backoff_seconds      = 0,
        -- Only adopt the seed-provided source_id when the existing
        -- row has none, so operator-curated links survive a re-seed.
        source_id            = COALESCE(rss_feed_sources.source_id, EXCLUDED.source_id)
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
  'RSS feed catalogue into rss_feed_sources AND links each feed to a '
  'canonical sources row so ingested articles render with a real '
  'publisher name instead of "Unknown source".';

-- ------------------------------------------------------------
-- 6) Helper: _ensure_seed_publisher_source(name, website_url)
-- ------------------------------------------------------------
-- Get-or-create idiom used by seed_default_rss_feeds() above.
-- Returns the `sources.id` for a canonical publisher row,
-- creating it (with status='active') if no match exists.  Private
-- to the seeding code path; not granted to API roles.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _ensure_seed_publisher_source(
  p_name        text,
  p_website_url text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT s.id INTO v_id
    FROM public.sources s
   WHERE s.name = p_name
     AND COALESCE(s.website_url, '') = COALESCE(p_website_url, '')
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT s.id INTO v_id
    FROM public.sources s
   WHERE s.name = p_name
   ORDER BY s.created_at ASC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.sources (name, website_url, status)
  VALUES (p_name, p_website_url, 'active')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION _ensure_seed_publisher_source(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION _ensure_seed_publisher_source(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _ensure_seed_publisher_source(text, text) TO service_role;

-- Cleanup: drop the per-migration staging tables.  Safe to re-run
-- and safe whether the script executed in one transaction or many.
DROP TABLE IF EXISTS public._seed_publisher_ids_060;
DROP TABLE IF EXISTS public._seed_publishers_060;

-- ============================================================
-- END OF MIGRATION 060
-- ============================================================
