import { supabase } from './supabase';
import { NewsArticle, Category } from '../types';

const PAGE_SIZE = 20;

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
