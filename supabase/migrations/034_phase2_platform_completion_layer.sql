-- ============================================================
-- MIGRATION 034: Phase 2 platform completion layer
-- - Add missing platform tables (additive only)
-- - Strengthen type integrity with staged UUID/int columns
-- - Establish canonical engagement path (article_reactions)
-- - Prepare deprecation of legacy duplicate tables safely
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Domain consistency for articles + source linkage
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS articles
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS author text,
  ADD COLUMN IF NOT EXISTS read_time_seconds integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'articles'::regclass
      AND conname = 'articles_status_check'
  ) THEN
    ALTER TABLE articles
      ADD CONSTRAINT articles_status_check
      CHECK (status IN ('draft', 'published', 'archived'));
  END IF;
END $$;

ALTER TABLE IF EXISTS rss_feed_sources
  ADD COLUMN IF NOT EXISTS source_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rss_feed_sources'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'rss_feed_sources'::regclass
      AND conname = 'rss_feed_sources_source_id_fkey'
  ) THEN
    ALTER TABLE rss_feed_sources
      ADD CONSTRAINT rss_feed_sources_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rss_feed_sources_source_id
  ON rss_feed_sources (source_id);

-- ------------------------------------------------------------
-- 2) Type integrity staging (non-breaking)
-- ------------------------------------------------------------
-- article_likes.user_id(text) -> user_id_uuid(uuid) staged
ALTER TABLE IF EXISTS article_likes
  ADD COLUMN IF NOT EXISTS user_id_uuid uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_likes'
      AND column_name = 'user_id'
      AND data_type = 'text'
  ) THEN
    UPDATE article_likes
    SET user_id_uuid = CASE
      WHEN user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND EXISTS (
          SELECT 1
          FROM auth.users au
          WHERE au.id = user_id::uuid
        )
        THEN user_id::uuid
      ELSE NULL
    END
    WHERE user_id_uuid IS NULL;
  END IF;
END $$;

UPDATE article_likes al
SET user_id_uuid = NULL
WHERE user_id_uuid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM auth.users au
    WHERE au.id = al.user_id_uuid
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'article_likes'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'article_likes'::regclass
      AND conname = 'article_likes_user_id_uuid_fkey'
  ) THEN
    ALTER TABLE article_likes
      ADD CONSTRAINT article_likes_user_id_uuid_fkey
      FOREIGN KEY (user_id_uuid) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_likes_article_user_uuid_unique
  ON article_likes (article_id, user_id_uuid)
  WHERE user_id_uuid IS NOT NULL;

-- user_interests.user_id(text) -> user_id_uuid(uuid) staged
ALTER TABLE IF EXISTS user_interests
  ADD COLUMN IF NOT EXISTS user_id_uuid uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_interests'
      AND column_name = 'user_id'
      AND data_type = 'text'
  ) THEN
    UPDATE user_interests
    SET user_id_uuid = CASE
      WHEN user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND EXISTS (
          SELECT 1
          FROM auth.users au
          WHERE au.id = user_id::uuid
        )
        THEN user_id::uuid
      ELSE NULL
    END
    WHERE user_id_uuid IS NULL;
  END IF;
END $$;

UPDATE user_interests ui
SET user_id_uuid = NULL
WHERE user_id_uuid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM auth.users au
    WHERE au.id = ui.user_id_uuid
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_interests'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'user_interests'::regclass
      AND conname = 'user_interests_user_id_uuid_fkey'
  ) THEN
    ALTER TABLE user_interests
      ADD CONSTRAINT user_interests_user_id_uuid_fkey
      FOREIGN KEY (user_id_uuid) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_interests_user_uuid_category_unique
  ON user_interests (user_id_uuid, category_id)
  WHERE user_id_uuid IS NOT NULL;

-- article_comments.likes_count(text) -> likes_count_int(int) staged
ALTER TABLE IF EXISTS article_comments
  ADD COLUMN IF NOT EXISTS likes_count_int integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_comments'
      AND column_name = 'likes_count'
      AND data_type = 'text'
  ) THEN
    UPDATE article_comments
    SET likes_count_int = CASE
      WHEN likes_count ~ '^[0-9]+$' THEN likes_count::integer
      ELSE 0
    END
    WHERE likes_count_int = 0;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3) Missing production platform tables (additive)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id text,
  platform text NOT NULL DEFAULT 'other'
    CHECK (platform IN ('whatsapp', 'twitter', 'facebook', 'copy_link', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_article_shares_article_created
  ON article_shares (article_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_shares_user_created
  ON article_shares (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_read_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_event_id uuid,
  read_at timestamptz NOT NULL DEFAULT now(),
  read_duration_seconds integer NOT NULL DEFAULT 0,
  read_completion_percent smallint NOT NULL DEFAULT 0
    CHECK (read_completion_percent BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_user_read_history_user_read_at
  ON user_read_history (user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_read_history_article_read_at
  ON user_read_history (article_id, read_at DESC);

CREATE TABLE IF NOT EXISTS content_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('article', 'comment', 'source')),
  article_id uuid REFERENCES articles(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES article_comments(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_flags_target_consistency_check CHECK (
    (target_type = 'article' AND article_id IS NOT NULL AND comment_id IS NULL AND source_id IS NULL)
    OR (target_type = 'comment' AND comment_id IS NOT NULL AND article_id IS NULL AND source_id IS NULL)
    OR (target_type = 'source' AND source_id IS NOT NULL AND article_id IS NULL AND comment_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_content_flags_status_created
  ON content_flags (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_flags_reporter_created
  ON content_flags (reporter_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_created
  ON admin_audit_log (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_entity
  ON admin_audit_log (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id uuid NOT NULL REFERENCES rss_feed_sources(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  schedule_cron text NOT NULL,
  priority smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_status text CHECK (last_status IN ('queued', 'running', 'success', 'failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed_id)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_enabled_next_run
  ON ingestion_jobs (enabled, next_run_at ASC);

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_name_unique UNIQUE (name),
  CONSTRAINT tags_slug_unique UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_article_tags_tag_id
  ON article_tags (tag_id);

-- ------------------------------------------------------------
-- 4) Engagement completion: canonical reactions + legacy bridge
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_reactions_article_user_unique
  ON article_reactions (article_id, user_id);

CREATE OR REPLACE FUNCTION sync_legacy_article_likes_to_reactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS NOT NULL
       AND NEW.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_user_id := NEW.user_id::text::uuid;

      INSERT INTO article_reactions (article_id, user_id, reaction_type)
      VALUES (NEW.article_id, v_user_id, 'like')
      ON CONFLICT (article_id, user_id)
      DO UPDATE SET
        reaction_type = EXCLUDED.reaction_type,
        updated_at = now();
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.user_id IS NOT NULL
       AND OLD.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      DELETE FROM article_reactions
      WHERE article_id = OLD.article_id
        AND user_id = OLD.user_id::text::uuid;
    END IF;

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_legacy_article_likes_to_reactions ON article_likes;
CREATE TRIGGER trg_sync_legacy_article_likes_to_reactions
AFTER INSERT OR UPDATE OR DELETE ON article_likes
FOR EACH ROW
EXECUTE FUNCTION sync_legacy_article_likes_to_reactions();

-- Backfill canonical reactions from existing legacy likes.
INSERT INTO article_reactions (article_id, user_id, reaction_type, created_at, updated_at)
SELECT
  l.article_id,
  l.user_id::uuid,
  'like',
  COALESCE(l.created_at::timestamptz, now()),
  now()
FROM article_likes l
WHERE l.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (article_id, user_id)
DO NOTHING;

-- ------------------------------------------------------------
-- 5) UX unification path: bookmarks + read_later
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS bookmarks
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'bookmark';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'bookmarks'::regclass
      AND conname = 'bookmarks_type_check'
  ) THEN
    ALTER TABLE bookmarks
      ADD CONSTRAINT bookmarks_type_check
      CHECK (type IN ('bookmark', 'read_later'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'bookmarks'::regclass
      AND conname = 'bookmarks_user_article_unique'
  ) THEN
    ALTER TABLE bookmarks DROP CONSTRAINT bookmarks_user_article_unique;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'bookmarks'::regclass
      AND conname = 'bookmarks_user_article_type_unique'
  ) THEN
    ALTER TABLE bookmarks
      ADD CONSTRAINT bookmarks_user_article_type_unique
      UNIQUE (user_id, article_id, type);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_type_created
  ON bookmarks (user_id, type, created_at DESC);

-- Keep read_later behavior intact while merging into canonical bookmarks model.
CREATE OR REPLACE FUNCTION sync_read_later_to_bookmarks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NOT NULL THEN
      INSERT INTO bookmarks (user_id, article_id, type, created_at)
      VALUES (NEW.user_id, NEW.article_id, 'read_later', NEW.created_at)
      ON CONFLICT (user_id, article_id, type)
      DO UPDATE SET created_at = EXCLUDED.created_at;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.user_id IS NOT NULL THEN
      DELETE FROM bookmarks
      WHERE user_id = OLD.user_id
        AND article_id = OLD.article_id
        AND type = 'read_later';
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_read_later_to_bookmarks ON read_later;
CREATE TRIGGER trg_sync_read_later_to_bookmarks
AFTER INSERT OR DELETE ON read_later
FOR EACH ROW
EXECUTE FUNCTION sync_read_later_to_bookmarks();

-- Seed canonical bookmark rows for existing read_later entries.
INSERT INTO bookmarks (user_id, article_id, type, created_at)
SELECT rl.user_id, rl.article_id, 'read_later', rl.created_at
FROM read_later rl
WHERE rl.user_id IS NOT NULL
ON CONFLICT (user_id, article_id, type)
DO NOTHING;

-- ------------------------------------------------------------
-- 6) Deprecated duplicate truth tables (rename only; no drops)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'news'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_deprecated_news'
  ) THEN
    ALTER TABLE news RENAME TO _deprecated_news;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'comments'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_deprecated_comments'
  ) THEN
    ALTER TABLE comments RENAME TO _deprecated_comments;
  END IF;
END $$;

-- Compatibility read-only views to avoid runtime regressions during transition.
CREATE OR REPLACE VIEW news AS
SELECT
  a.id,
  a.title,
  a.content,
  a.snippet,
  a.source_id,
  a.image_url,
  a.published_at,
  a.url,
  a.category_id
FROM articles a;

CREATE OR REPLACE VIEW comments AS
SELECT
  ac.id,
  ac.article_id,
  ac.user_id,
  ac.content,
  ac.created_at
FROM article_comments ac
WHERE ac.parent_id IS NULL;

-- ------------------------------------------------------------
-- 7) RLS for new/sensitive tables (phase 2 baseline)
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS article_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_read_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS content_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS article_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS article_shares_select_all ON article_shares;
DROP POLICY IF EXISTS article_shares_insert_own ON article_shares;
DROP POLICY IF EXISTS article_shares_delete_own ON article_shares;

CREATE POLICY article_shares_select_all
  ON article_shares
  FOR SELECT
  USING (true);

CREATE POLICY article_shares_insert_own
  ON article_shares
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id IS NULL OR auth.uid() = user_id);

CREATE POLICY article_shares_delete_own
  ON article_shares
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_read_history_select_own ON user_read_history;
DROP POLICY IF EXISTS user_read_history_insert_own ON user_read_history;
DROP POLICY IF EXISTS user_read_history_update_own ON user_read_history;
DROP POLICY IF EXISTS user_read_history_delete_own ON user_read_history;

CREATE POLICY user_read_history_select_own
  ON user_read_history
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_read_history_insert_own
  ON user_read_history
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_read_history_update_own
  ON user_read_history
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_read_history_delete_own
  ON user_read_history
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS content_flags_select_owner_or_admin ON content_flags;
DROP POLICY IF EXISTS content_flags_insert_authenticated ON content_flags;
DROP POLICY IF EXISTS content_flags_update_admin ON content_flags;

CREATE POLICY content_flags_select_owner_or_admin
  ON content_flags
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = reporter_user_id
    OR coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
  );

CREATE POLICY content_flags_insert_authenticated
  ON content_flags
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = reporter_user_id);

CREATE POLICY content_flags_update_admin
  ON content_flags
  FOR UPDATE
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

DROP POLICY IF EXISTS admin_audit_log_select_admin ON admin_audit_log;
DROP POLICY IF EXISTS admin_audit_log_insert_admin ON admin_audit_log;

CREATE POLICY admin_audit_log_select_admin
  ON admin_audit_log
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY admin_audit_log_insert_admin
  ON admin_audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    AND auth.uid() = admin_user_id
  );

DROP POLICY IF EXISTS ingestion_jobs_select_admin ON ingestion_jobs;
DROP POLICY IF EXISTS ingestion_jobs_write_service_role ON ingestion_jobs;

CREATE POLICY ingestion_jobs_select_admin
  ON ingestion_jobs
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY ingestion_jobs_write_service_role
  ON ingestion_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tags_select_all ON tags;
DROP POLICY IF EXISTS tags_admin_write ON tags;
DROP POLICY IF EXISTS article_tags_select_all ON article_tags;
DROP POLICY IF EXISTS article_tags_admin_write ON article_tags;

CREATE POLICY tags_select_all
  ON tags
  FOR SELECT
  USING (true);

CREATE POLICY tags_admin_write
  ON tags
  FOR ALL
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY article_tags_select_all
  ON article_tags
  FOR SELECT
  USING (true);

CREATE POLICY article_tags_admin_write
  ON article_tags
  FOR ALL
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

-- Ingestion write path must be service-role only.
ALTER TABLE IF EXISTS rss_feed_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS rss_ingestion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rss_feed_sources_select_admin ON rss_feed_sources;
DROP POLICY IF EXISTS rss_feed_sources_write_service_role ON rss_feed_sources;
DROP POLICY IF EXISTS rss_ingestion_log_select_admin ON rss_ingestion_log;
DROP POLICY IF EXISTS rss_ingestion_log_write_service_role ON rss_ingestion_log;

CREATE POLICY rss_feed_sources_select_admin
  ON rss_feed_sources
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY rss_feed_sources_write_service_role
  ON rss_feed_sources
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY rss_ingestion_log_select_admin
  ON rss_ingestion_log
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY rss_ingestion_log_write_service_role
  ON rss_ingestion_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
