/**
 * Phase G — SEO health auditor.
 *
 * Composes the outputs of `schemaValidator`, `sitemapCoordinator`, and
 * `newsIndexingMonitor` into one operator-friendly SEO health report.
 *
 * Pure compute.
 */

import type { SchemaValidationResult } from './schemaValidator';
import type { SitemapHealthReport } from './sitemapCoordinator';

export interface ArticleFreshness {
  url: string;
  publishedAt: string;
  ageMs: number;
  category?: string;
}

export interface SeoHealthInput {
  schemaResults: SchemaValidationResult[];
  sitemapHealth: SitemapHealthReport[];
  /** Recent articles with their publish times. */
  recentArticles: ArticleFreshness[];
  /** Indexing drift score from newsIndexingMonitor.driftScore(). */
  indexingDriftScore: number;
  /** Map of source domain → authority score 0..1. */
  sourceAuthority: Record<string, number>;
  /** Duplicate-content cluster count. */
  duplicateClusterCount: number;
  now?: () => Date;
}

export interface SeoHealthReport {
  generatedAt: string;
  overallScore: number;
  classification: 'healthy' | 'degraded' | 'critical';
  components: {
    schemaScore: number;
    sitemapScore: number;
    freshnessScore: number;
    indexingScore: number;
    sourceAuthorityScore: number;
    duplicateContentPenalty: number;
  };
  topIssues: string[];
  staleArticles: ArticleFreshness[];
  metadataGaps: SchemaValidationResult[];
}

const STALE_ARTICLE_MS = 7 * 24 * 3_600_000;

export function auditSeoHealth(input: SeoHealthInput): SeoHealthReport {
  const now = input.now ?? (() => new Date());
  const generatedAt = now().toISOString();

  const schemaScore =
    input.schemaResults.length === 0
      ? 1
      : input.schemaResults.reduce((s, r) => s + r.score, 0) / input.schemaResults.length;

  const sitemapScore =
    input.sitemapHealth.length === 0
      ? 1
      : input.sitemapHealth.reduce((s, r) => s + r.freshnessScore, 0) / input.sitemapHealth.length;

  // Freshness: penalise articles that are stale and not refreshed.
  const stale = input.recentArticles.filter((a) => a.ageMs > STALE_ARTICLE_MS);
  const freshnessScore =
    input.recentArticles.length === 0 ? 1 : Math.max(0, 1 - stale.length / input.recentArticles.length);

  const indexingScore = Math.max(0, Math.min(1, input.indexingDriftScore));

  const authorityValues = Object.values(input.sourceAuthority);
  const sourceAuthorityScore =
    authorityValues.length === 0
      ? 0.5
      : authorityValues.reduce((s, v) => s + v, 0) / authorityValues.length;

  const duplicateContentPenalty = Math.min(0.4, input.duplicateClusterCount * 0.02);

  const overallScore = Math.max(
    0,
    Math.min(
      1,
      schemaScore * 0.25 +
        sitemapScore * 0.2 +
        freshnessScore * 0.15 +
        indexingScore * 0.2 +
        sourceAuthorityScore * 0.2 -
        duplicateContentPenalty,
    ),
  );

  let classification: SeoHealthReport['classification'] = 'healthy';
  if (overallScore < 0.6) classification = 'critical';
  else if (overallScore < 0.8) classification = 'degraded';

  const topIssues: string[] = [];
  if (schemaScore < 0.9) topIssues.push(`metadata gaps in ${input.schemaResults.filter((r) => !r.ok).length} pages`);
  if (sitemapScore < 0.9) {
    const staleSitemaps = input.sitemapHealth.filter((s) => s.status === 'stale').map((s) => s.name);
    if (staleSitemaps.length) topIssues.push(`stale sitemaps: ${staleSitemaps.join(', ')}`);
  }
  if (indexingScore < 0.9) topIssues.push('indexing drift detected');
  if (duplicateContentPenalty > 0) topIssues.push(`${input.duplicateClusterCount} duplicate-content clusters`);
  if (stale.length > 0) topIssues.push(`${stale.length} stale articles older than ${STALE_ARTICLE_MS / 86_400_000}d`);
  if (topIssues.length === 0) topIssues.push('no issues — SEO surface healthy');

  return {
    generatedAt,
    overallScore,
    classification,
    components: {
      schemaScore,
      sitemapScore,
      freshnessScore,
      indexingScore,
      sourceAuthorityScore,
      duplicateContentPenalty,
    },
    topIssues,
    staleArticles: stale,
    metadataGaps: input.schemaResults.filter((r) => !r.ok),
  };
}
