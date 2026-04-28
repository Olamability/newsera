import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';
import { getDeviceId } from './deviceId';

const PAGE_SIZE = 20;
const MAX_PER_SOURCE = 2;
// Fetch a larger pool so that after balancing we still have PAGE_SIZE articles
const FETCH_MULTIPLIER = 4;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;

const ARTICLE_SELECT = '*, sources(name, website_url), categories(name)';

export const CATEGORY_ALL = 'all';
export const CATEGORY_FOR_YOU = 'foryou';
export const CATEGORY_TRENDING = 'trending';

interface ArticleRow {
  image_url?: string | null;
  image?: string | null;
  content?: string | null;
  sources?: { name?: string | null; website_url?: string | null } | null;
  categories?: { name?: string | null } | null;
  [key: string]: unknown;
}

function extractFirstImageFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function resolveImageUrl(row: ArticleRow): string | null {
  if (row.image_url) return row.image_url;
  if (row.image) return row.image;
  return extractFirstImageFromContent(row.content);
}

function mapArticle(row: ArticleRow): NewsArticle {
  return {
    ...(row as unknown as NewsArticle),
    image_url: resolveImageUrl(row),
    source_name: row.sources?.name ?? 'Unknown source',
    category_name: row.categories?.name ?? null,
  };
}

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
 */
export async function fetchArticles(
  page: number,
  categoryId?: string | null
): Promise<NewsArticle[]> {
  // For the balanced feed each "page" consumes a pool of poolSize raw DB rows.
  // Articles beyond the first MAX_PER_SOURCE per source within that pool are
  // intentionally skipped to ensure source diversity — this is not a data gap.
  const poolSize = categoryId ? PAGE_SIZE : PAGE_SIZE * FETCH_MULTIPLIER;
  const from = page * poolSize;
  const to = from + poolSize - 1;

  let query = supabase
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }

  const { data, error } = await query;

  console.log('📦 fetchArticles DATA:', data);
  console.log('❌ fetchArticles ERROR:', error);

  if (error) throw error;

  const mapped = ((data as ArticleRow[]) ?? []).map(mapArticle);

  // Apply source-balancing only for the general feed
  return categoryId ? mapped : balanceBySource(mapped);
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
 * TRENDING (SAFE VERSION)
 */
export async function fetchTrendingArticles(): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('published_at', { ascending: false })
    .limit(TRENDING_LIMIT);

  console.log('🔥 trending:', data);
  console.log('❌ trending error:', error);

  if (error) throw error;

  return ((data as ArticleRow[]) ?? []).map(mapArticle);
}

/**
 * PERSONALIZED (SAFE FALLBACK VERSION)
 */
export async function fetchPersonalizedArticles(): Promise<NewsArticle[]> {
  try {
    const { data, error } = await supabase
      .from('articles')
      .select(ARTICLE_SELECT)
      .order('published_at', { ascending: false })
      .limit(PERSONALIZED_DISPLAY_COUNT);

    console.log('✨ personalized:', data);
    console.log('❌ personalized error:', error);

    if (error) throw error;

    return ((data as ArticleRow[]) ?? []).map(mapArticle);
  } catch (err) {
    console.warn('Personalized fetch failed:', err);
    return [];
  }
}