-- ============================================================
-- MIGRATION 028: Reset article_comments RLS policies
--
-- Goal:
-- - Ensure article_comments.user_id is uuid
-- - Drop all existing/stale policies on article_comments
-- - Recreate clean canonical RLS policies
-- ============================================================

-- Ensure user_id is uuid and compatible with auth.users.id.
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
    ALTER TABLE public.article_comments
      ADD COLUMN IF NOT EXISTS user_id_uuid uuid;

    UPDATE public.article_comments
    SET user_id_uuid = CASE
      WHEN user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN user_id::text::uuid
      ELSE NULL
    END;

    DELETE FROM public.article_comments WHERE user_id_uuid IS NULL;

    ALTER TABLE public.article_comments DROP COLUMN user_id;
    ALTER TABLE public.article_comments RENAME COLUMN user_id_uuid TO user_id;
  END IF;
END $$;

ALTER TABLE public.article_comments
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid,
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.article_comments ENABLE ROW LEVEL SECURITY;

-- Drop all existing policies to remove stale/conflicting policy definitions.
DO $$
DECLARE
  policy_record record;
BEGIN
  FOR policy_record IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'article_comments'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.article_comments',
      policy_record.policyname
    );
  END LOOP;
END $$;

CREATE POLICY "Anyone can read comments"
ON public.article_comments
FOR SELECT
USING (true);

CREATE POLICY "Authenticated users can insert comments"
ON public.article_comments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
);

CREATE POLICY "Users can update own comments"
ON public.article_comments
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
);

CREATE POLICY "Users can delete own comments"
ON public.article_comments
FOR DELETE
TO authenticated
USING (
  auth.uid() = user_id
);
