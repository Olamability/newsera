import { supabase } from './supabase';

/**
 * Check whether a user (or device) has liked a given article.
 */
export async function isLiked(articleId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('article_likes')
    .select('id')
    .eq('article_id', articleId)
    .eq('user_id', userId)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Get the total like count for an article.
 */
export async function getLikeCount(articleId: string): Promise<number> {
  const { count, error } = await supabase
    .from('article_likes')
    .select('id', { count: 'exact', head: true })
    .eq('article_id', articleId);

  if (error) throw error;
  return count ?? 0;
}

/**
 * Toggle a like — inserts if absent, removes if present.
 * Uses insert-first to avoid a race condition window between check and write.
 * Returns the new liked state.
 */
export async function toggleLike(articleId: string, userId: string): Promise<boolean> {
  // Attempt to insert first; if the unique constraint fires, the user already
  // liked the article → remove the like instead.
  const { error: insertError } = await supabase
    .from('article_likes')
    .insert({ article_id: articleId, user_id: userId });

  if (!insertError) {
    return true; // Like added
  }

  // Postgres unique-constraint violation code
  if (insertError.code === '23505') {
    const { error: deleteError } = await supabase
      .from('article_likes')
      .delete()
      .eq('article_id', articleId)
      .eq('user_id', userId);
    if (deleteError) throw deleteError;
    return false; // Like removed
  }

  throw insertError;
}
