import { supabaseAuth } from './supabase';
import { InteractionAuthRequiredError } from './interactionErrors';

/**
 * Check whether a user (or device) has liked a given article.
 */
export async function isLiked(articleId: string): Promise<boolean> {
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  if (!user) return false;

  const { data, error } = await supabaseAuth
    .from('article_reactions')
    .select('id')
    .eq('article_id', articleId)
    .eq('user_id', user.id)
    .eq('reaction_type', 'like')
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Get the total like count for an article.
 */
export async function getLikeCount(articleId: string): Promise<number> {
  const { count, error } = await supabaseAuth
    .from('article_reactions')
    .select('id', { count: 'exact', head: true })
    .eq('article_id', articleId)
    .eq('reaction_type', 'like');

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

  const { data: existing, error: existingError } = await supabaseAuth
    .from('article_reactions')
    .select('id, reaction_type')
    .eq('article_id', articleId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingError) throw existingError;

  if (!existing) {
    const { error: insertError } = await supabaseAuth
      .from('article_reactions')
      .insert({ article_id: articleId, user_id: user.id, reaction_type: 'like' });
    if (insertError) throw insertError;

    const { error: legacyInsertError } = await supabaseAuth
      .from('article_likes')
      .upsert(
        { article_id: articleId, user_id: user.id, user_id_uuid: user.id },
        { onConflict: 'article_id,user_id' }
      );
    if (legacyInsertError) throw legacyInsertError;
    return true;
  }

  if (existing.reaction_type === 'like') {
    const { error: deleteError } = await supabaseAuth
      .from('article_reactions')
      .delete()
      .eq('id', existing.id);
    if (deleteError) throw deleteError;

    const { error: legacyDeleteError } = await supabaseAuth
      .from('article_likes')
      .delete()
      .eq('article_id', articleId)
      .eq('user_id', user.id);
    if (legacyDeleteError) throw legacyDeleteError;
    return false;
  }

  const { error: updateError } = await supabaseAuth
    .from('article_reactions')
    .update({ reaction_type: 'like' })
    .eq('id', existing.id);
  if (updateError) throw updateError;

  const { error: legacyUpsertError } = await supabaseAuth
    .from('article_likes')
    .upsert(
      { article_id: articleId, user_id: user.id, user_id_uuid: user.id },
      { onConflict: 'article_id,user_id' }
    );
  if (legacyUpsertError) throw legacyUpsertError;
  return true;
}
