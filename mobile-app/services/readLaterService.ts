import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabaseAuth } from './supabase';
import { NewsArticle, ReadLaterEntry } from '../types';

const READ_LATER_KEY = 'newsera_read_later';
const READ_LATER_TYPE = 'read_later';

// ─── Local storage (works for guests and as offline fallback) ─────────────────

export async function getLocalReadLater(): Promise<ReadLaterEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(READ_LATER_KEY);
    return raw ? (JSON.parse(raw) as ReadLaterEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveLocalReadLater(items: ReadLaterEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(READ_LATER_KEY, JSON.stringify(items));
  } catch {
    // non-fatal
  }
}

export async function addLocalReadLater(article: NewsArticle): Promise<void> {
  const existing = await getLocalReadLater();
  if (existing.some((e) => e.article.id === article.id)) return;
  const entry: ReadLaterEntry = {
    id: `${article.id}_${Date.now()}`,
    article,
    saved_at: new Date().toISOString(),
  };
  await saveLocalReadLater([entry, ...existing]);
}

export async function removeLocalReadLater(articleId: string): Promise<void> {
  const existing = await getLocalReadLater();
  await saveLocalReadLater(existing.filter((e) => e.article.id !== articleId));
}

export async function isInLocalReadLater(articleId: string): Promise<boolean> {
  const existing = await getLocalReadLater();
  return existing.some((e) => e.article.id === articleId);
}

// ─── Supabase (authenticated users) ──────────────────────────────────────────

export async function addSupabaseReadLater(articleId: string, userId: string): Promise<void> {
  const { error } = await supabaseAuth
    .from('bookmarks')
    .upsert(
      { user_id: userId, article_id: articleId, type: READ_LATER_TYPE },
      { onConflict: 'user_id,article_id,type' }
    );
  if (error) throw error;
}

export async function removeSupabaseReadLater(articleId: string, userId: string): Promise<void> {
  const { error } = await supabaseAuth
    .from('bookmarks')
    .delete()
    .eq('user_id', userId)
    .eq('article_id', articleId)
    .eq('type', READ_LATER_TYPE);
  if (error) throw error;
}

export async function fetchSupabaseReadLater(userId: string): Promise<NewsArticle[]> {
  const { data, error } = await supabaseAuth
    .from('bookmarks')
    .select(
      `article_id,
       articles (
         id, title, snippet, image_url, published_at, url, source_id, category_id,
         sources ( id, name, website_url, logo_url ),
         categories ( id, name, slug )
       )`
    )
    .eq('user_id', userId)
    .eq('type', READ_LATER_TYPE)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (
    ((data ?? []) as unknown as Array<{ articles: NewsArticle }>)
      .map((row) => row.articles)
      .filter(Boolean)
  );
}
