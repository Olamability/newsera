-- ============================================================
-- MIGRATION 038: Safe legacy deprecation rename (no drops)
-- ============================================================

SET ROLE postgres;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'article_likes'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '_deprecated_article_likes'
  ) THEN
    ALTER TABLE article_likes RENAME TO _deprecated_article_likes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'read_later'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '_deprecated_read_later'
  ) THEN
    ALTER TABLE read_later RENAME TO _deprecated_read_later;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'inbox_messages'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '_deprecated_inbox_messages'
  ) THEN
    ALTER TABLE inbox_messages RENAME TO _deprecated_inbox_messages;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'comments'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '_deprecated_comments'
  ) THEN
    ALTER TABLE comments RENAME TO _deprecated_comments;
  END IF;
END $$;
