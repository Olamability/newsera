import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';
import { getDeviceId } from './deviceId';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;
const RECOMMENDATION_CANDIDATE_MULTIPLIER = 3;
const RECOMMENDATION_TRENDING_FETCH_MULTIPLIER = 6;
type TrendingClickRow = { article_id?: string | null };

const ARTICLE_SELECT = '*, sources(id, name, website_url, logo_url), categories(id, name, slug)';

export const CATEGORY_ALL = 'all';
export const CATEGORY_FOR_YOU = 'foryou';
export const CATEGORY_TRENDING = 'trending';

/**
 * ARTICLES FETCH
 * Fetches a page of articles with consistent PAGE_SIZE pagination.
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

  const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
  const hasMore = articles.length >= PAGE_SIZE;

  console.log(`📄 fetchArticles — page: ${page}, returned: ${articles.length}, hasMore: ${hasMore}`);

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
    const { data: trendingRows } = await supabase
      .from('article_click_counts')
      .select('article_id')
      .order('click_count', { ascending: false })
      // Pull a wider pool before de-duplication against current recommendations.
      .limit(needed * RECOMMENDATION_TRENDING_FETCH_MULTIPLIER);

    const trendingIds = (trendingRows ?? [])
      .map((row: TrendingClickRow) => row.article_id)
      .filter((id): id is string => !!id && !seenIds.has(id))
      .slice(0, needed * RECOMMENDATION_CANDIDATE_MULTIPLIER);

    if (trendingIds.length > 0) {
      const { data } = await supabase
        .from('articles')
        .select(ARTICLE_SELECT)
        .in('id', trendingIds)
        .order('published_at', { ascending: false });

      for (const row of (data ?? []) as ArticleRow[]) {
        if (collected.length >= limit) break;
        const mapped = mapArticle(row);
        if (!seenIds.has(mapped.id)) {
          seenIds.add(mapped.id);
          collected.push(mapped);
        }
      }
    }

    // Final fallback: latest articles if trending signal is unavailable.
    if (collected.length < limit) {
      const { data } = await supabase
        .from('articles')
        .select(ARTICLE_SELECT)
        .neq('id', articleId)
        .order('published_at', { ascending: false })
        .limit(needed * RECOMMENDATION_CANDIDATE_MULTIPLIER);

      for (const row of (data ?? []) as ArticleRow[]) {
        if (collected.length >= limit) break;
        const mapped = mapArticle(row);
        if (!seenIds.has(mapped.id)) {
          seenIds.add(mapped.id);
          collected.push(mapped);
        }
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
