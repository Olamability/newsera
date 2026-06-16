-- ============================================================
-- MIGRATION 064: Fix article_reactions RLS policies
-- ============================================================
-- Purpose:
--   Fix RLS policies on article_reactions to ensure authenticated
--   users can properly insert, update, and delete their reactions.
--   The current policies may be too restrictive or have timing issues.
-- ============================================================

-- Drop existing policies
DROP POLICY IF EXISTS article_reactions_select_public ON article_reactions;
DROP POLICY IF EXISTS article_reactions_insert_authenticated ON article_reactions;
DROP POLICY IF EXISTS article_reactions_update_owner ON article_reactions;
DROP POLICY IF EXISTS article_reactions_delete_owner ON article_reactions;

-- Recreate policies with explicit checks

-- Anyone can view reactions (for counts and display)
CREATE POLICY article_reactions_select_public
  ON article_reactions
  FOR SELECT
  USING (true);

-- Authenticated users can insert reactions for themselves
-- Allow both direct match and explicit column check
CREATE POLICY article_reactions_insert_authenticated
  ON article_reactions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL 
    AND user_id = auth.uid()
  );

-- Users can update their own reactions
CREATE POLICY article_reactions_update_owner
  ON article_reactions
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() IS NOT NULL 
    AND user_id = auth.uid()
  )
  WITH CHECK (
    auth.uid() IS NOT NULL 
    AND user_id = auth.uid()
  );

-- Users can delete their own reactions
CREATE POLICY article_reactions_delete_owner
  ON article_reactions
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() IS NOT NULL 
    AND user_id = auth.uid()
  );

-- Verify the RPC function has proper permissions
GRANT EXECUTE ON FUNCTION get_article_reaction_counts(uuid) TO anon, authenticated;

-- Add helpful comment
COMMENT ON TABLE article_reactions IS 
  'User reactions (like/dislike) on articles. Each user can have one reaction per article.';
