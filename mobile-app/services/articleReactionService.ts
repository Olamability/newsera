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
const isMissingRpcFunctionError = (error: { code?: string } | null | undefined): boolean => (
  error?.code === '42883'
);
type ReactionCountRpcRow = {
  reaction_type: ArticleReactionType;
  reaction_count: number | string;
};

export async function getArticleReactionSummary(articleId: string): Promise<ArticleReactionSummary> {
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  const [countsResult, userReactionResult] = await Promise.all([
    supabaseAuth.rpc('get_article_reaction_counts', { p_article_id: articleId }),
    user
      ? supabaseAuth
          .from('article_reactions')
          .select('reaction_type')
          .eq('article_id', articleId)
          .eq('user_id', user.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),
  ]);

  const { data, error } = countsResult;

  if (error) {
    if (isMissingReactionsTableError(error) || isMissingRpcFunctionError(error)) {
      const likeCount = await getLikeCount(articleId);
      const userReaction = user ? ((await isLiked(articleId)) ? 'like' : null) : null;
      return { likeCount, dislikeCount: 0, userReaction };
    }
    throw error;
  }

  const rows = (data ?? []) as ReactionCountRpcRow[];
  const counts = rows.reduce(
    (acc, row) => {
      const countValue = Number(row.reaction_count ?? 0);
      if (row.reaction_type === 'like') acc.likeCount += countValue;
      if (row.reaction_type === 'dislike') acc.dislikeCount += countValue;
      return acc;
    },
    { likeCount: 0, dislikeCount: 0 }
  );
  const { likeCount, dislikeCount } = counts;
  if (userReactionResult.error && !isMissingReactionsTableError(userReactionResult.error)) {
    throw userReactionResult.error;
  }
  const userReaction = (userReactionResult.data?.reaction_type as ArticleReactionType | undefined) ?? null;

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
