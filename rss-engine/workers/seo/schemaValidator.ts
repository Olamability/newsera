/**
 * Phase G — Schema.org / OpenGraph / Twitter card validator.
 *
 * Pure compute. Validates the structured metadata blobs the article
 * renderer emits. The host parses HTML (or RSC manifest) and passes the
 * extracted record in.
 */

export interface ArticleMetadata {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogType: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  /** JSON-LD blocks present on the page. */
  jsonLd: Array<Record<string, unknown>>;
  /** Article headline (h1). */
  h1: string | null;
}

export type SchemaIssueLevel = 'info' | 'warn' | 'error';

export interface SchemaIssue {
  field: string;
  level: SchemaIssueLevel;
  message: string;
}

export interface SchemaValidationResult {
  url: string;
  ok: boolean;
  score: number; // 0..1
  issues: SchemaIssue[];
}

const NEWS_ARTICLE_REQUIRED_FIELDS = [
  '@type',
  'headline',
  'datePublished',
  'author',
  'image',
];

export function validateArticleSchema(meta: ArticleMetadata): SchemaValidationResult {
  const issues: SchemaIssue[] = [];

  if (!meta.canonicalUrl) issues.push({ field: 'canonical', level: 'error', message: 'missing canonical URL' });
  if (!meta.title) issues.push({ field: 'title', level: 'error', message: 'missing <title>' });
  if (!meta.description) issues.push({ field: 'description', level: 'warn', message: 'missing meta description' });
  if (meta.title && meta.title.length > 70)
    issues.push({ field: 'title', level: 'warn', message: 'title exceeds 70 chars' });
  if (meta.description && meta.description.length > 200)
    issues.push({ field: 'description', level: 'warn', message: 'description exceeds 200 chars' });

  if (!meta.ogTitle) issues.push({ field: 'og:title', level: 'error', message: 'missing og:title' });
  if (!meta.ogDescription) issues.push({ field: 'og:description', level: 'warn', message: 'missing og:description' });
  if (!meta.ogImage) issues.push({ field: 'og:image', level: 'error', message: 'missing og:image' });
  if (!meta.ogType) issues.push({ field: 'og:type', level: 'warn', message: 'missing og:type' });
  else if (meta.ogType !== 'article') issues.push({ field: 'og:type', level: 'info', message: `og:type=${meta.ogType} (expected 'article')` });

  if (!meta.twitterCard) issues.push({ field: 'twitter:card', level: 'warn', message: 'missing twitter:card' });
  if (!meta.twitterImage && meta.ogImage) {
    issues.push({ field: 'twitter:image', level: 'info', message: 'twitter:image will fall back to og:image' });
  }

  if (meta.h1 && meta.title && meta.h1.trim() !== meta.title.trim()) {
    issues.push({ field: 'h1', level: 'info', message: 'h1 differs from <title>' });
  }

  // JSON-LD NewsArticle validation.
  const newsArticles = meta.jsonLd.filter(
    (b) => typeof b['@type'] === 'string' && /Article/i.test(String(b['@type'])),
  );
  if (newsArticles.length === 0) {
    issues.push({ field: 'jsonld', level: 'error', message: 'no Article JSON-LD block' });
  } else {
    for (const block of newsArticles) {
      for (const f of NEWS_ARTICLE_REQUIRED_FIELDS) {
        if (block[f] == null) {
          issues.push({ field: `jsonld.${f}`, level: 'error', message: `JSON-LD missing required field '${f}'` });
        }
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.filter((i) => i.level === 'warn').length;
  const score = Math.max(0, 1 - errors * 0.2 - warns * 0.05);
  return { url: meta.url, ok: errors === 0, score, issues };
}

/** Detect duplicate-content risk across many article metadata blobs. */
export function detectDuplicateContent(items: ArticleMetadata[]): Array<{
  fingerprint: string;
  urls: string[];
}> {
  const buckets = new Map<string, string[]>();
  for (const m of items) {
    const fp = `${(m.title ?? '').trim().toLowerCase()}|${(m.description ?? '').trim().toLowerCase()}`;
    if (!fp || fp === '|') continue;
    const arr = buckets.get(fp) ?? [];
    arr.push(m.url);
    buckets.set(fp, arr);
  }
  const out: Array<{ fingerprint: string; urls: string[] }> = [];
  for (const [fp, urls] of buckets) {
    if (urls.length > 1) out.push({ fingerprint: fp, urls });
  }
  return out;
}
