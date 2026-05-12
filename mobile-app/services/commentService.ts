import { supabaseAuth } from './supabase';

export interface ArticleComment {
  id: string;
  article_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

/**
 * Fetch all flat comments for an article, ordered oldest-first.
 */
export async function fetchComments(articleId: string): Promise<ArticleComment[]> {
  const { data, error } = await supabaseAuth
    .from('article_comments')
    .select('id, article_id, user_id, content, created_at')
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
  userId: string,
  content: string
): Promise<void> {
  const { error } = await supabaseAuth
    .from('article_comments')
    .insert({ article_id: articleId, user_id: userId, content });

  if (error) throw error;
}
