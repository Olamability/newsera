/**
 * Phase B — Deterministic category normalization layer.
 *
 * Resolves the residual Phase A schema-dependency debt by guaranteeing that
 * every job leaving the queue runner carries a non-null, schema-validated
 * `category_id`.
 *
 * Rules (from the Phase B problem statement):
 *   - input: category_id may be missing, null, or invalid (not present in the
 *     `categories` table)
 *   - output: a valid category_id OR the well-known `uncategorized` fallback
 *   - NO nulls allowed beyond this layer
 *
 * The legacy ingestion worker performs a similar lookup against `sources`,
 * but only as a last resort and with a single `uncategorized` cache slot. The
 * queue runner sees a much higher volume of mixed payloads (ranking,
 * notifications, analytics) so we lift the resolver into a standalone module
 * with:
 *   - an LRU-bounded positive cache for valid category ids
 *   - a single-slot cache for the uncategorized fallback
 *   - a negative cache so a flood of unknown ids does not hammer the DB
 *
 * Caches are process-local and bounded; eviction is FIFO once `cacheLimit`
 * entries accumulate. No external state, no infra dependencies — strictly
 * within the Phase B "no new infra tools" rule.
 */

import type { LogFn } from './logger';
import type { SupabaseLike } from './types';

export const UNCATEGORIZED_SLUG = 'uncategorized' as const;

export interface NormalizedCategoryResult {
  /** Guaranteed non-null once `resolved=true`. */
  categoryId: string | null;
  /** True when the input id was missing/invalid and the fallback was used. */
  usedFallback: boolean;
  /** True when normalization produced a non-null id (success path). */
  resolved: boolean;
  /** Reason classification — useful for log aggregation. */
  reason:
    | 'valid'
    | 'fallback_missing_input'
    | 'fallback_invalid_input'
    | 'fallback_unavailable';
}

export interface NormalizeCategoryOptions {
  cacheLimit?: number;
}

export interface CategoryNormalizer {
  normalize(categoryId: string | null | undefined): Promise<NormalizedCategoryResult>;
  /** Test/diag hook — drops all cached state. */
  reset(): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `category_id` is a UUID by schema. We pre-filter obviously-malformed input
 * before hitting the DB so a flood of garbage payloads is absorbed entirely
 * in memory.
 */
function looksLikeUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function createCategoryNormalizer(
  supabase: SupabaseLike,
  log: LogFn,
  opts: NormalizeCategoryOptions = {},
): CategoryNormalizer {
  const cacheLimit = Math.max(opts.cacheLimit ?? 1024, 16);

  // Positive cache: known-valid category ids. Bounded LRU-via-FIFO.
  const valid = new Set<string>();
  // Negative cache: ids confirmed absent from `categories`.
  const invalid = new Set<string>();
  let fallbackId: string | null | undefined;
  let fallbackPromise: Promise<string | null> | null = null;

  function rememberValid(id: string): void {
    if (valid.has(id)) return;
    if (valid.size >= cacheLimit) {
      // FIFO eviction — Set preserves insertion order in JS.
      const oldest = valid.values().next().value as string | undefined;
      if (oldest !== undefined) valid.delete(oldest);
    }
    valid.add(id);
  }

  function rememberInvalid(id: string): void {
    if (invalid.has(id)) return;
    if (invalid.size >= cacheLimit) {
      const oldest = invalid.values().next().value as string | undefined;
      if (oldest !== undefined) invalid.delete(oldest);
    }
    invalid.add(id);
  }

  async function loadFallback(): Promise<string | null> {
    if (fallbackId !== undefined) return fallbackId;
    // Single-flight: many concurrent jobs hitting the fallback at once must
    // collapse into one DB round-trip.
    if (fallbackPromise) return fallbackPromise;

    fallbackPromise = (async () => {
      try {
        const { data, error } = await supabase
          .from<{ id: string | null }>('categories')
          .select('id')
          .eq('slug', UNCATEGORIZED_SLUG)
          .maybeSingle();
        if (error) {
          log('warn', 'normalize_category_fallback_lookup_failed', {
            error: error.message,
          });
          fallbackId = null;
          return null;
        }
        fallbackId = data?.id ?? null;
        if (!fallbackId) {
          log('error', 'normalize_category_fallback_missing', {
            slug: UNCATEGORIZED_SLUG,
          });
        }
        return fallbackId;
      } catch (err) {
        log('warn', 'normalize_category_fallback_lookup_threw', {
          error: (err as Error)?.message ?? String(err),
        });
        fallbackId = null;
        return null;
      } finally {
        fallbackPromise = null;
      }
    })();

    return fallbackPromise;
  }

  async function validateAgainstDb(id: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from<{ id: string | null }>('categories')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        log('warn', 'normalize_category_validate_failed', {
          category_id: id,
          error: error.message,
        });
        // Fail-open: treat as unknown but don't pollute the negative cache —
        // the next call will retry rather than persisting a transient error.
        return false;
      }
      return Boolean(data?.id);
    } catch (err) {
      log('warn', 'normalize_category_validate_threw', {
        category_id: id,
        error: (err as Error)?.message ?? String(err),
      });
      return false;
    }
  }

  async function buildFallbackResult(
    reason: NormalizedCategoryResult['reason'],
  ): Promise<NormalizedCategoryResult> {
    const id = await loadFallback();
    if (id) {
      // Make sure the fallback itself is cached so subsequent normalisations
      // of already-uncategorised payloads short-circuit.
      rememberValid(id);
      return { categoryId: id, usedFallback: true, resolved: true, reason };
    }
    return {
      categoryId: null,
      usedFallback: true,
      resolved: false,
      reason: 'fallback_unavailable',
    };
  }

  return {
    async normalize(categoryId) {
      // Case 1: missing input.
      if (categoryId === null || categoryId === undefined || categoryId === '') {
        return buildFallbackResult('fallback_missing_input');
      }

      // Case 2: obviously-malformed input — never round-trip the DB.
      if (!looksLikeUuid(categoryId)) {
        rememberInvalid(String(categoryId));
        return buildFallbackResult('fallback_invalid_input');
      }

      // Cache short-circuits.
      if (valid.has(categoryId)) {
        return { categoryId, usedFallback: false, resolved: true, reason: 'valid' };
      }
      if (invalid.has(categoryId)) {
        return buildFallbackResult('fallback_invalid_input');
      }

      // Case 3: DB validation.
      const ok = await validateAgainstDb(categoryId);
      if (ok) {
        rememberValid(categoryId);
        return { categoryId, usedFallback: false, resolved: true, reason: 'valid' };
      }

      rememberInvalid(categoryId);
      return buildFallbackResult('fallback_invalid_input');
    },
    reset() {
      valid.clear();
      invalid.clear();
      fallbackId = undefined;
      fallbackPromise = null;
    },
  };
}
