import { supabaseAuth } from './supabase';
import { InteractionAuthRequiredError, isAuthRequiredInteractionError } from './interactionErrors';

export interface ArticleComment {
  id: string;
  article_id: string;
  user_id: string;
  content: string;
  parent_id: string | null;
  likes_count?: number;
  created_at: string;
}

export const COMMENTS_PAGE_SIZE = 20;

export type CommentPageResult = {
  comments: ArticleComment[];
  hasMore: boolean;
};

/**
 * Fetch a paginated set of comments for an article, ordered oldest-first.
 */
export async function fetchCommentsPage(
  articleId: string,
  offset: number = 0,
  limit: number = COMMENTS_PAGE_SIZE,
): Promise<CommentPageResult> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const safeOffset = Math.max(0, offset);

  const { data, error } = await supabaseAuth
    .from('article_comments')
    .select('id, article_id, user_id, content, parent_id, likes_count, created_at')
    .eq('article_id', articleId)
    .order('created_at', { ascending: true })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (error) throw error;
  const comments = data ?? [];
  return { comments, hasMore: comments.length === safeLimit };
}

/**
 * Add a new comment on an article.
 */
export async function addComment(
  articleId: string,
  content: string,
  parentId: string | null = null,
  createdAt: string = new Date().toISOString(),
): Promise<ArticleComment> {
  if (!content || !content.trim()) {
    throw new Error('Comment content is required.');
  }

  const trimmedContent = content.trim();

  if (!articleId) {
    console.log('[Comments] Invalid insert payload input:', {
      article_id: articleId,
      content: trimmedContent,
      parent_id: parentId,
      created_at: createdAt,
    });
    throw new Error('Comment requires valid article ID and content.');
  }

  const {
    data: { session },
    error: sessionError,
  } = await supabaseAuth.auth.getSession();
  const sessionUserId = session?.user?.id ?? null;
  const authRole =
    session?.user?.role ??
    (session?.user?.app_metadata && typeof session.user.app_metadata.role === 'string'
      ? session.user.app_metadata.role
      : null);

  console.log('[Comments] Session before insert:', {
    session,
    sessionUserId,
    hasAccessToken: !!session?.access_token,
    authRole,
    sessionError,
  });

  if (sessionError || !session?.user) {
    console.log('[Comments] Missing auth session before insert:', {
      sessionError,
      hasSession: !!session,
      hasUser: !!session?.user,
      hasAccessToken: !!session?.access_token,
    });
    throw new InteractionAuthRequiredError();
  }

  const payload = {
    article_id: articleId,
    user_id: session.user.id,
    content: trimmedContent,
    parent_id: parentId,
    created_at: createdAt,
  };

  console.log('[Comments] Insert payload:', {
    payload,
    authRole,
    sessionUserId,
    hasAccessToken: !!session.access_token,
  });

  const { data, error } = await supabaseAuth
    .from('article_comments')
    .insert(payload)
    .select('id, article_id, user_id, content, parent_id, likes_count, created_at')
    .single();

  console.log('[Comments] Supabase insert response:', {
    data,
    error,
    authRole,
    sessionUserId,
    hasAccessToken: !!session.access_token,
  });

  if (error) {
    console.log('[Comments] Supabase insert error message:', error.message);
    if (isAuthRequiredInteractionError(error)) {
      throw new InteractionAuthRequiredError();
    }
    throw error;
  }

  if (!data) {
    throw new Error('Comment insert did not return a row.');
  }

  return data;
}
