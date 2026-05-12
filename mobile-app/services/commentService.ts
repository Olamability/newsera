import { supabaseAuth } from './supabase';
import { InteractionAuthRequiredError, isAuthRequiredInteractionError } from './interactionErrors';

export interface ArticleComment {
  id: string;
  article_id: string;
  user_id: string;
  content: string;
  parent_id: string | null;
  created_at: string;
}

/**
 * Fetch all flat comments for an article, ordered oldest-first.
 */
export async function fetchComments(articleId: string): Promise<ArticleComment[]> {
  const { data, error } = await supabaseAuth
    .from('article_comments')
    .select('id, article_id, user_id, content, parent_id, created_at')
    .eq('article_id', articleId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Add a new comment on an article.
 */
export async function addComment(
  articleId: string,
  content: string,
  parentId: string | null = null,
): Promise<void> {
  const {
    data: { user },
    error: userError,
  } = await supabaseAuth.auth.getUser();

  if (userError || !user) {
    throw new InteractionAuthRequiredError();
  }

  const { error } = await supabaseAuth
    .from('article_comments')
    .insert({
      article_id: articleId,
      user_id: user.id,
      content,
      parent_id: parentId,
    });

  if (error) {
    if (isAuthRequiredInteractionError(error)) {
      throw new InteractionAuthRequiredError();
    }
    throw error;
  }
}
