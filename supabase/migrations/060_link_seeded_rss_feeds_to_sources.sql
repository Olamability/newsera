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
--
-- Runner-portability note
-- -----------------------
-- An earlier revision of this migration relied on two physical
-- staging tables (`public._seed_publishers_060` and
-- `public._seed_publisher_ids_060`) to pass the publisher catalogue
-- between top-level statements.  That arrangement broke on SQL
-- runners that split the file into independent per-statement
-- requests (both the Supabase Dashboard SQL editor and the MCP
-- `sql` endpoint behave this way, and PgBouncer in transaction
-- pooling mode amplifies the problem by reassigning each request
-- to a different backend), producing
--
--     ERROR: 42P01: relation "public._seed_publishers_060" does not exist
--
-- when a later statement landed before the CREATE TABLE became
-- visible — or, on a retry, after the `DROP TABLE` cleanup at the
-- bottom had already run.  This revision removes the staging tables
-- entirely: the publisher catalogue is now defined once as a local
-- JSONB literal inside a single self-contained `DO` block, and
-- every read of it happens within the same block on the same
-- backend, so there is no cross-statement state for any runner to
-- lose.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Upsert canonical `sources` rows, link `rss_feed_sources`,
--    and backfill orphan `articles.source_id` — all in a single
--    self-contained DO block.
-- ------------------------------------------------------------
-- The publisher catalogue is declared as a JSONB array of records
-- inside this block.  Each record carries:
--   * name          – canonical publisher name written to `sources.name`
--   * website_url   – canonical site URL written to `sources.website_url`
--   * host_patterns – authoritative URL host substrings, matched
--                     case-insensitively with `LIKE '%pattern%'` against
--                     `rss_feed_sources.url` and `articles.url`.
--                     Robust to scheme (http/https), subdomain
--                     (www, edition, feeds, ...), and path differences.
--
-- Steps performed per publisher, in order:
--   (a) Upsert one `sources` row, matching by (name, website_url)
--       first, then falling back to name-only so a row whose URL
--       drifted (e.g. http vs https) is adopted instead of duplicated.
--       Seeded publishers are real live wires, so we write
--       `status='active'` rather than the table default 'pending'.
--   (b) Link every seeded `rss_feed_sources` row whose URL matches
--       one of the publisher's host patterns and whose `source_id`
--       is still NULL — operator-curated links are left alone.
--   (c) Backfill `articles.source_id` for every article whose
--       `source_id` is NULL or points at a now-missing sources row
--       and whose URL matches one of the publisher's host patterns.
--       Bounded to one UPDATE per publisher; the UNIQUE backing
--       index on `articles.url` keeps the ILIKE reasonable.
-- ------------------------------------------------------------
DO $$
DECLARE
  -- Inlined catalogue.  Adding a publisher = adding one JSON object
  -- here; no other edits required in this block.
  publishers CONSTANT jsonb := jsonb_build_array(
    jsonb_build_object('name','BBC News',     'website_url','https://www.bbc.com',        'host_patterns', jsonb_build_array('bbc.com','bbc.co.uk','bbci.co.uk')),
    jsonb_build_object('name','Reuters',      'website_url','https://www.reuters.com',    'host_patterns', jsonb_build_array('reuters.com')),
    jsonb_build_object('name','Al Jazeera',   'website_url','https://www.aljazeera.com',  'host_patterns', jsonb_build_array('aljazeera.com')),
    jsonb_build_object('name','CNN',          'website_url','https://www.cnn.com',        'host_patterns', jsonb_build_array('cnn.com','cnn.it')),
    jsonb_build_object('name','TechCrunch',   'website_url','https://techcrunch.com',     'host_patterns', jsonb_build_array('techcrunch.com')),
    jsonb_build_object('name','Ars Technica', 'website_url','https://arstechnica.com',    'host_patterns', jsonb_build_array('arstechnica.com')),
    jsonb_build_object('name','Goal',         'website_url','https://www.goal.com',       'host_patterns', jsonb_build_array('goal.com')),
    jsonb_build_object('name','ESPN',         'website_url','https://www.espn.com',       'host_patterns', jsonb_build_array('espn.com','espn.co.uk'))
  );
  pub          jsonb;
  v_name       text;
  v_website    text;
  v_source_id  uuid;
  v_pattern    text;
  v_filters    text[];
  v_clause     text;
  v_updated    bigint;
  v_total      bigint := 0;
BEGIN
  FOR pub IN SELECT jsonb_array_elements(publishers) LOOP
    v_name    := pub->>'name';
    v_website := pub->>'website_url';

    -- (a) Get-or-create the canonical sources row.
    v_source_id := NULL;

    SELECT s.id INTO v_source_id
      FROM public.sources s
     WHERE s.name = v_name
       AND COALESCE(s.website_url, '') = COALESCE(v_website, '')
     LIMIT 1;

    IF v_source_id IS NULL THEN
      SELECT s.id INTO v_source_id
        FROM public.sources s
       WHERE s.name = v_name
       ORDER BY s.created_at ASC
       LIMIT 1;
    END IF;

    IF v_source_id IS NULL THEN
      INSERT INTO public.sources (name, website_url, status)
      VALUES (v_name, v_website, 'active')
      RETURNING id INTO v_source_id;
    ELSE
      UPDATE public.sources
         SET website_url = COALESCE(NULLIF(website_url, ''), v_website),
             status      = CASE WHEN status = 'inactive' THEN status ELSE 'active' END
       WHERE id = v_source_id
         AND (
              COALESCE(website_url, '') IS DISTINCT FROM COALESCE(NULLIF(website_url, ''), v_website)
           OR status = 'pending'
         );
    END IF;

    -- Build the ILIKE OR-chain once per publisher; reused below.
    v_filters := ARRAY[]::text[];
    FOR v_pattern IN
      SELECT jsonb_array_elements_text(pub->'host_patterns')
    LOOP
      v_filters := v_filters || format('%%%s%%', v_pattern);
    END LOOP;

    -- (b) Link seeded rss_feed_sources rows whose URL matches any
    --     host pattern and whose source_id is still NULL.
    v_clause := array_to_string(
      ARRAY(SELECT format('rfs.url ILIKE %L', p) FROM unnest(v_filters) AS p),
      ' OR '
    );

    EXECUTE format($f$
      UPDATE public.rss_feed_sources rfs
         SET source_id = %L::uuid
       WHERE rfs.source_id IS NULL
         AND (%s)
    $f$, v_source_id, v_clause);

    -- (c) Backfill orphan articles.source_id.
    v_clause := array_to_string(
      ARRAY(SELECT format('a.url ILIKE %L', p) FROM unnest(v_filters) AS p),
      ' OR '
    );

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
    $f$, v_source_id, v_clause)
    INTO v_updated;

    v_total := v_total + COALESCE(v_updated, 0);
    RAISE NOTICE 'articles.source_id backfilled for %: % rows', v_name, v_updated;
  END LOOP;

  RAISE NOTICE 'articles.source_id backfill complete: % rows total', v_total;
END $$;

-- ------------------------------------------------------------
-- 2) Helper: _ensure_seed_publisher_source(name, website_url)
-- ------------------------------------------------------------
-- Get-or-create idiom used by seed_default_rss_feeds() below.
-- Returns the `sources.id` for a canonical publisher row,
-- creating it (with status='active') if no match exists.  Private
-- to the seeding code path; not granted to API roles.
--
-- Declared before `seed_default_rss_feeds()` so the RPC body can
-- resolve the symbol on first parse without ordering issues.
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

-- ------------------------------------------------------------
-- 3) Rewrite `seed_default_rss_feeds()` to keep source_id linked
-- ------------------------------------------------------------
-- Migration 056 introduced this RPC; we preserve its signature,
-- return shape, ownership, grants, and ON CONFLICT semantics, but
-- extend the upsert to populate `source_id` from a per-publisher
-- get-or-create helper so an operator-triggered re-seed on a fresh
-- environment is self-sufficient.  Idempotent.
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
-- Cleanup: drop staging tables from any earlier revision of this
-- migration that may still be lingering in the database.  Safe and
-- idempotent — these tables are no longer created by this script.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public._seed_publisher_ids_060;
DROP TABLE IF EXISTS public._seed_publishers_060;

-- ============================================================
-- END OF MIGRATION 060
-- ============================================================
