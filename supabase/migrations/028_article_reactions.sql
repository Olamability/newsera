-- ============================================================
-- MIGRATION 028: Unified article reactions (like/dislike)
--
-- Goal:
-- - Add scalable per-user reaction table for article-level reactions
-- - Support mutually exclusive like/dislike toggles
-- - Enable realtime subscriptions for reaction count updates
-- ============================================================

CREATE TABLE IF NOT EXISTS article_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text NOT NULL CHECK (reaction_type IN ('like', 'dislike')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_article_reactions_article_id
  ON article_reactions (article_id);

CREATE INDEX IF NOT EXISTS idx_article_reactions_article_type
  ON article_reactions (article_id, reaction_type);

CREATE INDEX IF NOT EXISTS idx_article_reactions_user_id
  ON article_reactions (user_id);

-- Keep updated_at current on updates.
CREATE OR REPLACE FUNCTION set_article_reactions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_article_reactions_updated_at ON article_reactions;
CREATE TRIGGER trg_article_reactions_updated_at
BEFORE UPDATE ON article_reactions
FOR EACH ROW
EXECUTE FUNCTION set_article_reactions_updated_at();

-- Realtime publication support.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'article_reactions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE article_reactions;
    END IF;
  END IF;
END $$;

ALTER TABLE article_reactions REPLICA IDENTITY FULL;

ALTER TABLE article_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS article_reactions_select_public ON article_reactions;
DROP POLICY IF EXISTS article_reactions_insert_authenticated ON article_reactions;
DROP POLICY IF EXISTS article_reactions_update_owner ON article_reactions;
DROP POLICY IF EXISTS article_reactions_delete_owner ON article_reactions;

CREATE POLICY article_reactions_select_public
  ON article_reactions
  FOR SELECT
  USING (true);

CREATE POLICY article_reactions_insert_authenticated
  ON article_reactions
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY article_reactions_update_owner
  ON article_reactions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY article_reactions_delete_owner
  ON article_reactions
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
