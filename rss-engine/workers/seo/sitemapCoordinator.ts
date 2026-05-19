/**
 * Phase G — Sitemap coordinator.
 *
 * Tracks the metadata for one or many sitemaps the host emits. Computes
 * staleness, missing-URL detection, and a freshness score the operator
 * dashboard surfaces. Does NOT generate XML — the host owns that.
 */

export interface SitemapDescriptor {
  name: string; // e.g. 'sitemap_news.xml'
  type: 'news' | 'standard';
  lastBuiltAt: string;
  entryCount: number;
  maxAgeMs?: number; // default by type
}

export interface SitemapEntry {
  sitemapName: string;
  url: string;
  publishedAt: string;
  lastModifiedAt: string;
  /** True if this URL is referenced by the published sitemap. */
  referenced: boolean;
}

export type SitemapHealthStatus = 'fresh' | 'stale' | 'missing';

export interface SitemapHealthReport {
  name: string;
  status: SitemapHealthStatus;
  ageMs: number;
  expectedMaxAgeMs: number;
  entryCount: number;
  missingFromIndex: number;
  freshnessScore: number; // 0..1
}

export interface SitemapCoordinatorConfig {
  /** Max age for news sitemaps (default 5min). */
  newsMaxAgeMs?: number;
  /** Max age for standard sitemaps (default 6h). */
  standardMaxAgeMs?: number;
  now?: () => Date;
}

export interface SitemapCoordinator {
  registerSitemap(sitemap: SitemapDescriptor): void;
  registerEntry(entry: SitemapEntry): void;
  health(name: string): SitemapHealthReport | null;
  healthAll(): SitemapHealthReport[];
  /** Average freshness across all sitemaps in 0..1. */
  overallScore(): number;
  /** URLs published recently but not yet referenced. */
  pendingUrls(name: string): string[];
}

export function createSitemapCoordinator(config: SitemapCoordinatorConfig = {}): SitemapCoordinator {
  const newsMaxAgeMs = config.newsMaxAgeMs ?? 5 * 60_000;
  const standardMaxAgeMs = config.standardMaxAgeMs ?? 6 * 3_600_000;
  const now = config.now ?? (() => new Date());

  const sitemaps = new Map<string, SitemapDescriptor>();
  const entries = new Map<string, SitemapEntry[]>();

  function defaultMaxAge(type: SitemapDescriptor['type']): number {
    return type === 'news' ? newsMaxAgeMs : standardMaxAgeMs;
  }

  function health(name: string): SitemapHealthReport | null {
    const sitemap = sitemaps.get(name);
    if (!sitemap) return null;
    const ageMs = now().getTime() - new Date(sitemap.lastBuiltAt).getTime();
    const max = sitemap.maxAgeMs ?? defaultMaxAge(sitemap.type);
    const status: SitemapHealthStatus = ageMs > max ? 'stale' : 'fresh';
    const sitemapEntries = entries.get(name) ?? [];
    const missingFromIndex = sitemapEntries.filter((e) => !e.referenced).length;
    let freshnessScore = Math.max(0, 1 - ageMs / (max * 2));
    if (missingFromIndex > 0) freshnessScore *= Math.max(0.3, 1 - missingFromIndex / Math.max(1, sitemap.entryCount));
    return {
      name,
      status,
      ageMs,
      expectedMaxAgeMs: max,
      entryCount: sitemap.entryCount,
      missingFromIndex,
      freshnessScore,
    };
  }

  return {
    registerSitemap(sitemap) {
      sitemaps.set(sitemap.name, { ...sitemap });
    },
    registerEntry(entry) {
      const arr = entries.get(entry.sitemapName) ?? [];
      arr.push({ ...entry });
      entries.set(entry.sitemapName, arr);
    },
    health,
    healthAll() {
      const out: SitemapHealthReport[] = [];
      for (const name of sitemaps.keys()) {
        const h = health(name);
        if (h) out.push(h);
      }
      return out;
    },
    overallScore() {
      const reports = this.healthAll();
      if (reports.length === 0) return 0;
      return reports.reduce((s, r) => s + r.freshnessScore, 0) / reports.length;
    },
    pendingUrls(name) {
      const arr = entries.get(name) ?? [];
      return arr.filter((e) => !e.referenced).map((e) => e.url);
    },
  };
}
