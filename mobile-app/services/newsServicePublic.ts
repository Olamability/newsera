import { supabasePublic } from './supabase';
import { NewsArticle, Category } from '../types';
import { ArticleRow, mapArticle } from './articleUtils';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;
const RECOMMENDATION_CANDIDATE_MULTIPLIER = 3;
const RECOMMENDATION_TRENDING_FETCH_MULTIPLIER = 6;
const HEADLINES_LIMIT = 8;
const SIMILAR_PRIMARY_FETCH_MULTIPLIER = 2;
const SIMILAR_FALLBACK_FETCH_MULTIPLIER = 3;
type TrendingClickRow = { article_id?: string | null };
type ErrorLike = { code?: string; message?: string };
type EngagementFeedRow = {
  id: string;
  title: string;
  content: string | null;
  snippet: string | null;
  source_id: string | null;
  image_url: string | null;
  published_at: string | null;
  url: string;
  category_id: string | null;
  source_name: string | null;
  source_website_url: string | null;
  source_logo_url: string | null;
  category_name: string | null;
  category_slug: string | null;
  likes_count: number | null;
  comments_count: number | null;
  replies_count: number | null;
  views_count: number | null;
  engagement_score: number | null;
};

const ARTICLE_SELECT = '*, sources(id, name, website_url, logo_url), categories(id, name, slug)';
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

function mapEngagementFeedRow(row: EngagementFeedRow): NewsArticle {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    snippet: row.snippet,
    source_id: row.source_id,
    image_url: row.image_url,
    published_at: row.published_at,
    url: row.url,
    category_id: row.category_id,
    sources: row.source_id
      ? {
          id: row.source_id,
          name: row.source_name ?? 'Unknown source',
          website_url: row.source_website_url,
          logo_url: row.source_logo_url,
        }
      : null,
    categories: row.category_id
      ? {
          id: row.category_id,
          name: row.category_name ?? '',
          slug: row.category_slug ?? undefined,
        }
      : null,
    source_name: row.source_name ?? 'Unknown source',
    category_name: row.category_name,
    like_count: row.likes_count ?? 0,
    comment_count: (row.comments_count ?? 0) + (row.replies_count ?? 0),
  };
}

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

  const from = (page - 1) * limit;
  const to = page * limit - 1;

  const { data, error } = await supabasePublic
    .from('articles_engagement_feed')
    .select('*')
    .order('engagement_score', { ascending: false })
    .order('published_at', { ascending: false })
    .range(from, to);

  if (error) {
    logPublicErrorOnce('fetchTrendingArticlesPublic', error);
    throw error;
  }

  const rawCount = (data ?? []).length;
  const articles = ((data as EngagementFeedRow[]) ?? []).map(mapEngagementFeedRow);
  const hasMore = rawCount >= limit;
  return writeFeedCache(cacheKey, { articles, hasMore });
}

export async function fetchTrendingArticleByIdPublic(articleId: string): Promise<NewsArticle | null> {
  const { data, error } = await supabasePublic
    .from('articles_engagement_feed')
    .select('*')
    .eq('id', articleId)
    .maybeSingle();

  if (error) {
    logPublicErrorOnce('fetchTrendingArticleByIdPublic', error);
    return null;
  }

  if (!data) return null;
  return mapEngagementFeedRow(data as EngagementFeedRow);
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
