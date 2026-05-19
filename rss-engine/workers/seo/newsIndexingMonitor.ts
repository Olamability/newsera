/**
 * Phase G — News indexing monitor.
 *
 * Tracks which URLs have been published, when each indexer (Google News,
 * Bing News) last fetched/indexed them, and detects indexing drift —
 * articles that should be live in news indexes but are not.
 *
 * Pure compute. Host pushes observed indexer signals in.
 */

export interface ArticlePublication {
  url: string;
  publishedAt: string;
  category?: string;
  /** Optional source authority score 0..1. */
  sourceAuthority?: number;
}

export type IndexerName = 'google_news' | 'bing_news' | 'apple_news' | 'sitemap_ping';

export interface IndexerObservation {
  url: string;
  indexer: IndexerName;
  observedAt: string;
  state: 'indexed' | 'crawled' | 'submitted' | 'rejected';
}

export interface IndexingDriftEntry {
  url: string;
  publishedAt: string;
  ageMs: number;
  /** Indexers that have NOT seen this URL yet. */
  missingIndexers: IndexerName[];
  /** Indexers that crawled but did not index. */
  staleIndexers: IndexerName[];
}

export interface NewsVelocitySnapshot {
  category: string;
  publishedLastHour: number;
  averagePerHour: number;
  trend: 'rising' | 'steady' | 'cooling';
}

export interface IndexingMonitorConfig {
  expectedIndexers?: IndexerName[];
  /** Articles older than this with no indexer = drift. Default 30min. */
  indexingSlaMs?: number;
  now?: () => Date;
  maxPublications?: number;
}

export interface NewsIndexingMonitor {
  recordPublication(p: ArticlePublication): void;
  recordObservation(o: IndexerObservation): void;
  drift(): IndexingDriftEntry[];
  velocity(category?: string): NewsVelocitySnapshot[];
  /** Source authority score for a URL host (average of per-pub scores). */
  sourceAuthority(host: string): number;
  driftScore(): number;
  publishedCount(): number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

export function createNewsIndexingMonitor(
  config: IndexingMonitorConfig = {},
): NewsIndexingMonitor {
  const expectedIndexers = config.expectedIndexers ?? ['google_news', 'bing_news', 'sitemap_ping'];
  const slaMs = Math.max(60_000, config.indexingSlaMs ?? 30 * 60_000);
  const now = config.now ?? (() => new Date());
  const maxPub = Math.max(256, config.maxPublications ?? 50_000);

  const publications = new Map<string, ArticlePublication>();
  /** URL → indexer → state. */
  const observations = new Map<string, Map<IndexerName, IndexerObservation>>();

  function prune(): void {
    while (publications.size > maxPub) {
      const oldest = [...publications.values()].sort(
        (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
      )[0];
      if (oldest) {
        publications.delete(oldest.url);
        observations.delete(oldest.url);
      } else break;
    }
  }

  return {
    recordPublication(p) {
      publications.set(p.url, { ...p });
      prune();
    },

    recordObservation(o) {
      const map = observations.get(o.url) ?? new Map<IndexerName, IndexerObservation>();
      map.set(o.indexer, { ...o });
      observations.set(o.url, map);
    },

    drift() {
      const out: IndexingDriftEntry[] = [];
      const nowMs = now().getTime();
      for (const p of publications.values()) {
        const ageMs = nowMs - new Date(p.publishedAt).getTime();
        if (ageMs < slaMs) continue;
        const map = observations.get(p.url) ?? new Map<IndexerName, IndexerObservation>();
        const missingIndexers = expectedIndexers.filter((ix) => !map.has(ix));
        const staleIndexers = expectedIndexers.filter((ix) => {
          const obs = map.get(ix);
          return obs && obs.state !== 'indexed';
        });
        if (missingIndexers.length === 0 && staleIndexers.length === 0) continue;
        out.push({
          url: p.url,
          publishedAt: p.publishedAt,
          ageMs,
          missingIndexers,
          staleIndexers,
        });
      }
      return out;
    },

    velocity(category) {
      const nowMs = now().getTime();
      const byCat = new Map<string, ArticlePublication[]>();
      for (const p of publications.values()) {
        const cat = p.category ?? 'uncategorized';
        if (category && cat !== category) continue;
        const arr = byCat.get(cat) ?? [];
        arr.push(p);
        byCat.set(cat, arr);
      }
      const out: NewsVelocitySnapshot[] = [];
      for (const [cat, items] of byCat) {
        const lastHour = items.filter((p) => nowMs - new Date(p.publishedAt).getTime() <= 3_600_000).length;
        const last24 = items.filter((p) => nowMs - new Date(p.publishedAt).getTime() <= 24 * 3_600_000).length;
        const avg = last24 / 24;
        let trend: NewsVelocitySnapshot['trend'] = 'steady';
        if (lastHour > avg * 1.5) trend = 'rising';
        else if (lastHour < avg * 0.5) trend = 'cooling';
        out.push({
          category: cat,
          publishedLastHour: lastHour,
          averagePerHour: avg,
          trend,
        });
      }
      return out;
    },

    sourceAuthority(host) {
      const items = [...publications.values()].filter((p) => hostOf(p.url) === host);
      if (items.length === 0) return 0;
      const scored = items.filter((p) => typeof p.sourceAuthority === 'number');
      if (scored.length === 0) return 0.5; // unknown → neutral
      return scored.reduce((s, p) => s + (p.sourceAuthority ?? 0), 0) / scored.length;
    },

    driftScore() {
      const drifted = this.drift().length;
      const total = publications.size;
      if (total === 0) return 1;
      return Math.max(0, 1 - drifted / total);
    },

    publishedCount() {
      return publications.size;
    },
  };
}
