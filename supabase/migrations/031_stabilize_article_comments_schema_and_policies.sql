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
