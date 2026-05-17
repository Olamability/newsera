import { RealtimeChannel } from '@supabase/supabase-js';
import { supabaseAuth, supabasePublic } from './supabase';

type LikeEventPayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: { user_id?: string | null; reaction_type?: 'like' | 'dislike' | null } | null;
  old: { user_id?: string | null; reaction_type?: 'like' | 'dislike' | null } | null;
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

type ReactionEventPayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: { reaction_type?: 'like' | 'dislike' | null } | null;
  old: { reaction_type?: 'like' | 'dislike' | null } | null;
};

type SubscriberEntry<TPayload> = {
  channel: RealtimeChannel;
  callbacks: Set<(payload: TPayload) => void>;
};

type TrendingEventPayload = {
  articleId?: string;
};

const articleLikeEntries = new Map<string, SubscriberEntry<LikeEventPayload>>();
const articleCommentEntries = new Map<string, SubscriberEntry<CommentEventPayload>>();
const articleReactionEntries = new Map<string, SubscriberEntry<ReactionEventPayload>>();
let trendingEntry: { channel: RealtimeChannel; callbacks: Set<(payload: TrendingEventPayload) => void> } | null = null;

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

const isReactionEventPayload = (payload: unknown): payload is ReactionEventPayload => {
  return isRealtimeEventPayload(payload);
};

const extractReactionType = (row: unknown): 'like' | 'dislike' | null => {
  if (!row || typeof row !== 'object') return null;
  const reactionType = (row as { reaction_type?: unknown }).reaction_type;
  return reactionType === 'like' || reactionType === 'dislike' ? reactionType : null;
};

const extractTrendingArticleId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as {
    new?: { article_id?: string | null } | null;
    old?: { article_id?: string | null } | null;
  };
  // Prefer the "new" row on INSERT/UPDATE; fallback to "old" for DELETE.
  return value.new?.article_id ?? value.old?.article_id ?? undefined;
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
  await entry.channel.unsubscribe();
  await supabaseAuth.removeChannel(entry.channel);
};

const removeReactionChannel = async (key: string): Promise<void> => {
  const entry = articleReactionEntries.get(key);
  if (!entry) return;
  articleReactionEntries.delete(key);
  await supabasePublic.removeChannel(entry.channel);
};

export const subscribeToArticleLikeEvents = (
  articleId: string,
  onEvent: (payload: LikeEventPayload) => void,
): (() => void) => {
  const key = `article_reactions_like:${articleId}`;
  let entry = articleLikeEntries.get(key);

  if (!entry) {
    const callbacks = new Set<(payload: LikeEventPayload) => void>();
    const channel = supabasePublic
      .channel(`article_reactions_like_changes:${articleId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'article_reactions',
          filter: `article_id=eq.${articleId}`,
        },
        (payload) => {
          if (!isLikeEventPayload(payload)) return;
          const newType = extractReactionType(payload.new);
          const oldType = extractReactionType(payload.old);
          if (newType !== 'like' && oldType !== 'like') return;
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
    const channel = supabaseAuth
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

export const subscribeToArticleReactionEvents = (
  articleId: string,
  onEvent: (payload: ReactionEventPayload) => void,
): (() => void) => {
  const key = `article_reactions:${articleId}`;
  let entry = articleReactionEntries.get(key);

  if (!entry) {
    const callbacks = new Set<(payload: ReactionEventPayload) => void>();
    const channel = supabasePublic
      .channel(`article_reactions_changes:${articleId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'article_reactions',
          filter: `article_id=eq.${articleId}`,
        },
        (payload) => {
          if (!isReactionEventPayload(payload)) return;
          callbacks.forEach((callback) => callback(payload));
        },
      )
      .subscribe();

    entry = { channel, callbacks };
    articleReactionEntries.set(key, entry);
  }

  entry.callbacks.add(onEvent);

  return () => {
    const current = articleReactionEntries.get(key);
    if (!current) return;
    current.callbacks.delete(onEvent);
    if (current.callbacks.size === 0) {
      void removeReactionChannel(key);
    }
  };
};

export const subscribeToTrendingEngagementEvents = (
  onEvent: (payload: TrendingEventPayload) => void,
): (() => void) => {
  if (!trendingEntry) {
    const callbacks = new Set<(payload: TrendingEventPayload) => void>();
    const channel = supabasePublic
      .channel('trending_engagement_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_reactions' }, (payload) => {
        if (!isReactionEventPayload(payload)) return;
        const newType = extractReactionType(payload.new);
        const oldType = extractReactionType(payload.old);
        if (newType !== 'like' && oldType !== 'like') return;
        const articleId = extractTrendingArticleId(payload);
        callbacks.forEach((callback) => callback({ articleId }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_comments' }, (payload) => {
        const articleId = extractTrendingArticleId(payload);
        callbacks.forEach((callback) => callback({ articleId }));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'article_clicks' }, (payload) => {
        const articleId = extractTrendingArticleId(payload);
        callbacks.forEach((callback) => callback({ articleId }));
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
