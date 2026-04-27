/**
 * recentlyViewedService.ts
 *
 * Stores the last 10 viewed articles per device in AsyncStorage.
 * No backend changes required.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NewsArticle } from '../types';

const RECENTLY_VIEWED_KEY = 'newsera_recently_viewed';
const MAX_RECENTLY_VIEWED = 10;

/** Saves an article to the recently-viewed list (deduplicated, most recent first). */
export async function saveRecentlyViewed(article: NewsArticle): Promise<void> {
  try {
    const existing = await getRecentlyViewed();
    // Remove any previous entry for the same article
    const filtered = existing.filter((a) => a.id !== article.id);
    // Prepend the new entry and cap the list
    const updated = [article, ...filtered].slice(0, MAX_RECENTLY_VIEWED);
    await AsyncStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('[RecentlyViewed] Failed to save:', err);
  }
}

/** Returns the list of recently viewed articles (most recent first). */
export async function getRecentlyViewed(): Promise<NewsArticle[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENTLY_VIEWED_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as NewsArticle[];
  } catch (err) {
    console.warn('[RecentlyViewed] Failed to read:', err);
    return [];
  }
}
