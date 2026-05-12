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
  sources?: {
    id?: string | null;
    name?: string | null;
    website_url?: string | null;
    logo_url?: string | null;
    is_verified?: boolean | null;
    promotion_tier?: 'organic' | 'promoted' | null;
  } | null;
  categories?: { id?: string | null; name?: string | null; slug?: string | null } | null;
  is_sponsored?: boolean | null;
  sponsor_name?: string | null;
  campaign_id?: string | null;
  distribution_channel?: 'organic' | 'promoted' | 'sponsored' | null;
  analytics_label?: string | null;
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

const MAX_SANITIZE_PASSES = 3;
const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

const stripTagBlocks = (value: string, tagName: string): string => {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  return value.replace(pattern, ' ');
};

const decodeCommonEntities = (value: string): string => {
  let decoded = value;

  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass += 1) {
    const next = decoded
      .replace(/&nbsp;?/gi, ' ')
      .replace(/\$nbsp;?/gi, ' ')
      .replace(/&#160;?/gi, ' ')
      .replace(/&amp;nbsp;?/gi, ' ')
      .replace(/&(amp|quot|apos|lt|gt|#39);/gi, (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match);

    if (next === decoded) break;
    decoded = next;
  }

  return decoded;
};

export function sanitizeArticleContent(text: string | null | undefined): string {
  if (!text) return '';

  const withParagraphBreaks = text
    .replace(/\u00a0/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr)>/gi, '\n');

  const withoutUnsafeBlocks = stripTagBlocks(stripTagBlocks(withParagraphBreaks, 'style'), 'script');
  const withoutTags = withoutUnsafeBlocks.replace(/<[^>]+>/g, ' ');
  const decoded = decodeCommonEntities(withoutTags);
  const withoutRawEntities = decoded.replace(/&[a-z0-9#]+;?/gi, ' ');
  const normalizedLines = withoutRawEntities
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  return normalizedLines.join('\n\n').replace(/\s{2,}/g, ' ').trim();
}

export function mapArticle(row: ArticleRow): NewsArticle {
  return {
    ...(row as unknown as NewsArticle),
    image_url: resolveImageUrl(row),
    source_name: row.sources?.name ?? 'Unknown source',
    category_name: row.categories?.name ?? null,
  };
}
