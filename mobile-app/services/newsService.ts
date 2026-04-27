import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;

export async function fetchArticles(
  page: number,
  categoryId?: string | null
): Promise<NewsArticle[]> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from('articles')
    .select(
      `id, title, snippet, image_url, published_at, url, source_id, category_id,
       sources ( id, name, website_url, logo_url ),
       categories ( id, name, slug )`
    )
    .order('published_at', { ascending: false })
    .range(from, to);

  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data as unknown as NewsArticle[]) ?? [];
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, slug')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

/**
 * Returns the top trending articles ranked by total click count (desc),
 * then by published_at (desc) as a tiebreaker.
 * Uses the article_click_counts view for database-level aggregation.
 */
export async function fetchTrendingArticles(): Promise<NewsArticle[]> {
  // Fetch aggregated click counts from the DB view (sorted, limited)
  const { data: countData, error: countError } = await supabase
    .from('article_click_counts')
    .select('article_id, click_count')
    .order('click_count', { ascending: false })
    .limit(TRENDING_LIMIT);

  if (countError) throw countError;

  const topIds = (countData ?? []).map((row: { article_id: string }) => row.article_id);

  if (topIds.length === 0) {
    // No clicks yet — fall back to most recent articles
    const { data, error } = await supabase
      .from('articles')
      .select(
        `id, title, snippet, image_url, published_at, url, source_id, category_id,
         sources ( id, name, website_url, logo_url ),
         categories ( id, name, slug )`
      )
      .order('published_at', { ascending: false })
      .limit(TRENDING_LIMIT);
    if (error) throw error;
    return (data as unknown as NewsArticle[]) ?? [];
  }

  // Fetch full article records for the top-clicked IDs
  const { data, error } = await supabase
    .from('articles')
    .select(
      `id, title, snippet, image_url, published_at, url, source_id, category_id,
       sources ( id, name, website_url, logo_url ),
       categories ( id, name, slug )`
    )
    .in('id', topIds);

  if (error) throw error;

  const articles = (data as unknown as NewsArticle[]) ?? [];

  // Re-sort to respect click-count order returned by the view
  const rankMap: Record<string, number> = {};
  (countData ?? []).forEach((row: { article_id: string; click_count: number }, idx: number) => {
    rankMap[row.article_id] = idx;
  });

  articles.sort((a, b) => {
    const rankDiff = (rankMap[a.id] ?? Infinity) - (rankMap[b.id] ?? Infinity);
    if (rankDiff !== 0) return rankDiff;
    // tiebreaker: published_at desc (ISO strings compare correctly with >/<)
    if ((b.published_at ?? '') > (a.published_at ?? '')) return 1;
    if ((b.published_at ?? '') < (a.published_at ?? '')) return -1;
    return 0;
  });

  return articles;
}
