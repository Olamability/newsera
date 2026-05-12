import { supabaseAuth } from './supabase';
import { InteractionAuthRequiredError, isAuthRequiredInteractionError } from './interactionErrors';

/**
 * Check whether a user (or device) has liked a given article.
 */
export async function isLiked(articleId: string): Promise<boolean> {
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  if (!user) return false;

  const { data, error } = await supabaseAuth
    .from('article_likes')
    .select('id')
    .eq('article_id', articleId)
    .eq('user_id', user.id)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Get the total like count for an article.
 */
export async function getLikeCount(articleId: string): Promise<number> {
  const { count, error } = await supabaseAuth
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
export async function toggleLike(articleId: string): Promise<boolean> {
  const {
    data: { user },
    error: userError,
  } = await supabaseAuth.auth.getUser();

  if (userError || !user) {
    throw new InteractionAuthRequiredError();
  }

  // Attempt to insert first; if the unique constraint fires, the user already
  // liked the article → remove the like instead.
  const { error: insertError } = await supabaseAuth
    .from('article_likes')
    .insert({ article_id: articleId, user_id: user.id });

  if (!insertError) {
    return true; // Like added
  }

  // Postgres unique-constraint violation code
  if (insertError.code === '23505') {
    const { error: deleteError } = await supabaseAuth
      .from('article_likes')
      .delete()
      .eq('article_id', articleId)
      .eq('user_id', user.id);
    if (deleteError) throw deleteError;
    return false; // Like removed
  }

  // Session can expire between getUser() and write attempts, so keep this
  // guard to return a stable auth-required error for the UI layer.
  if (isAuthRequiredInteractionError(insertError)) {
    throw new InteractionAuthRequiredError();
  }

  throw insertError;
}
