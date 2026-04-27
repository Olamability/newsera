import { supabase } from './supabase';
import { NewsArticle } from '../types';

/**
 * Check whether the authenticated user has bookmarked a given article.
 * Returns false (not bookmarked) when called for an unauthenticated user.
 */
export async function isBookmarked(articleId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('bookmarks')
    .select('id')
    .eq('user_id', userId)
    .eq('article_id', articleId)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Add a bookmark for the authenticated user.
 */
export async function addBookmark(articleId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('bookmarks')
    .insert({ user_id: userId, article_id: articleId });
  if (error) throw error;
}

/**
 * Remove a bookmark for the authenticated user.
 */
export async function removeBookmark(articleId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('user_id', userId)
    .eq('article_id', articleId);
  if (error) throw error;
}

/**
 * Toggle a bookmark — adds it if absent, removes it if present.
 * Returns the new bookmarked state.
 */
export async function toggleBookmark(articleId: string, userId: string): Promise<boolean> {
  const bookmarked = await isBookmarked(articleId, userId);
  if (bookmarked) {
    await removeBookmark(articleId, userId);
    return false;
  } else {
    await addBookmark(articleId, userId);
    return true;
  }
}

/**
 * Fetch all bookmarked articles for the authenticated user,
 * joined with the articles table for full article data.
 */
export async function fetchBookmarkedArticles(userId: string): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from('bookmarks')
    .select(
      `article_id,
       articles (
         id, title, snippet, image_url, published_at, url, source_id, category_id,
         sources ( id, name, website_url, logo_url ),
         categories ( id, name, slug )
       )`
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Unwrap the nested articles relation
  return ((data ?? []) as unknown as Array<{ articles: NewsArticle }>)
    .map((row) => row.articles)
    .filter(Boolean);
}
