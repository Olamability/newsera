-- ============================================================
-- MIGRATION 036: Foreign-key reconstruction and integrity hardening
-- - Reconstructs runtime-implied relational model with additive, safe FK enforcement
-- - Repairs nullable orphan references in-place (set NULL only)
-- - Adds FK-supporting indexes where missing
-- - Applies NOT VALID FKs and validates only when existing data is clean
-- ============================================================

SET ROLE postgres;

CREATE TABLE IF NOT EXISTS public.relational_integrity_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  constraint_name text NOT NULL,
  source_table text NOT NULL,
  source_column text NOT NULL,
  target_table text NOT NULL,
  target_column text NOT NULL,
  orphan_count bigint NOT NULL,
  action text NOT NULL,
  notes text
);

CREATE OR REPLACE FUNCTION public.ensure_fk_constraint(
  p_constraint_name text,
  p_source_table text,
  p_source_column text,
  p_target_table text,
  p_target_column text,
  p_on_delete text,
  p_null_cleanup boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_schema text := split_part(p_source_table, '.', 1);
  v_source_rel text := split_part(p_source_table, '.', 2);
  v_target_schema text := split_part(p_target_table, '.', 1);
  v_target_rel text := split_part(p_target_table, '.', 2);
  v_nullable text;
  v_index_name text;
  v_orphans bigint := 0;
BEGIN
  IF v_source_rel = '' THEN
    v_source_rel := v_source_schema;
    v_source_schema := 'public';
  END IF;

  IF v_target_rel = '' THEN
    v_target_rel := v_target_schema;
    v_target_schema := 'public';
  END IF;

  SELECT is_nullable
  INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = v_source_schema
    AND table_name = v_source_rel
    AND column_name = p_source_column
  LIMIT 1;

  IF v_nullable IS NULL THEN
    INSERT INTO public.relational_integrity_audit (constraint_name, source_table, source_column, target_table, target_column, orphan_count, action, notes)
    VALUES (p_constraint_name, p_source_table, p_source_column, p_target_table, p_target_column, 0, 'skipped', 'source column not found');
    RETURN;
  END IF;

  v_index_name := left(format('idx_%s_%s_fk', v_source_rel, p_source_column), 63);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (%I)', v_index_name, v_source_schema, v_source_rel, p_source_column);

  IF p_null_cleanup AND v_nullable = 'YES' THEN
    EXECUTE format(
      'UPDATE %I.%I src SET %I = NULL WHERE src.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I.%I tgt WHERE tgt.%I = src.%I)'
      , v_source_schema, v_source_rel, p_source_column, p_source_column, v_target_schema, v_target_rel, p_target_column, p_source_column
    );
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I src WHERE src.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I.%I tgt WHERE tgt.%I = src.%I)'
    , v_source_schema, v_source_rel, p_source_column, v_target_schema, v_target_rel, p_target_column, p_source_column
  ) INTO v_orphans;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = p_constraint_name
      AND n.nspname = v_source_schema
      AND r.relname = v_source_rel
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I (%I) ON DELETE %s NOT VALID'
      , v_source_schema, v_source_rel, p_constraint_name, p_source_column, v_target_schema, v_target_rel, p_target_column, p_on_delete
    );
  END IF;

  IF v_orphans = 0 THEN
    EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', v_source_schema, v_source_rel, p_constraint_name);
    INSERT INTO public.relational_integrity_audit (constraint_name, source_table, source_column, target_table, target_column, orphan_count, action, notes)
    VALUES (p_constraint_name, p_source_table, p_source_column, p_target_table, p_target_column, v_orphans, 'validated', 'constraint validated successfully');
  ELSE
    INSERT INTO public.relational_integrity_audit (constraint_name, source_table, source_column, target_table, target_column, orphan_count, action, notes)
    VALUES (p_constraint_name, p_source_table, p_source_column, p_target_table, p_target_column, v_orphans, 'deferred_validation', 'existing orphan rows detected; FK enforces new writes only');
  END IF;
END;
$$;

SELECT public.ensure_fk_constraint('articles_source_id_fkey', 'public.articles', 'source_id', 'public.sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('articles_category_id_fkey', 'public.articles', 'category_id', 'public.categories', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('sources_category_id_fkey', 'public.sources', 'category_id', 'public.categories', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('bookmarks_user_id_fkey', 'public.bookmarks', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('bookmarks_article_id_fkey', 'public.bookmarks', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('read_later_user_id_fkey', 'public.read_later', 'user_id', 'auth.users', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('read_later_article_id_fkey', 'public.read_later', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_comments_article_id_fkey', 'public.article_comments', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_comments_user_id_fkey', 'public.article_comments', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_comments_parent_id_fkey', 'public.article_comments', 'parent_id', 'public.article_comments', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('article_reactions_article_id_fkey', 'public.article_reactions', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_reactions_user_id_fkey', 'public.article_reactions', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_likes_article_id_fkey', 'public.article_likes', 'article_id', 'public.articles', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('article_likes_user_id_uuid_fkey', 'public.article_likes', 'user_id_uuid', 'auth.users', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('article_clicks_article_id_fkey', 'public.article_clicks', 'article_id', 'public.articles', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('article_clicks_source_id_fkey', 'public.article_clicks', 'source_id', 'public.sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('article_clicks_user_id_fkey', 'public.article_clicks', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('article_clicks_partitioned_article_id_fkey', 'public.article_clicks_partitioned', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_clicks_partitioned_source_id_fkey', 'public.article_clicks_partitioned', 'source_id', 'public.sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('article_clicks_partitioned_user_id_fkey', 'public.article_clicks_partitioned', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('blocked_users_user_id_fkey', 'public.blocked_users', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('blocked_users_blocked_user_id_fkey', 'public.blocked_users', 'blocked_user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('blocked_users_blocked_source_id_fkey', 'public.blocked_users', 'blocked_source_id', 'public.sources', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('feedback_user_id_fkey', 'public.feedback', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('inbox_messages_user_id_fkey', 'public.inbox_messages', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('inbox_messages_article_id_fkey', 'public.inbox_messages', 'article_id', 'public.articles', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('notifications_user_id_fkey', 'public.notifications', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('notifications_article_id_fkey', 'public.notifications', 'article_id', 'public.articles', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('user_devices_user_id_fkey', 'public.user_devices', 'user_id', 'auth.users', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('user_preferences_user_id_fkey', 'public.user_preferences', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('user_rewards_user_id_fkey', 'public.user_rewards', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('reward_events_user_id_fkey', 'public.reward_events', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('user_read_history_user_id_fkey', 'public.user_read_history', 'user_id', 'auth.users', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('user_read_history_article_id_fkey', 'public.user_read_history', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('user_interests_category_id_fkey', 'public.user_interests', 'category_id', 'public.categories', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('user_interests_user_id_uuid_fkey', 'public.user_interests', 'user_id_uuid', 'auth.users', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('content_flags_reporter_user_id_fkey', 'public.content_flags', 'reporter_user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('content_flags_reviewed_by_fkey', 'public.content_flags', 'reviewed_by', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('content_flags_article_id_fkey', 'public.content_flags', 'article_id', 'public.articles', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('content_flags_comment_id_fkey', 'public.content_flags', 'comment_id', 'public.article_comments', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('content_flags_source_id_fkey', 'public.content_flags', 'source_id', 'public.sources', 'id', 'CASCADE', true);
SELECT public.ensure_fk_constraint('article_shares_article_id_fkey', 'public.article_shares', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_shares_user_id_fkey', 'public.article_shares', 'user_id', 'auth.users', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('article_tags_article_id_fkey', 'public.article_tags', 'article_id', 'public.articles', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('article_tags_tag_id_fkey', 'public.article_tags', 'tag_id', 'public.tags', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('rss_feed_sources_source_id_fkey', 'public.rss_feed_sources', 'source_id', 'public.sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('rss_ingestion_log_feed_id_fkey', 'public.rss_ingestion_log', 'feed_id', 'public.rss_feed_sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('ingestion_jobs_feed_id_fkey', 'public.ingestion_jobs', 'feed_id', 'public.rss_feed_sources', 'id', 'CASCADE', false);
SELECT public.ensure_fk_constraint('ingestion_jobs_source_id_fkey', 'public.ingestion_jobs', 'source_id', 'public.sources', 'id', 'SET NULL', true);
SELECT public.ensure_fk_constraint('admin_audit_log_admin_user_id_fkey', 'public.admin_audit_log', 'admin_user_id', 'auth.users', 'id', 'CASCADE', false);

CREATE INDEX IF NOT EXISTS idx_article_comments_user_id ON article_comments (user_id);
CREATE INDEX IF NOT EXISTS idx_article_likes_article_id ON article_likes (article_id);
CREATE INDEX IF NOT EXISTS idx_article_likes_user_id_uuid ON article_likes (user_id_uuid) WHERE user_id_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_user_id ON blocked_users (blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_source_id ON blocked_users (blocked_source_id);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback (user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_article_id ON inbox_messages (article_id);
CREATE INDEX IF NOT EXISTS idx_notifications_article_id ON notifications (article_id);
CREATE INDEX IF NOT EXISTS idx_read_later_article_id ON read_later (article_id);
CREATE INDEX IF NOT EXISTS idx_content_flags_article_id ON content_flags (article_id);
CREATE INDEX IF NOT EXISTS idx_content_flags_comment_id ON content_flags (comment_id);
CREATE INDEX IF NOT EXISTS idx_content_flags_source_id ON content_flags (source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_id ON ingestion_jobs (source_id);

DROP FUNCTION IF EXISTS public.ensure_fk_constraint(text, text, text, text, text, text, boolean);
