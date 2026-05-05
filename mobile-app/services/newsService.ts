import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';
import { getDeviceId } from './deviceId';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const MAX_PER_SOURCE = 2;
// Fetch a larger pool so that after balancing we still have PAGE_SIZE articles
const FETCH_MULTIPLIER = 4;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;

const ARTICLE_SELECT = '*, sources(id, name, website_url, logo_url), categories(id, name, slug)';

export const CATEGORY_ALL = 'all';
export const CATEGORY_FOR_YOU = 'foryou';
export const CATEGORY_TRENDING = 'trending';

/**
 * Balance articles so no single source dominates.
 * Groups by source_id, takes at most MAX_PER_SOURCE per source,
 * then re-sorts by published_at DESC and returns up to PAGE_SIZE items.
 */
function balanceBySource(articles: NewsArticle[]): NewsArticle[] {
  const countBySource: Record<string, number> = {};
  const balanced: NewsArticle[] = [];

  for (const article of articles) {
    const key = article.source_id ?? '__unknown__';
    const count = countBySource[key] ?? 0;
    if (count < MAX_PER_SOURCE) {
      balanced.push(article);
      countBySource[key] = count + 1;
    }
  }

  balanced.sort((a, b) => {
    const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
    const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
    return tb - ta;
  });

  return balanced.slice(0, PAGE_SIZE);
}

/**
 * SAFE ARTICLES FETCH (NO FRAGILE JOINS)
 * For the "all" feed (no categoryId) a larger pool is fetched so that
 * source-balancing still yields PAGE_SIZE results.
 *
 * @param page 1-indexed page number
 * @param categoryId optional category filter
 * @returns articles for the page and a hasMore flag
 */
export async function fetchArticles(
  page: number,
  categoryId?: string | null
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  // For the balanced feed each "page" consumes a pool of poolSize raw DB rows.
  // Articles beyond the first MAX_PER_SOURCE per source within that pool are
  // intentionally skipped to ensure source diversity — this is not a data gap.
  const poolSize = categoryId ? PAGE_SIZE : PAGE_SIZE * FETCH_MULTIPLIER;
  const from = (page - 1) * poolSize;
  const to = page * poolSize - 1;

  let query = supabase
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }

  const { data, error } = await query;

  if (error) {
    console.log('❌ fetchArticles ERROR:', error);
    throw error;
  }

  const rawCount = (data ?? []).length;
  const mapped = ((data as ArticleRow[]) ?? []).map(mapArticle);

  // Apply source-balancing only for the general feed
  const articles = categoryId ? mapped : balanceBySource(mapped);

  // hasMore is based on whether the DB returned a full pool.
  // If it returned fewer rows than requested, we've reached the end.
  const hasMore = rawCount >= poolSize;

  console.log(`📄 fetchArticles — page: ${page}, raw rows: ${rawCount}, returned: ${articles.length}, hasMore: ${hasMore}`);

  return { articles, hasMore };
}

const VIRTUAL_CATEGORIES: Category[] = [
  { id: CATEGORY_FOR_YOU, name: 'For You ✨' },
  { id: CATEGORY_TRENDING, name: 'Trending 🔥' },
];

/**
 * CATEGORIES
 */
export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name');

  console.log('📦 categories:', data);
  console.log('❌ categories error:', error);

  if (error) throw error;

  return [...VIRTUAL_CATEGORIES, ...(data ?? [])];
}

/**
 * TRENDING — paginated
 */
export async function fetchTrendingArticles(
  page: number = 1,
  limit: number = TRENDING_LIMIT
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const from = (page - 1) * limit;
  const to = page * limit - 1;

  const { data, error } = await supabase
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (error) {
    console.log('❌ fetchTrendingArticles ERROR:', error);
    throw error;
  }

  const rawCount = (data ?? []).length;
  const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
  const hasMore = rawCount >= limit;

  console.log(`🔥 Trending — page: ${page}, items: ${rawCount}, hasMore: ${hasMore}`);

  return { articles, hasMore };
}

/**
 * PERSONALIZED — paginated, safe fallback
 */
export async function fetchPersonalizedArticles(
  page: number = 1,
  limit: number = PERSONALIZED_DISPLAY_COUNT
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  try {
    const from = (page - 1) * limit;
    const to = page * limit - 1;

    const { data, error } = await supabase
      .from('articles')
      .select(ARTICLE_SELECT)
      .order('published_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    const rawCount = (data ?? []).length;
    const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
    const hasMore = rawCount >= limit;

    console.log(`✨ For You — page: ${page}, items: ${rawCount}, hasMore: ${hasMore}`);

    return { articles, hasMore };
  } catch (err) {
    console.warn('Personalized fetch failed:', err);
    return { articles: [], hasMore: false };
  }
}