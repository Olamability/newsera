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
  const trimmedContent = content.trim();
  const {
    data: { session },
    error: sessionError,
  } = await supabaseAuth.auth.getSession();
  const {
    data: { user },
    error: userError,
  } = await supabaseAuth.auth.getUser();

  if (sessionError) {
    console.log('[Comments] Failed to fetch session before insert:', sessionError);
    throw new InteractionAuthRequiredError();
  }

  console.log('[Comments] Pre-insert auth context:', {
    user,
    session,
    article_id: articleId,
    commentText: trimmedContent,
    parent_id: parentId,
  });

  if (!session || userError || !user || !user.id) {
    throw new InteractionAuthRequiredError();
  }

  const payload = {
    article_id: articleId,
    user_id: user.id,
    content: trimmedContent,
    parent_id: parentId,
    created_at: new Date().toISOString(),
  };

  console.log('[Comments] Insert payload:', payload);

  const { data, error } = await supabaseAuth
    .from('article_comments')
    .insert(payload)
    .select('id, article_id, user_id, content, parent_id, created_at');

  console.log('[Comments] Supabase insert response:', { data, error });

  if (error) {
    console.log('[Comments] Supabase insert error message:', error.message);
    if (isAuthRequiredInteractionError(error)) {
      throw new InteractionAuthRequiredError();
    }
    throw error;
  }
}
