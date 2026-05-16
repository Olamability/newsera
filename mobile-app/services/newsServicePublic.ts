import { supabasePublic } from './supabase';
import { NewsArticle, Category } from '../types';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;
const RECOMMENDATION_CANDIDATE_MULTIPLIER = 3;
const RECOMMENDATION_TRENDING_FETCH_MULTIPLIER = 6;
const TRENDING_POOL_MULTIPLIER = 3;
const HEADLINES_LIMIT = 8;
const SIMILAR_PRIMARY_FETCH_MULTIPLIER = 2;
const SIMILAR_FALLBACK_FETCH_MULTIPLIER = 3;
type TrendingClickRow = { article_id?: string | null };
type ErrorLike = { code?: string; message?: string };
const ARTICLE_SELECT = '*, categories(id, name, slug)';
const loggedErrors = new Set<string>();
const MAX_LOGGED_ERRORS = 200;
const FEED_CACHE_TTL_MS = 90000;
const HEADLINES_CACHE_TTL_MS = 60000;

type FeedCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const feedCache = new Map<string, FeedCacheEntry<unknown>>();

const buildCacheKey = (name: string, parts: Record<string, string | number | null | undefined>): string => {
  const encoded = Object.entries(parts)
    .map(([key, value]) => `${key}=${value ?? 'null'}`)
    .join('|');
  return `${name}|${encoded}`;
};

const readFeedCache = <T>(key: string): T | null => {
  const hit = feedCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    feedCache.delete(key);
    return null;
  }
  return hit.value as T;
};

const writeFeedCache = <T>(key: string, value: T, ttlMs: number = FEED_CACHE_TTL_MS): T => {
  feedCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
};

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
  const cacheKey = buildCacheKey('articles', {
    category: categoryId ?? 'all',
    page,
    user: 'public',
  });
  const cached = readFeedCache<{ articles: NewsArticle[]; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

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
  return writeFeedCache(cacheKey, { articles, hasMore });
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
  const cacheKey = buildCacheKey('headlines', {
    limit: HEADLINES_LIMIT,
    user: 'public',
  });
  const cached = readFeedCache<NewsArticle[]>(cacheKey);
  if (cached) return cached;

  const { data, error } = await supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .not('image_url', 'is', null)
    .neq('image_url', '')
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(HEADLINES_LIMIT);

  if (error) {
    logPublicErrorOnce('fetchHeadlinesPublic', error);
    throw error;
  }

  const headlines = ((data as ArticleRow[]) ?? []).map(mapArticle).slice(0, HEADLINES_LIMIT);
  return writeFeedCache(cacheKey, headlines, HEADLINES_CACHE_TTL_MS);
}

export function invalidateHeadlinesPublicCache(): void {
  for (const key of feedCache.keys()) {
    if (key.startsWith('headlines|')) {
      feedCache.delete(key);
    }
  }
}

export function invalidatePublicFeedCaches(prefixes: string[] = ['articles', 'headlines', 'trending', 'personalized']): void {
  if (prefixes.length === 0) return;
  const targets = new Set(prefixes.map((prefix) => `${prefix}|`));
  for (const key of feedCache.keys()) {
    for (const target of targets) {
      if (key.startsWith(target)) {
        feedCache.delete(key);
        break;
      }
    }
  }
}

export async function fetchTrendingArticlesPublic(
  page: number = 1,
  limit: number = TRENDING_LIMIT
): Promise<{ articles: NewsArticle[]; hasMore: boolean }> {
  const cacheKey = buildCacheKey('trending', {
    page,
    limit,
    user: 'public',
  });
  const cached = readFeedCache<{ articles: NewsArticle[]; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

  const poolLimit = limit * TRENDING_POOL_MULTIPLIER;
  const from = (page - 1) * poolLimit;
  const to = page * poolLimit - 1;

  const { data: trendingPool, error: trendingError } = await supabasePublic
    .from('article_click_counts')
    .select('article_id')
    .order('click_count', { ascending: false })
    .range(from, to);

  if (trendingError) {
    logPublicErrorOnce('fetchTrendingArticlesPublic:pool', trendingError);
    throw trendingError;
  }

  const candidateIds = (trendingPool ?? [])
    .map((row: TrendingClickRow) => row.article_id)
    .filter((id): id is string => !!id);

  if (candidateIds.length === 0) {
    return writeFeedCache(cacheKey, { articles: [], hasMore: false });
  }

  const { data, error } = await supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .in('id', candidateIds);

  if (error) {
    logPublicErrorOnce('fetchTrendingArticlesPublic:articles', error);
    throw error;
  }

  const articleById = new Map(((data as ArticleRow[]) ?? []).map((row) => [row.id as string, mapArticle(row)]));
  const orderedArticles = candidateIds.map((id) => articleById.get(id)).filter((value): value is NewsArticle => !!value);
  const articles = orderedArticles.slice(0, limit);
  const hasMore = orderedArticles.length > limit || candidateIds.length >= poolLimit;
  return writeFeedCache(cacheKey, { articles, hasMore });
}

export async function fetchTrendingArticleByIdPublic(articleId: string): Promise<NewsArticle | null> {
  const { data, error } = await supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .eq('id', articleId)
    .maybeSingle();

  if (error) {
    logPublicErrorOnce('fetchTrendingArticleByIdPublic', error);
    return null;
  }

  if (!data) return null;
  return mapArticle(data as ArticleRow);
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

  const stageOffset = Math.max(0, page - 1) * pageSize;
  const fetchLimit = pageSize * SIMILAR_PRIMARY_FETCH_MULTIPLIER;
  const [categoryResult, sourceResult] = await Promise.all([
    categoryId
      ? supabasePublic
          .from('articles')
          .select(ARTICLE_SELECT)
          .eq('category_id', categoryId)
          .order('published_at', { ascending: false })
          .range(stageOffset, stageOffset + fetchLimit - 1)
      : Promise.resolve({ data: [], error: null } as const),
    sourceId
      ? supabasePublic
          .from('articles')
          .select(ARTICLE_SELECT)
          .eq('source_id', sourceId)
          .order('published_at', { ascending: false })
          .range(stageOffset, stageOffset + fetchLimit - 1)
      : Promise.resolve({ data: [], error: null } as const),
  ]);

  if (categoryResult.error) logPublicErrorOnce('fetchSimilarArticlesPagePublic:category', categoryResult.error);
  if (sourceResult.error) logPublicErrorOnce('fetchSimilarArticlesPagePublic:source', sourceResult.error);

  for (const row of (categoryResult.data ?? []) as ArticleRow[]) {
    if (collected.length >= pageSize) break;
    const mapped = mapArticle(row);
    if (!seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      collected.push(mapped);
    }
  }

  for (const row of (sourceResult.data ?? []) as ArticleRow[]) {
    if (collected.length >= pageSize) break;
    const mapped = mapArticle(row);
    if (!seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      collected.push(mapped);
    }
  }

  if (collected.length < pageSize) {
    const needed = pageSize - collected.length;
    const fetchLimit = needed * SIMILAR_FALLBACK_FETCH_MULTIPLIER;
    const stageOffset = Math.max(0, page - 1) * needed;
    let query = supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .order('published_at', { ascending: false })
      .range(stageOffset, stageOffset + fetchLimit - 1);
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

  const [categoryResult, sourceResult] = await Promise.all([
    categoryId
      ? supabasePublic
          .from('articles')
          .select(ARTICLE_SELECT)
          .eq('category_id', categoryId)
          .neq('id', articleId)
          .order('published_at', { ascending: false })
          .limit(limit)
      : Promise.resolve({ data: [], error: null } as const),
    sourceId
      ? supabasePublic
          .from('articles')
          .select(ARTICLE_SELECT)
          .eq('source_id', sourceId)
          .neq('id', articleId)
          .order('published_at', { ascending: false })
          .limit(limit * 2)
      : Promise.resolve({ data: [], error: null } as const),
  ]);

  if (categoryResult.error) {
    logPublicErrorOnce('fetchSimilarArticlesPublic:category', categoryResult.error);
  }
  if (sourceResult.error) {
    logPublicErrorOnce('fetchSimilarArticlesPublic:source', sourceResult.error);
  }

  for (const row of (categoryResult.data ?? []) as ArticleRow[]) {
    if (collected.length >= limit) break;
    const mapped = mapArticle(row);
    if (!seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      collected.push(mapped);
    }
  }

  for (const row of (sourceResult.data ?? []) as ArticleRow[]) {
    if (collected.length >= limit) break;
    const mapped = mapArticle(row);
    if (!seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      collected.push(mapped);
    }
  }

  if (collected.length < limit) {
    const needed = limit - collected.length;
    const [trendingPoolResult, latestFallbackResult] = await Promise.all([
      supabasePublic
        .from('article_click_counts')
        .select('article_id')
        .order('click_count', { ascending: false })
        .limit(needed * RECOMMENDATION_TRENDING_FETCH_MULTIPLIER),
      supabasePublic
        .from('articles')
        .select(ARTICLE_SELECT)
        .neq('id', articleId)
        .order('published_at', { ascending: false })
        .limit(needed * RECOMMENDATION_CANDIDATE_MULTIPLIER),
    ]);

    if (trendingPoolResult.error) {
      logPublicErrorOnce('fetchSimilarArticlesPublic:trendingPool', trendingPoolResult.error);
    }

    const trendingPoolRows = trendingPoolResult.data ?? [];
    const trendingIds = trendingPoolRows
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
      if (latestFallbackResult.error) {
        logPublicErrorOnce('fetchSimilarArticlesPublic:latestFallback', latestFallbackResult.error);
      } else {
        for (const row of (latestFallbackResult.data ?? []) as ArticleRow[]) {
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
  const cacheKey = buildCacheKey('personalized', {
    page,
    limit,
    user: 'public',
  });
  const cached = readFeedCache<{ articles: NewsArticle[]; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

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
    return writeFeedCache(cacheKey, { articles, hasMore });
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
  fetchTrendingArticleByIdPublic as fetchTrendingArticleById,
};
