-- ============================================================
-- MIGRATION 037: Canonical convergence backfill + bridge sync
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Backfill likes: article_likes -> article_reactions
-- ------------------------------------------------------------
DO $$
DECLARE
  has_user_id_uuid boolean;
BEGIN
  IF to_regclass('public.article_likes') IS NULL OR to_regclass('public.article_reactions') IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'article_likes'
      AND column_name = 'user_id_uuid'
  ) INTO has_user_id_uuid;

  IF has_user_id_uuid THEN
    EXECUTE $sql$
      INSERT INTO article_reactions (article_id, user_id, reaction_type, created_at, updated_at)
      SELECT
        l.article_id,
        COALESCE(
          l.user_id_uuid,
          CASE
            WHEN l.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN l.user_id::text::uuid
            ELSE NULL
          END
        ) AS user_id,
        'like',
        COALESCE(l.created_at::timestamptz, now()),
        now()
      FROM article_likes l
      WHERE COALESCE(
        l.user_id_uuid,
        CASE
          WHEN l.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN l.user_id::text::uuid
          ELSE NULL
        END
      ) IS NOT NULL
      ON CONFLICT (article_id, user_id)
      DO UPDATE SET
        reaction_type = 'like',
        updated_at = now()
    $sql$;
  ELSE
    EXECUTE $sql$
      INSERT INTO article_reactions (article_id, user_id, reaction_type, created_at, updated_at)
      SELECT
        l.article_id,
        l.user_id::text::uuid,
        'like',
        COALESCE(l.created_at::timestamptz, now()),
        now()
      FROM article_likes l
      WHERE l.user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ON CONFLICT (article_id, user_id)
      DO UPDATE SET
        reaction_type = 'like',
        updated_at = now()
    $sql$;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2) Backfill read_later -> bookmarks(type='read_later')
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.read_later') IS NULL OR to_regclass('public.bookmarks') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO bookmarks (user_id, article_id, type, created_at)
  SELECT
    rl.user_id,
    rl.article_id,
    'read_later',
    COALESCE(rl.created_at::timestamptz, now())
  FROM read_later rl
  WHERE rl.user_id IS NOT NULL
  ON CONFLICT (user_id, article_id, type)
  DO NOTHING;
END $$;

-- ------------------------------------------------------------
-- 3) Backfill inbox_messages -> notifications
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.inbox_messages') IS NULL OR to_regclass('public.notifications') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO notifications (id, user_id, title, body, article_id, read, created_at)
  SELECT
    im.id,
    im.user_id,
    im.title,
    im.body,
    im.article_id,
    COALESCE(im.read, false),
    COALESCE(im.created_at::timestamptz, now())
  FROM inbox_messages im
  ON CONFLICT (id)
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    article_id = EXCLUDED.article_id,
    read = EXCLUDED.read;
END $$;

-- ------------------------------------------------------------
-- 4) Temporary bridge: canonical likes write-through to legacy
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_article_reactions_to_legacy_likes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF to_regclass('public.article_likes') IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.reaction_type = 'like' THEN
      INSERT INTO article_likes (article_id, user_id, created_at)
      VALUES (NEW.article_id, NEW.user_id::text, COALESCE(NEW.created_at, now()))
      ON CONFLICT (article_id, user_id)
      DO NOTHING;

      BEGIN
        UPDATE article_likes
        SET user_id_uuid = NEW.user_id
        WHERE article_id = NEW.article_id
          AND user_id = NEW.user_id::text
          AND (user_id_uuid IS NULL OR user_id_uuid <> NEW.user_id);
      EXCEPTION
        WHEN undefined_column THEN
          NULL;
      END;
    ELSE
      DELETE FROM article_likes
      WHERE article_id = NEW.article_id
        AND user_id = NEW.user_id::text;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND OLD.reaction_type = 'like' THEN
    DELETE FROM article_likes
    WHERE article_id = OLD.article_id
      AND user_id = OLD.user_id::text;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_article_reactions_to_legacy_likes ON article_reactions;
CREATE TRIGGER trg_sync_article_reactions_to_legacy_likes
AFTER INSERT OR UPDATE OR DELETE ON article_reactions
FOR EACH ROW
EXECUTE FUNCTION sync_article_reactions_to_legacy_likes();

-- ------------------------------------------------------------
-- 5) Validation helpers (manual post-migration checks)
-- ------------------------------------------------------------
-- Legacy dependency check:
-- SELECT table_schema, table_name
-- FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('article_likes', 'read_later', 'inbox_messages', 'comments');
--
-- Canonical coverage checks:
-- SELECT COUNT(*) FROM article_reactions;
-- SELECT COUNT(*) FROM bookmarks WHERE type = 'read_later';
-- SELECT COUNT(*) FROM notifications;
-- SELECT COUNT(*) FROM article_comments;
