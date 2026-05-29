import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabasePublic } from '../services/supabase';
import { fetchArticlesNewerThan } from '../services/newsServicePublic';
import { NewsArticle } from '../types';

interface Options {
  /**
   * Latest article timestamp currently shown in the feed. Used as the
   * "since" cursor for polling and to filter realtime INSERT events.
   * `null` means: no articles loaded yet, skip polling.
   */
  latestTimestamp: string | null;
  /** Optional category filter — must match the current feed selection. */
  categoryId: string | null;
  /** Polling cadence. Defaults to 60s per spec. */
  pollIntervalMs?: number;
  /** Hard cap on the number of pending new articles we track. */
  maxPending?: number;
  /**
   * Disable the entire live layer (e.g. when search is active or the
   * user is viewing a virtual feed like "For You"/"Trending" that has
   * its own ranking pipeline).
   */
  enabled?: boolean;
}

interface Result {
  /** New articles waiting to be merged into the feed. */
  pendingArticles: NewsArticle[];
  /** Convenience count for the banner. */
  pendingCount: number;
  /** Drain the buffer — call this when the banner is tapped / on refresh. */
  consumePending: () => NewsArticle[];
  /** Drop pending without surfacing (e.g. after a manual full refresh). */
  clearPending: () => void;
}

const REALTIME_CHANNEL = 'live_feed_articles_inserts';

/**
 * Drives the "live feed" experience without disturbing FlatList scroll
 * position. Combines two delivery paths so we degrade gracefully when
 * realtime is unavailable:
 *
 *   1. **Polling** — every {@link Options.pollIntervalMs} we query
 *      `articles` for rows newer than the current head. This is the
 *      reliable, offline-tolerant baseline.
 *   2. **Supabase realtime** — a single shared INSERT subscription on
 *      `articles` pushes deltas as they happen so latency is sub-second
 *      when the network is healthy.
 *
 * Both paths funnel into the same deduplicated `pendingArticles` buffer
 * which the screen surfaces via the "N new articles" banner. We never
 * prepend automatically — that would jump scroll position.
 */
export function useLiveArticleUpdates({
  latestTimestamp,
  categoryId,
  pollIntervalMs = 60_000,
  maxPending = 50,
  enabled = true,
}: Options): Result {
  const [pendingArticles, setPendingArticles] = useState<NewsArticle[]>([]);

  // Mutable refs so the polling/realtime callbacks always see the freshest
  // cursor without forcing the effects below to tear down and re-subscribe
  // on every new article. The realtime subscription, in particular, is
  // expensive to recreate.
  const latestTimestampRef = useRef<string | null>(latestTimestamp);
  const categoryIdRef = useRef<string | null>(categoryId);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    latestTimestampRef.current = latestTimestamp;
  }, [latestTimestamp]);
  useEffect(() => {
    categoryIdRef.current = categoryId;
  }, [categoryId]);

  // When the category changes we must drop any pending items: they were
  // computed against a different filter and would pollute the new feed.
  useEffect(() => {
    pendingIdsRef.current = new Set();
    setPendingArticles([]);
  }, [categoryId]);

  const mergePending = useCallback(
    (incoming: NewsArticle[]) => {
      if (incoming.length === 0) return;
      setPendingArticles((prev) => {
        const seen = pendingIdsRef.current;
        // Also dedupe against what we've already buffered — both delivery
        // paths can fire for the same article within a polling window.
        const fresh = incoming.filter((a) => a && a.id && !seen.has(a.id));
        if (fresh.length === 0) return prev;
        for (const a of fresh) seen.add(a.id);
        const merged = [...fresh, ...prev];
        if (merged.length <= maxPending) return merged;
        // Trim oldest pending to keep memory bounded — they will be picked
        // up by the next manual refresh anyway.
        const trimmed = merged.slice(0, maxPending);
        pendingIdsRef.current = new Set(trimmed.map((a) => a.id));
        return trimmed;
      });
    },
    [maxPending],
  );

  // ---- Polling -----------------------------------------------------------
  useEffect(() => {
    if (!enabled) return undefined;
    if (!latestTimestamp) return undefined;

    let cancelled = false;

    const poll = async () => {
      const since = latestTimestampRef.current;
      if (!since) return;
      try {
        const fresh = await fetchArticlesNewerThan(since, {
          categoryId: categoryIdRef.current,
        });
        if (cancelled || fresh.length === 0) return;
        mergePending(fresh);
      } catch (err) {
        // Offline / transient errors must never crash the feed. The next
        // tick will retry.
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.debug('[useLiveArticleUpdates] poll failed:', err);
        }
      }
    };

    const intervalId = setInterval(poll, pollIntervalMs);

    // Re-poll opportunistically whenever the app returns to the
    // foreground — users typically expect "fresh" content after switching
    // back to the app.
    const onAppState = (state: AppStateStatus) => {
      if (state === 'active') void poll();
    };
    const sub = AppState.addEventListener('change', onAppState);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      sub.remove();
    };
  }, [enabled, latestTimestamp, pollIntervalMs, mergePending]);

  // ---- Realtime ----------------------------------------------------------
  useEffect(() => {
    if (!enabled) return undefined;

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const handleInsert = (payload: { new?: Record<string, unknown> | null }) => {
      const row = payload?.new;
      if (!row || typeof row !== 'object') return;

      const id = typeof row.id === 'string' ? row.id : null;
      const publishedAt =
        typeof row.published_at === 'string' ? row.published_at : null;
      const rowCategoryId =
        typeof row.category_id === 'string' ? row.category_id : null;

      if (!id) return;

      // Category filter must match the screen's current selection — done
      // client-side because the realtime filter syntax can't express
      // "any category" without a server-side view.
      const activeCategory = categoryIdRef.current;
      if (activeCategory && rowCategoryId !== activeCategory) return;

      // Skip rows that are not strictly newer than the head — guards
      // against backfill jobs that insert older articles.
      const since = latestTimestampRef.current;
      if (since && publishedAt && publishedAt <= since) return;

      // We have a minimal row from the realtime payload. Fetch the
      // hydrated version (with joined source/category) via the polling
      // path so the buffered article shape matches the rest of the feed.
      // This is cheap because `fetchArticlesNewerThan` returns at most
      // a handful of rows in the live case.
      const sinceForFetch = since ?? publishedAt ?? new Date(0).toISOString();
      void fetchArticlesNewerThan(sinceForFetch, {
        categoryId: activeCategory,
        limit: 10,
      })
        .then((fresh) => {
          if (cancelled) return;
          mergePending(fresh);
        })
        .catch(() => {
          // Swallow — the next polling tick will reconcile.
        });
    };

    channel = supabasePublic
      .channel(REALTIME_CHANNEL)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'articles' },
        handleInsert,
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (channel) void supabasePublic.removeChannel(channel);
    };
  }, [enabled, mergePending]);

  const consumePending = useCallback((): NewsArticle[] => {
    let drained: NewsArticle[] = [];
    setPendingArticles((prev) => {
      drained = prev;
      pendingIdsRef.current = new Set();
      return [];
    });
    return drained;
  }, []);

  const clearPending = useCallback(() => {
    setPendingArticles([]);
    pendingIdsRef.current = new Set();
  }, []);

  return {
    pendingArticles,
    pendingCount: pendingArticles.length,
    consumePending,
    clearPending,
  };
}
