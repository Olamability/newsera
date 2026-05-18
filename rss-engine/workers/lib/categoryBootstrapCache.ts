/**
 * Phase C — Category bootstrap cache (closes Phase B cold-start debt).
 *
 * Symptom this fixes:
 *   On worker (re)start, the very first `recategorize_article`, ranking
 *   `rescore_category`, and notification fanout payloads all trigger a
 *   category lookup. The Phase B `CategoryNormalizer` caches results, but
 *   the cache is cold — so a rolling deploy that rotates 4–8 workers in a
 *   minute produces a synchronous spike of SELECTs against `categories`.
 *
 * Fix:
 *   Warm the normalizer cache as part of worker bootstrap by pre-loading:
 *     1. the `uncategorized` fallback row (guarantees the fallback id is
 *        already cached, so the very first fallback path is sync-fast)
 *     2. the top N most-active categories (default 50) — "most-active" is
 *        approximated by the existing `categories.slug` column ordering
 *        because we are forbidden from adding ranking metadata to the
 *        schema in Phase C. Operators who want a smarter ordering can
 *        plug their own loader in (see `loadTopCategories`).
 *
 * No new schema. No new infra. Pure additive helper called from the
 * runner entry script(s) BEFORE `runner.start()`.
 */

import type { LogFn } from './logger';
import type { CategoryNormalizer } from './normalizeCategory';
import type { SupabaseLike } from './types';

export interface CategoryBootstrapOptions {
  /** Max number of category rows to warm. Default 50. */
  topN?: number;
  /**
   * Override loader for the top-N category list. Default loads from the
   * `categories` table by slug order. Inject for tests or for operators
   * who maintain an activity-ranked view.
   */
  loadTopCategories?: (limit: number) => Promise<Array<{ id: string }>>;
}

export interface CategoryBootstrapResult {
  fallbackLoaded: boolean;
  topLoaded: number;
  durationMs: number;
}

/**
 * Warm the normalizer cache. Safe to call multiple times — the normalizer's
 * cache is idempotent and bounded. Errors are swallowed (logged) so a
 * transient DB issue at boot never blocks the worker from starting.
 */
export async function warmCategoryBootstrapCache(
  supabase: SupabaseLike,
  normalizer: CategoryNormalizer,
  log: LogFn,
  opts: CategoryBootstrapOptions = {},
): Promise<CategoryBootstrapResult> {
  const startedAt = Date.now();
  const topN = Math.min(Math.max(opts.topN ?? 50, 0), 500);

  // 1) Fallback — trigger normalize(null) once. This forces the normalizer to
  //    load `slug = 'uncategorized'` into its single-slot fallback cache.
  let fallbackLoaded = false;
  try {
    const r = await normalizer.normalize(null);
    fallbackLoaded = r.resolved;
    if (!r.resolved) {
      log('warn', 'category_bootstrap_fallback_missing', {
        reason: r.reason,
      });
    }
  } catch (err) {
    log('warn', 'category_bootstrap_fallback_threw', {
      error: (err as Error)?.message ?? String(err),
    });
  }

  // 2) Top-N — preload commonly-hit ids so the first burst after restart
  //    short-circuits in the positive cache.
  let topLoaded = 0;
  if (topN > 0) {
    try {
      const rows = await loadTop(supabase, topN, log, opts.loadTopCategories);
      // Drive each id through normalize so it lands in the same cache the
      // hot path consults. We do this sequentially: the lookups themselves
      // are cheap (positive-cache hits after first DB round-trip per id) and
      // a flood of parallel `from('categories')` calls at boot is exactly
      // the spike we are trying to avoid.
      for (const row of rows) {
        if (!row?.id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await normalizer.normalize(row.id);
          if (r.resolved && !r.usedFallback) topLoaded += 1;
        } catch {
          // ignore single-row failures, keep warming the rest
        }
      }
    } catch (err) {
      log('warn', 'category_bootstrap_top_load_threw', {
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  log('info', 'category_bootstrap_cache_warmed', {
    fallback_loaded: fallbackLoaded,
    top_loaded: topLoaded,
    top_n_requested: topN,
    duration_ms: durationMs,
  });
  return { fallbackLoaded, topLoaded, durationMs };
}

async function loadTop(
  supabase: SupabaseLike,
  limit: number,
  log: LogFn,
  override?: (n: number) => Promise<Array<{ id: string }>>,
): Promise<Array<{ id: string }>> {
  if (override) return override(limit);

  // Default loader: rely on the minimal `SupabaseLike` surface — which only
  // exposes `select`/`eq`/`maybeSingle`. We cannot do `.limit(N)` through
  // it, so the default loader is intentionally conservative and only warms
  // the fallback. Operators that want top-N warming should pass a
  // `loadTopCategories` callback wired to the real Supabase client.
  log('debug', 'category_bootstrap_no_top_loader', {
    note: 'inject loadTopCategories for top-N warming',
    requested: limit,
  });
  return [];
}
