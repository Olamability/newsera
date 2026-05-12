import { supabasePublic } from './supabase';
import { NewsArticle, Category } from '../types';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;
const RECOMMENDATION_CANDIDATE_MULTIPLIER = 3;
const RECOMMENDATION_TRENDING_FETCH_MULTIPLIER = 6;
const HEADLINES_LIMIT = 8;
type TrendingClickRow = { article_id?: string | null };
type ErrorLike = { code?: string; message?: string };

const ARTICLE_SELECT = '*, sources(id, name, website_url, logo_url), categories(id, name, slug)';
const loggedErrors = new Set<string>();
const MAX_LOGGED_ERRORS = 200;

function logPublicErrorOnce(scope: string, error: unknown): void {
  const e = (error ?? {}) as ErrorLike;
  const key = `${scope}:${e.code ?? 'unknown'}:${e.message ?? String(error)}`;
  if (loggedErrors.has(key)) return;
  if (loggedErrors.size >= MAX_LOGGED_ERRORS) {
    const oldest = loggedErrors.values().next().value;
    if (oldest) loggedErrors.delete(oldest);
  }
  loggedErrors.add(key);
  console.warn(`[PublicData] ${scope} failed:`, e.message ?? error);
}

export const CATEGORY_ALL = 'all';
export const CATEGORY_FOR_YOU = 'foryou';
export const CATEGORY_TRENDING = 'trending';

export async function fetchArticlesPublic(
  page: number,
  categoryId?: string | null
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const from = (page - 1) * PAGE_SIZE;
  const to = page * PAGE_SIZE - 1;

  let query = supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }

  const { data, error } = await query;
  if (error) {
    logPublicErrorOnce('fetchArticlesPublic', error);
    throw error;
  }

  const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
  const hasMore = articles.length >= PAGE_SIZE;
  return { articles, hasMore };
}

const VIRTUAL_CATEGORIES: Category[] = [
  { id: CATEGORY_FOR_YOU, name: 'For You ✨' },
  { id: CATEGORY_TRENDING, name: 'Trending 🔥' },
];

export async function fetchCategoriesPublic(): Promise<Category[]> {
  try {
    const { data, error } = await supabasePublic
      .from('categories')
      .select('*')
      .order('name');

    if (error) {
      logPublicErrorOnce('fetchCategoriesPublic', error);
      return VIRTUAL_CATEGORIES;
    }

    return [...VIRTUAL_CATEGORIES, ...(data ?? [])];
  } catch (error) {
    logPublicErrorOnce('fetchCategoriesPublic', error);
    return VIRTUAL_CATEGORIES;
  }
}

export async function fetchHeadlinesPublic(): Promise<NewsArticle[]> {
  const { articles } = await fetchArticlesPublic(1, null);
  const withImages = articles.filter((a) => a.image_url);
  const withoutImages = articles.filter((a) => !a.image_url);
  return [...withImages, ...withoutImages].slice(0, HEADLINES_LIMIT);
}

export async function fetchTrendingArticlesPublic(
  page: number = 1,
  limit: number = TRENDING_LIMIT
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const from = (page - 1) * limit;
  const to = page * limit - 1;

  const { data, error } = await supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (error) {
    logPublicErrorOnce('fetchTrendingArticlesPublic', error);
    throw error;
  }

  const rawCount = (data ?? []).length;
  const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
  const hasMore = rawCount >= limit;
  return { articles, hasMore };
}

const SIMILAR_PAGE_SIZE = 10;

export async function fetchSimilarArticlesPagePublic(
  articleId: string,
  categoryId: string | null,
  sourceId: string | null,
  page: number,
  pageSize: number = SIMILAR_PAGE_SIZE,
  excludeIds: string[] = [],
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const allExcluded = Array.from(new Set([articleId, ...excludeIds]));
  const seenIds = new Set<string>(allExcluded);
  const collected: NewsArticle[] = [];

  if (categoryId && collected.length < pageSize) {
    const needed = pageSize - collected.length;
    let query = supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('category_id', categoryId)
      .order('published_at', { ascending: false })
      .limit(needed * 2);
    const { data, error } = await query;

    if (error) logPublicErrorOnce('fetchSimilarArticlesPagePublic:category', error);
    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= pageSize) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  if (sourceId && collected.length < pageSize) {
    const needed = pageSize - collected.length;
    let query = supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('source_id', sourceId)
      .order('published_at', { ascending: false })
      .limit(needed * 2);
    const { data, error } = await query;

    if (error) logPublicErrorOnce('fetchSimilarArticlesPagePublic:source', error);
    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= pageSize) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  if (collected.length < pageSize) {
    const needed = pageSize - collected.length;
    let query = supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .order('published_at', { ascending: false })
      .limit(needed * 3);
    const { data, error } = await query;

    if (error) logPublicErrorOnce('fetchSimilarArticlesPagePublic:fallback', error);
    for (const row of (data ?? []) as ArticleRow[]) {
      if (collected.length >= pageSize) break;
      const mapped = mapArticle(row);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  }

  return { articles: collected, hasMore: collected.length >= pageSize };
}

export async function fetchSimilarArticlesPublic(
  articleId: string,
  categoryId: string | null,
  sourceId: string | null,
  limit: number = 5
): Promise<NewsArticle[]> {
  const collected: NewsArticle[] = [];
  const seenIds = new Set<string>([articleId]);

  if (categoryId && collected.length < limit) {
    const { data, error } = await supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('category_id', categoryId)
      .neq('id', articleId)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) {
      logPublicErrorOnce('fetchSimilarArticlesPublic:category', error);
    } else {
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

  if (sourceId && collected.length < limit) {
    const needed = limit - collected.length;
    const { data, error } = await supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .eq('source_id', sourceId)
      .neq('id', articleId)
      .order('published_at', { ascending: false })
      .limit(needed * 2);

    if (error) {
      logPublicErrorOnce('fetchSimilarArticlesPublic:source', error);
    } else {
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

  if (collected.length < limit) {
    const needed = limit - collected.length;
    const { data: trendingRows, error: trendingError } = await supabasePublic
      .from('article_click_counts')
      .select('article_id')
      .order('click_count', { ascending: false })
      .limit(needed * RECOMMENDATION_TRENDING_FETCH_MULTIPLIER);

    if (trendingError) {
      logPublicErrorOnce('fetchSimilarArticlesPublic:trendingPool', trendingError);
    }

    const trendingIds = (trendingRows ?? [])
      .map((row: TrendingClickRow) => row.article_id)
      .filter((id): id is string => !!id && !seenIds.has(id))
      .slice(0, needed * RECOMMENDATION_CANDIDATE_MULTIPLIER);

    if (trendingIds.length > 0) {
      const { data, error } = await supabasePublic
        .from('articles')
        .select(ARTICLE_SELECT)
        .in('id', trendingIds)
        .order('published_at', { ascending: false });

      if (error) {
        logPublicErrorOnce('fetchSimilarArticlesPublic:trendingArticles', error);
      } else {
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

    if (collected.length < limit) {
      const { data, error } = await supabasePublic
        .from('articles')
        .select(ARTICLE_SELECT)
        .neq('id', articleId)
        .order('published_at', { ascending: false })
        .limit(needed * RECOMMENDATION_CANDIDATE_MULTIPLIER);

      if (error) {
        logPublicErrorOnce('fetchSimilarArticlesPublic:latestFallback', error);
      } else {
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
  }

  return collected;
}

export async function fetchPersonalizedArticlesPublic(
  page: number = 1,
  limit: number = PERSONALIZED_DISPLAY_COUNT
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  try {
    const from = (page - 1) * limit;
    const to = page * limit - 1;

    const { data, error } = await supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .order('published_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    const rawCount = (data ?? []).length;
    const articles = ((data as ArticleRow[]) ?? []).map(mapArticle);
    const hasMore = rawCount >= limit;
    return { articles, hasMore };
  } catch (error) {
    logPublicErrorOnce('fetchPersonalizedArticlesPublic', error);
    return { articles: [], hasMore: false };
  }
}

export {
  fetchArticlesPublic as fetchArticles,
  fetchCategoriesPublic as fetchCategories,
  fetchTrendingArticlesPublic as fetchTrendingArticles,
  fetchPersonalizedArticlesPublic as fetchPersonalizedArticles,
  fetchSimilarArticlesPagePublic as fetchSimilarArticlesPage,
  fetchSimilarArticlesPublic as fetchSimilarArticles,
};
