/**
 * articleUtils.ts
 *
 * Shared utilities for mapping raw Supabase article rows to NewsArticle
 * objects used across the app. Centralises image resolution and field
 * mapping so all screens stay in sync.
 */

import { NewsArticle } from '../types';

export interface ArticleRow {
  image_url?: string | null;
  image?: string | null;
  content?: string | null;
  sources?: { name?: string | null; website_url?: string | null } | null;
  categories?: { name?: string | null } | null;
  [key: string]: unknown;
}

export function extractFirstImageFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export function resolveImageUrl(row: ArticleRow): string | null {
  if (row.image_url) return row.image_url as string;
  if (row.image) return row.image as string;
  return extractFirstImageFromContent(row.content as string | null);
}

export function mapArticle(row: ArticleRow): NewsArticle {
  return {
    ...(row as unknown as NewsArticle),
    image_url: resolveImageUrl(row),
    source_name: row.sources?.name ?? 'Unknown source',
    category_name: row.categories?.name ?? null,
  };
}
