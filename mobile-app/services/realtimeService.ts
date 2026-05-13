import { RealtimeChannel } from '@supabase/supabase-js';
import { supabasePublic } from './supabase';

type LikeEventPayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: { user_id?: string | null } | null;
  old: { user_id?: string | null } | null;
};

type CommentEventPayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: {
    id?: string | null;
    article_id?: string | null;
    user_id?: string | null;
    content?: string | null;
    parent_id?: string | null;
    likes_count?: number | null;
    created_at?: string | null;
  } | null;
  old: {
    id?: string | null;
    article_id?: string | null;
    user_id?: string | null;
    content?: string | null;
    parent_id?: string | null;
    likes_count?: number | null;
    created_at?: string | null;
  } | null;
};

type SubscriberEntry<TPayload> = {
  channel: RealtimeChannel;
  callbacks: Set<(payload: TPayload) => void>;
};

const articleLikeEntries = new Map<string, SubscriberEntry<LikeEventPayload>>();
const articleCommentEntries = new Map<string, SubscriberEntry<CommentEventPayload>>();
let trendingEntry: { channel: RealtimeChannel; callbacks: Set<() => void> } | null = null;

const isRealtimeEventPayload = (payload: unknown): payload is { eventType: unknown } => {
  if (!payload || typeof payload !== 'object') return false;
  const eventType = (payload as { eventType?: unknown }).eventType;
  return eventType === 'INSERT' || eventType === 'UPDATE' || eventType === 'DELETE';
};

const isLikeEventPayload = (payload: unknown): payload is LikeEventPayload => {
  return isRealtimeEventPayload(payload);
};

const isCommentEventPayload = (payload: unknown): payload is CommentEventPayload => {
  return isRealtimeEventPayload(payload);
};

const removeLikeChannel = async (key: string): Promise<void> => {
  const entry = articleLikeEntries.get(key);
  if (!entry) return;
  articleLikeEntries.delete(key);
  await supabasePublic.removeChannel(entry.channel);
};

const removeCommentChannel = async (key: string): Promise<void> => {
  const entry = articleCommentEntries.get(key);
  if (!entry) return;
  articleCommentEntries.delete(key);
  await supabasePublic.removeChannel(entry.channel);
};

export const subscribeToArticleLikeEvents = (
  articleId: string,
  onEvent: (payload: LikeEventPayload) => void,
): (() => void) => {
  const key = `article_likes:${articleId}`;
  let entry = articleLikeEntries.get(key);

  if (!entry) {
    const callbacks = new Set<(payload: LikeEventPayload) => void>();
    const channel = supabasePublic
      .channel(`article_likes_changes:${articleId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'article_likes',
          filter: `article_id=eq.${articleId}`,
        },
        (payload) => {
          if (!isLikeEventPayload(payload)) return;
          callbacks.forEach((callback) => callback(payload));
        },
      )
      .subscribe();

    entry = { channel, callbacks };
    articleLikeEntries.set(key, entry);
  }

  entry.callbacks.add(onEvent);

  return () => {
    const current = articleLikeEntries.get(key);
    if (!current) return;
    current.callbacks.delete(onEvent);
    if (current.callbacks.size === 0) {
      void removeLikeChannel(key);
    }
  };
};

export const subscribeToArticleCommentEvents = (
  articleId: string,
  onEvent: (payload: CommentEventPayload) => void,
): (() => void) => {
  const key = `article_comments:${articleId}`;
  let entry = articleCommentEntries.get(key);

  if (!entry) {
    const callbacks = new Set<(payload: CommentEventPayload) => void>();
    const channel = supabasePublic
      .channel(`article_comments_changes:${articleId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'article_comments',
          filter: `article_id=eq.${articleId}`,
        },
        (payload) => {
          if (!isCommentEventPayload(payload)) return;
          callbacks.forEach((callback) => callback(payload));
        },
      )
      .subscribe();

    entry = { channel, callbacks };
    articleCommentEntries.set(key, entry);
  }

  entry.callbacks.add(onEvent);

  return () => {
    const current = articleCommentEntries.get(key);
    if (!current) return;
    current.callbacks.delete(onEvent);
    if (current.callbacks.size === 0) {
      void removeCommentChannel(key);
    }
  };
};

export const subscribeToTrendingEngagementEvents = (onEvent: () => void): (() => void) => {
  if (!trendingEntry) {
    const callbacks = new Set<() => void>();
    const channel = supabasePublic
      .channel('trending_engagement_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_likes' }, () => {
        callbacks.forEach((callback) => callback());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_comments' }, () => {
        callbacks.forEach((callback) => callback());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_clicks' }, () => {
        callbacks.forEach((callback) => callback());
      })
      .subscribe();

    trendingEntry = { channel, callbacks };
  }

  trendingEntry.callbacks.add(onEvent);

  return () => {
    if (!trendingEntry) return;
    trendingEntry.callbacks.delete(onEvent);
    if (trendingEntry.callbacks.size === 0) {
      const stale = trendingEntry;
      trendingEntry = null;
      void supabasePublic.removeChannel(stale.channel);
    }
  };
};
