import AsyncStorage from '@react-native-async-storage/async-storage';
import { NewsArticle, OfflineArticle } from '../types';

const OFFLINE_ARTICLES_KEY = 'newsera_offline_articles';
const MAX_OFFLINE_ARTICLES = 30;

export async function getOfflineArticles(): Promise<OfflineArticle[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_ARTICLES_KEY);
    return raw ? (JSON.parse(raw) as OfflineArticle[]) : [];
  } catch {
    return [];
  }
}

async function persistOfflineArticles(items: OfflineArticle[]): Promise<void> {
  await AsyncStorage.setItem(OFFLINE_ARTICLES_KEY, JSON.stringify(items));
}

export async function saveArticleOffline(article: NewsArticle): Promise<void> {
  const existing = await getOfflineArticles();
  if (existing.some((e) => e.article.id === article.id)) return;
  const entry: OfflineArticle = {
    article,
    saved_at: new Date().toISOString(),
    content_snapshot: article.content ?? article.snippet ?? undefined,
  };
  const updated = [entry, ...existing].slice(0, MAX_OFFLINE_ARTICLES);
  await persistOfflineArticles(updated);
}

export async function removeOfflineArticle(articleId: string): Promise<void> {
  const existing = await getOfflineArticles();
  await persistOfflineArticles(existing.filter((e) => e.article.id !== articleId));
}

export async function isArticleSavedOffline(articleId: string): Promise<boolean> {
  const existing = await getOfflineArticles();
  return existing.some((e) => e.article.id === articleId);
}

export async function getOfflineStorageStats(): Promise<{ count: number; maxCount: number }> {
  const items = await getOfflineArticles();
  return { count: items.length, maxCount: MAX_OFFLINE_ARTICLES };
}
