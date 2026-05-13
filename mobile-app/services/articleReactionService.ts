import { supabaseAuth } from './supabase';
import { InteractionAuthRequiredError } from './interactionErrors';
import { getLikeCount, isLiked, toggleLike } from './likeService';

export type ArticleReactionType = 'like' | 'dislike';

export type ArticleReactionSummary = {
  likeCount: number;
  dislikeCount: number;
  userReaction: ArticleReactionType | null;
};

const isMissingReactionsTableError = (error: { code?: string } | null | undefined): boolean => (
  error?.code === '42P01'
);

export async function getArticleReactionSummary(articleId: string): Promise<ArticleReactionSummary> {
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  const { data, error } = await supabaseAuth
    .from('article_reactions')
    .select('reaction_type, user_id')
    .eq('article_id', articleId);

  if (error) {
    if (isMissingReactionsTableError(error)) {
      const likeCount = await getLikeCount(articleId);
      const userReaction = user ? ((await isLiked(articleId)) ? 'like' : null) : null;
      return { likeCount, dislikeCount: 0, userReaction };
    }
    throw error;
  }

  const rows = data ?? [];
  let likeCount = 0;
  let dislikeCount = 0;
  let userReaction: ArticleReactionType | null = null;

  for (const row of rows) {
    if (row.reaction_type === 'like') {
      likeCount += 1;
    } else if (row.reaction_type === 'dislike') {
      dislikeCount += 1;
    }

    if (user?.id && row.user_id === user.id) {
      userReaction = row.reaction_type;
    }
  }

  return { likeCount, dislikeCount, userReaction };
}

export async function toggleArticleReaction(
  articleId: string,
  reaction: ArticleReactionType,
): Promise<ArticleReactionType | null> {
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

  if (existingError) {
    if (isMissingReactionsTableError(existingError)) {
      if (reaction === 'like') {
        const liked = await toggleLike(articleId);
        return liked ? 'like' : null;
      }
      return null;
    }
    throw existingError;
  }

  if (!existing) {
    const { error: insertError } = await supabaseAuth
      .from('article_reactions')
      .insert({ article_id: articleId, user_id: user.id, reaction_type: reaction });
    if (insertError) throw insertError;
    return reaction;
  }

  if (existing.reaction_type === reaction) {
    const { error: deleteError } = await supabaseAuth
      .from('article_reactions')
      .delete()
      .eq('id', existing.id);
    if (deleteError) throw deleteError;
    return null;
  }

  const { error: updateError } = await supabaseAuth
    .from('article_reactions')
    .update({ reaction_type: reaction })
    .eq('id', existing.id);
  if (updateError) throw updateError;
  return reaction;
}
