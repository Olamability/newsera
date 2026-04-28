import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';
import { getDeviceId } from './deviceId';

const PAGE_SIZE = 20;
const TRENDING_LIMIT = 20;
const PERSONALIZED_DISPLAY_COUNT = 10;

/**
 * SAFE ARTICLES FETCH (NO FRAGILE JOINS)
 */
export async function fetchArticles(
  page: number,
  categoryId?: string | null
): Promise<NewsArticle[]> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from('articles')
    .select('*') // 🔥 IMPORTANT: remove joins for now
    .order('published_at', { ascending: false })
    .range(from, to);

  if (categoryId) {
    query = query.eq('category_id', categoryId);
  }

  const { data, error } = await query;

  console.log('📦 fetchArticles DATA:', data);
  console.log('❌ fetchArticles ERROR:', error);

  if (error) throw error;

  return (data as NewsArticle[]) ?? [];
}

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

  return data ?? [];
}

/**
 * TRENDING (SAFE VERSION)
 */
export async function fetchTrendingArticles(): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('published_at', { ascending: false })
    .limit(TRENDING_LIMIT);

  console.log('🔥 trending:', data);
  console.log('❌ trending error:', error);

  if (error) throw error;

  return (data as NewsArticle[]) ?? [];
}

/**
 * PERSONALIZED (SAFE FALLBACK VERSION)
 */
export async function fetchPersonalizedArticles(): Promise<NewsArticle[]> {
  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .order('published_at', { ascending: false })
      .limit(PERSONALIZED_DISPLAY_COUNT);

    console.log('✨ personalized:', data);
    console.log('❌ personalized error:', error);

    if (error) throw error;

    return (data as NewsArticle[]) ?? [];
  } catch (err) {
    console.warn('Personalized fetch failed:', err);
    return [];
  }
}