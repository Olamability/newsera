-- ============================================================
-- MIGRATION 031: Stabilize article_comments schema + policies
--
-- Goal:
-- - Guarantee the threaded comments schema expected by the mobile app
-- - Align article_comments policies with authenticated inserts + public reads
-- - Keep realtime-safe defaults for production comment publishing
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS article_comments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  parent_id uuid NULL REFERENCES article_comments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE article_comments
  ADD COLUMN IF NOT EXISTS parent_id uuid NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

ALTER TABLE article_comments
  ALTER COLUMN id SET DEFAULT uuid_generate_v4(),
  ALTER COLUMN article_id SET NOT NULL,
  ALTER COLUMN content SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

-- Drop user_id-dependent policies before replacing a legacy non-uuid user_id column.
DROP POLICY IF EXISTS article_comments_select_all ON article_comments;
DROP POLICY IF EXISTS article_comments_select_public ON article_comments;
DROP POLICY IF EXISTS article_comments_insert_authenticated ON article_comments;
DROP POLICY IF EXISTS article_comments_update_owner ON article_comments;
DROP POLICY IF EXISTS article_comments_delete_owner ON article_comments;
DROP POLICY IF EXISTS "Allow authenticated users to insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow authenticated insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow public read comments" ON article_comments;
DROP POLICY IF EXISTS "Allow users update own comments" ON article_comments;
DROP POLICY IF EXISTS "Allow users delete own comments" ON article_comments;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'user_id'
      AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE article_comments ADD COLUMN IF NOT EXISTS user_id_uuid uuid;

    -- UUID-shaped user IDs are preserved; legacy guest/device IDs are cleaned up below.
    UPDATE article_comments
    SET user_id_uuid = CASE
      WHEN user_id::text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN user_id::text::uuid
      ELSE NULL
    END;

    -- Legacy guest/device comment rows cannot satisfy the authenticated UUID FK.
    DELETE FROM article_comments WHERE user_id_uuid IS NULL;

    ALTER TABLE article_comments DROP COLUMN user_id;
    ALTER TABLE article_comments RENAME COLUMN user_id_uuid TO user_id;
  END IF;
END $$;

ALTER TABLE article_comments
  ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  -- STEP 1: Identify dependent objects before parent_id type change.
  -- (Views/materialized views/rules/indexes/triggers can depend on this column.)
  PERFORM 1
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class c ON c.oid = rw.ev_class
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE t.relname = 'article_comments'
    AND a.attname = 'parent_id'
    AND c.relname = 'articles_engagement_feed';
END $$;

-- STEP 2: Drop dependent materialized view before type alteration.
DROP MATERIALIZED VIEW IF EXISTS articles_engagement_feed;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'parent_id'
      AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE article_comments
      ALTER COLUMN parent_id TYPE uuid
      USING CASE
        WHEN parent_id IS NULL THEN NULL
        WHEN parent_id::text ~ '^[0-9a-fA-F-]{36}$'
          THEN parent_id::text::uuid
        ELSE NULL
      END;
  END IF;
END $$;

-- STEP 4: Recreate materialized engagement feed exactly as before.
CREATE MATERIALIZED VIEW articles_engagement_feed AS
SELECT
  a.id,
  a.title,
  a.content,
  a.snippet,
  a.source_id,
  a.image_url,
  a.published_at,
  a.url,
  a.category_id,
  s.name AS source_name,
  s.website_url AS source_website_url,
  s.logo_url AS source_logo_url,
  c.name AS category_name,
  c.slug AS category_slug,
  COALESCE(l.likes_count, 0)::int AS likes_count,
  COALESCE(cm.comments_count, 0)::int AS comments_count,
  COALESCE(cm.replies_count, 0)::int AS replies_count,
  0::int AS shares_count,
  COALESCE(v.views_count, 0)::int AS views_count,
  (
    (COALESCE(l.likes_count, 0) * 1.0)
    + (COALESCE(cm.comments_count, 0) * 2.0)
    + (COALESCE(cm.replies_count, 0) * 1.5)
    + (COALESCE(v.views_count, 0) * 0.2)
    - (
      GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, now()))) / 3600,
        0
      ) * 0.05
    )
  )::numeric(14,4) AS engagement_score
FROM articles a
LEFT JOIN sources s ON s.id = a.source_id
LEFT JOIN categories c ON c.id = a.category_id
LEFT JOIN (
  SELECT article_id, COUNT(*)::int AS likes_count
  FROM article_likes
  GROUP BY article_id
) l ON l.article_id = a.id
LEFT JOIN (
  SELECT
    article_id,
    COUNT(*) FILTER (WHERE parent_id IS NULL)::int AS comments_count,
    COUNT(*) FILTER (WHERE parent_id IS NOT NULL)::int AS replies_count
  FROM article_comments
  GROUP BY article_id
) cm ON cm.article_id = a.id
LEFT JOIN (
  SELECT article_id, COUNT(*)::int AS views_count
  FROM article_clicks
  GROUP BY article_id
) v ON v.article_id = a.id
WHERE (
  a.published_at >= now() - INTERVAL '7 days'
  OR a.published_at IS NULL
)
WITH DATA;

-- STEP 5: Recreate materialized view indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aef_id
  ON articles_engagement_feed (id);
CREATE INDEX IF NOT EXISTS idx_aef_engagement_score
  ON articles_engagement_feed (engagement_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_aef_published_at
  ON articles_engagement_feed (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_aef_category_id
  ON articles_engagement_feed (category_id);

GRANT SELECT ON articles_engagement_feed TO anon, authenticated;

-- STEP 6: Refresh materialized view after rebuild.
REFRESH MATERIALIZED VIEW articles_engagement_feed;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'created_at'
      AND data_type <> 'timestamp with time zone'
  ) THEN
    ALTER TABLE article_comments
      ALTER COLUMN created_at TYPE timestamptz
      USING timezone('utc', created_at);
  END IF;
END $$;

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'article_comments'::regclass
      AND contype = 'f'
      AND conname IN (
        'article_comments_article_id_fkey',
        'article_comments_user_id_fkey',
        'article_comments_parent_id_fkey'
      )
  LOOP
    EXECUTE format('ALTER TABLE article_comments DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;

ALTER TABLE article_comments
  ADD CONSTRAINT article_comments_article_id_fkey
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
  ADD CONSTRAINT article_comments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD CONSTRAINT article_comments_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES article_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_article_comments_article_id ON article_comments (article_id);
CREATE INDEX IF NOT EXISTS idx_article_comments_parent_id ON article_comments (parent_id);
CREATE INDEX IF NOT EXISTS idx_article_comments_created_at_desc ON article_comments (created_at DESC);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'article_comments'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE article_comments;
    END IF;
  END IF;
END $$;

ALTER TABLE article_comments REPLICA IDENTITY FULL;
ALTER TABLE article_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS article_comments_select_all ON article_comments;
DROP POLICY IF EXISTS article_comments_select_public ON article_comments;
DROP POLICY IF EXISTS article_comments_insert_authenticated ON article_comments;
DROP POLICY IF EXISTS article_comments_update_owner ON article_comments;
DROP POLICY IF EXISTS article_comments_delete_owner ON article_comments;
DROP POLICY IF EXISTS "Allow authenticated users to insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow authenticated insert comments" ON article_comments;
DROP POLICY IF EXISTS "Allow public read comments" ON article_comments;
DROP POLICY IF EXISTS "Allow users update own comments" ON article_comments;
DROP POLICY IF EXISTS "Allow users delete own comments" ON article_comments;

CREATE POLICY "Allow authenticated insert comments"
  ON article_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow public read comments"
  ON article_comments
  FOR SELECT
  USING (true);

CREATE POLICY "Allow users update own comments"
  ON article_comments
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Allow users delete own comments"
  ON article_comments
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON article_comments TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON article_comments TO authenticated;
