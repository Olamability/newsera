import { supabaseAuth } from './supabase';

export interface ArticleComment {
  id: string;
  article_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

type SupabaseErrorLike = {
  code?: string;
  message?: string;
};

function isAuthRequiredError(error: unknown): boolean {
  const candidate = error as SupabaseErrorLike | null | undefined;
  const message = (candidate?.message ?? '').toLowerCase();
  return candidate?.code === '42501' || message.includes('row-level security');
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
  content: string
): Promise<void> {
  const {
    data: { user },
    error: userError,
  } = await supabaseAuth.auth.getUser();

  if (userError || !user) {
    throw new Error('AUTH_REQUIRED');
  }

  const { error } = await supabaseAuth
    .from('article_comments')
    .insert({
      article_id: articleId,
      user_id: user.id,
      content,
      created_at: new Date().toISOString(),
    });

  if (error) {
    if (isAuthRequiredError(error)) {
      throw new Error('AUTH_REQUIRED');
    }
    throw error;
  }
}
