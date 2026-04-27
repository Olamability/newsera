import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';

const DEVICE_ID_KEY = 'newsera_device_id';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;

/** Returns the persistent device ID (mirrors the helper in ArticleDetailScreen). */
async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

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

/**
 * Returns a personalized feed for the current device.
 *
 * Ranking weights (applied to the personalized feed only):
 *   • Trending (click count, last 24h) — 50 %
 *   • Recency (published_at)           — 30 %
 *   • User interest (category score)   — 20 %
 *
 * Falls back to the most-recent articles when no interest data exists.
 */
export async function fetchPersonalizedArticles(): Promise<NewsArticle[]> {
  try {
    const deviceId = await getDeviceId();

    // 1. Fetch this device's category interests (highest score first)
    const { data: interests } = await supabase
      .from('user_interests')
      .select('category_id, score')
      .eq('user_id', deviceId)
      .order('score', { ascending: false })
      .limit(10);

    // Fallback: no interest data → return latest articles
    if (!interests || interests.length === 0) {
      const { data, error } = await supabase
        .from('articles')
        .select(
          `id, title, snippet, image_url, published_at, url, source_id, category_id,
           sources ( id, name, website_url, logo_url ),
           categories ( id, name, slug )`
        )
        .order('published_at', { ascending: false })
        .limit(PERSONALIZED_DISPLAY_COUNT);
      if (error) throw error;
      return (data as unknown as NewsArticle[]) ?? [];
    }

    const categoryIds = interests.map((i: { category_id: string }) => i.category_id);

    // Build a quick-lookup: category_id → normalised interest score (0–1)
    const maxScore = Math.max(...interests.map((i: { score: number }) => i.score), 1);
    const interestMap: Record<string, number> = {};
    interests.forEach((i: { category_id: string; score: number }) => {
      interestMap[i.category_id] = i.score / maxScore;
    });

    // 2. Fetch articles from preferred categories
    const { data: catArticles, error: catError } = await supabase
      .from('articles')
      .select(
        `id, title, snippet, image_url, published_at, url, source_id, category_id,
         sources ( id, name, website_url, logo_url ),
         categories ( id, name, slug )`
      )
      .in('category_id', categoryIds)
      .order('published_at', { ascending: false })
      .limit(PERSONALIZED_LIMIT);

    if (catError) throw catError;

    const articles = (catArticles as unknown as NewsArticle[]) ?? [];
    if (articles.length === 0) {
      // All preferred categories are empty → latest fallback
      const { data, error } = await supabase
        .from('articles')
        .select(
          `id, title, snippet, image_url, published_at, url, source_id, category_id,
           sources ( id, name, website_url, logo_url ),
           categories ( id, name, slug )`
        )
        .order('published_at', { ascending: false })
        .limit(PERSONALIZED_DISPLAY_COUNT);
      if (error) throw error;
      return (data as unknown as NewsArticle[]) ?? [];
    }

    // 3. Fetch trending click counts for these articles
    const articleIds = articles.map((a) => a.id);
    const { data: clickData } = await supabase
      .from('article_click_counts')
      .select('article_id, click_count')
      .in('article_id', articleIds);

    const maxClicks = Math.max(
      ...((clickData ?? []) as { article_id: string; click_count: number }[]).map(
        (r) => r.click_count
      ),
      1
    );
    const clickMap: Record<string, number> = {};
    ((clickData ?? []) as { article_id: string; click_count: number }[]).forEach((r) => {
      clickMap[r.article_id] = r.click_count / maxClicks;
    });

    // 4. Compute recency score: normalise published_at within the fetched set
    const timestamps = articles
      .map((a) => (a.published_at ? new Date(a.published_at).getTime() : 0));
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const tsRange = maxTs - minTs || 1;

    // 5. Apply weighted ranking
    const TRENDING_WEIGHT = 0.5;
    const RECENCY_WEIGHT = 0.3;
    const INTEREST_WEIGHT = 0.2;

    const scored = articles.map((a) => {
      const trendingScore = clickMap[a.id] ?? 0;
      const recencyScore = a.published_at
        ? (new Date(a.published_at).getTime() - minTs) / tsRange
        : 0;
      const interestScore = a.category_id ? (interestMap[a.category_id] ?? 0) : 0;

      const finalScore =
        TRENDING_WEIGHT * trendingScore +
        RECENCY_WEIGHT * recencyScore +
        INTEREST_WEIGHT * interestScore;

      return { article: a, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, PERSONALIZED_DISPLAY_COUNT).map((s) => s.article);
  } catch (err) {
    console.warn('[Personalized] fetchPersonalizedArticles failed:', err);
    return [];
  }
}

