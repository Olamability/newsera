import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';
import { getDeviceId } from './deviceId';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const MAX_PER_SOURCE = 2;
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
 * ARTICLES FETCH
 * Fetches a page of articles with consistent PAGE_SIZE pagination.
 * When no categoryId is provided (the "All" feed), source-balancing is applied
 * so no single source dominates the page.
 *
 * @param page 1-indexed page number
 * @param categoryId optional category filter
 * @returns articles for the page and a hasMore flag
 */
export async function fetchArticles(
  page: number,
  categoryId?: string | null
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const from = (page - 1) * PAGE_SIZE;
  const to = page * PAGE_SIZE - 1;

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
  const hasMore = rawCount >= PAGE_SIZE;

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
 * SIMILAR ARTICLES — for "Read More Like This" section.
 * Priority: same category → same source → latest trending fallback.
 *
 * @param articleId  The current article to exclude
 * @param categoryId Category of the current article (nullable)
 * @param sourceId   Source of the current article (nullable)
 * @param limit      Max recommendations to return (default 5)
 */
export async function fetchSimilarArticles(
  articleId: string,
  categoryId: string | null,
  sourceId: string | null,
  limit: number = 5
): Promise<NewsArticle[]> {
  const collected: NewsArticle[] = [];
  const seenIds = new Set<string>([articleId]);

  // 1. Same category
  if (categoryId && collected.length < limit) {
    const { data } = await supabase
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('category_id', categoryId)
      .neq('id', articleId)
      .order('published_at', { ascending: false })
      .limit(limit);

    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= limit) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  // 2. Same source
  if (sourceId && collected.length < limit) {
    const needed = limit - collected.length;
    const { data } = await supabase
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('source_id', sourceId)
      .neq('id', articleId)
      .order('published_at', { ascending: false })
      .limit(needed * 2);

    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= limit) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  // 3. Latest trending fallback
  if (collected.length < limit) {
    const needed = limit - collected.length;
    const { data } = await supabase
      .from('articles')
      .select(ARTICLE_SELECT)
      .neq('id', articleId)
      .order('published_at', { ascending: false })
      .limit(needed * 3);

    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= limit) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  return collected;
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