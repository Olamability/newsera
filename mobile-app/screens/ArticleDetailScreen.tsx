import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Animated,
  Alert,
  Easing,
  FlatList,
  Keyboard,
  LayoutAnimation,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Dimensions,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type KeyboardEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, NewsArticle } from '../types';
import { supabasePublic } from '../services/supabase';
import { getDeviceId } from '../services/deviceId';
import { saveRecentlyViewed } from '../services/recentlyViewedService';
import { checkAndNotifyBreakingNews } from '../services/notificationService';
import { isBookmarked, toggleBookmark } from '../services/bookmarkService';
import {
  ArticleReactionType,
  getArticleReactionSummary,
  toggleArticleReaction,
} from '../services/articleReactionService';
import {
  fetchCommentsPage,
  fetchCommentCount,
  addComment,
  ArticleComment,
  COMMENTS_PAGE_SIZE,
} from '../services/commentService';
import { fetchSimilarArticlesPage } from '../services/newsServicePublic';
import { useAuth } from '../context/AuthContext';
import { buildArticleShareContent, resolveArticleSourceName } from '../services/shareService';
import { sanitizeArticleContent } from '../services/articleUtils';
import { InteractionAuthRequiredError } from '../services/interactionErrors';
import { openArticleUrl } from '../services/outboundClickService';
import {
  subscribeToArticleCommentEvents,
  subscribeToArticleReactionEvents,
} from '../services/realtimeService';
import SkeletonCard from '../components/SkeletonCard';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;
type ThreadedComment = ArticleComment & { replies: ThreadedComment[] };
const MAX_PREVIEW_CHARS = 1400;
const COMMENT_BAR_HEIGHT = 102;
const SIMILAR_PAGE_SIZE = 10;
// Extra clearance so content isn't hidden behind the sticky comment bar
const STICKY_BAR_CLEARANCE = 8;
const COMMENTS_SHEET_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.88);
const REPLY_INDENT_PER_LEVEL = 16;
const MAX_REPLY_INDENT = 48;
const COMMENT_PAGINATION_SIZE = COMMENTS_PAGE_SIZE;
const OPTIMISTIC_COMMENT_PREFIX = 'optimistic-';
const FEED_IMAGE_BLURHASH = 'L6Pj0^i_.AyE_3t7t7R**0o#DgR4';
const INITIAL_ITEMS_TO_RENDER = 8;
const MAX_ITEMS_PER_BATCH = 8;
const FEED_WINDOW_SIZE = 9;
const BATCHING_PERIOD_MS = 60;
let optimisticCommentSequence = 0;

const buildArticlePreview = (snippet: string | null, content: string | null): string | null => {
  const sanitizedSnippet = sanitizeArticleContent(snippet);
  if (sanitizedSnippet) return sanitizedSnippet;

  if (!content) return null;
  const plainText = sanitizeArticleContent(content);
  if (!plainText) return null;

  return plainText.length > MAX_PREVIEW_CHARS
    ? `${plainText.slice(0, MAX_PREVIEW_CHARS).trimEnd()}…`
    : plainText;
};

const formatPublishedTime = (publishedAt: string | null | undefined): string | null => {
  if (!publishedAt) return null;

  const publishedDate = new Date(publishedAt);
  if (Number.isNaN(publishedDate.getTime())) return null;

  const diffMs = Math.max(0, Date.now() - publishedDate.getTime());
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 60) {
    const mins = Math.max(1, diffMinutes);
    return `${mins}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays <= 7) {
    return `${diffDays}d ago`;
  }

  return publishedDate.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const buildThreadedComments = (flat: ArticleComment[]): ThreadedComment[] => {
  const map = new Map<string, ThreadedComment>();
  flat.forEach((comment) => {
    map.set(comment.id, { ...comment, replies: [] });
  });

  const roots: ThreadedComment[] = [];
  map.forEach((comment) => {
    if (comment.parent_id && map.has(comment.parent_id)) {
      map.get(comment.parent_id)?.replies.push(comment);
      return;
    }
    roots.push(comment);
  });

  return roots;
};

const buildExpandedRepliesMap = (flat: ArticleComment[]): Record<string, boolean> => {
  const expanded: Record<string, boolean> = {};
  flat.forEach((comment) => {
    if (comment.parent_id) {
      expanded[comment.parent_id] = true;
    }
  });
  return expanded;
};

const formatRelativeTime = (dateInput: string | null | undefined): string => {
  if (!dateInput) return 'now';
  const value = new Date(dateInput);
  if (Number.isNaN(value.getTime())) return 'now';

  const diffMs = Math.max(0, Date.now() - value.getTime());
  const minutes = Math.floor(diffMs / (1000 * 60));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const getCommentAuthorLabel = (
  comment: ArticleComment,
  currentUserId?: string | null,
  currentUserEmail?: string | null,
): string => {
  if (currentUserId && comment.user_id === currentUserId) {
    return currentUserEmail ?? 'You';
  }
  return `User ${comment.user_id.slice(0, 8)}`;
};

const sortCommentsAscending = (items: ArticleComment[]): ArticleComment[] => (
  [...items].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
);

const generateOptimisticCommentId = (): string => {
  optimisticCommentSequence += 1;
  return `${OPTIMISTIC_COMMENT_PREFIX}${Date.now()}-${optimisticCommentSequence}`;
};

const isOptimisticComment = (commentId: string): boolean => commentId.startsWith(OPTIMISTIC_COMMENT_PREFIX);

const matchesOptimisticComment = (existing: ArticleComment, incoming: ArticleComment): boolean => (
  isOptimisticComment(existing.id)
  && existing.article_id === incoming.article_id
  && existing.user_id === incoming.user_id
  && existing.content === incoming.content
  && existing.parent_id === incoming.parent_id
  && existing.created_at === incoming.created_at
);

const removeMatchingOptimisticComment = (item: ArticleComment, incoming: ArticleComment): boolean => (
  item.id === incoming.id || !matchesOptimisticComment(item, incoming)
);

const upsertComment = (items: ArticleComment[], incoming: ArticleComment): ArticleComment[] => {
  const deduped = isOptimisticComment(incoming.id)
    ? items
    : items.filter((item) => removeMatchingOptimisticComment(item, incoming));
  const index = deduped.findIndex((item) => item.id === incoming.id);
  if (index === -1) return sortCommentsAscending([...deduped, incoming]);
  const next = [...deduped];
  next[index] = incoming;
  return sortCommentsAscending(next);
};

const ArticleDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { article } = route.params;
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const sourceName = resolveArticleSourceName(article);
  const sourceLogo = article.sources?.logo_url ?? null;
  const previewText = useMemo(() => buildArticlePreview(article.snippet, article.content), [article.content, article.snippet]);
  const publishedTimeText = useMemo(() => formatPublishedTime(article.published_at), [article.published_at]);
  const estimatedReadingTime = useMemo(() => {
    if (!previewText) return null;
    const wordCount = previewText.trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.round(wordCount / 200));
    return `${minutes} min read`;
  }, [previewText]);

  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [disliked, setDisliked] = useState(false);
  const [dislikeCount, setDislikeCount] = useState(0);
  const [likeLoading, setLikeLoading] = useState(false);
  const [dislikeLoading, setDislikeLoading] = useState(false);

  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [commentCount, setCommentCount] = useState(0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const [commentsHasMore, setCommentsHasMore] = useState(true);
  const [commentsSheetVisible, setCommentsSheetVisible] = useState(false);
  const [commentsInitialized, setCommentsInitialized] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});
  const [commentsKeyboardInset, setCommentsKeyboardInset] = useState(0);
  const commentsOffsetRef = useRef(0);
  const commentsRequestIdRef = useRef(0);
  const commentIdsRef = useRef<Set<string>>(new Set());
  const shimmerOpacity = useRef(new Animated.Value(0.35)).current;
  const likeScale = useRef(new Animated.Value(1)).current;
  const dislikeScale = useRef(new Animated.Value(1)).current;

  const [similarArticles, setSimilarArticles] = useState<NewsArticle[]>([]);
  const [similarHasMore, setSimilarHasMore] = useState(true);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const [similarImageFailures, setSimilarImageFailures] = useState<Record<string, boolean>>({});
  const similarPageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const seenIdsRef = useRef<string[]>([]);
  useEffect(() => {
    commentIdsRef.current = new Set(comments.map((comment) => comment.id));
  }, [comments]);

  useEffect(() => {
    if (!commentsSheetVisible) {
      setCommentsKeyboardInset(0);
      return undefined;
    }

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const handleKeyboardShow = (event: KeyboardEvent) => {
      const keyboardHeight = Math.max(0, event.endCoordinates.height);
      // iOS keyboard frames include the safe-area inset; Android already reports usable overlap.
      const keyboardOffset = keyboardHeight - (Platform.OS === 'ios' ? (insets.bottom ?? 0) : 0);
      setCommentsKeyboardInset(Math.max(0, keyboardOffset));
    };

    const handleKeyboardHide = () => {
      setCommentsKeyboardInset(0);
    };

    const showSubscription = Keyboard.addListener(showEvent, handleKeyboardShow);
    const hideSubscription = Keyboard.addListener(hideEvent, handleKeyboardHide);

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [commentsSheetVisible, insets.bottom]);

  // Save to recently viewed and check for breaking news on screen mount
  useEffect(() => {
    saveRecentlyViewed(article);
    checkAndNotifyBreakingNews(article);
  }, [article]);

  useEffect(() => {
    if (!commentsLoading) {
      shimmerOpacity.stopAnimation();
      shimmerOpacity.setValue(0.35);
      return;
    }

    const shimmerLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerOpacity, {
          toValue: 0.95,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(shimmerOpacity, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    shimmerLoop.start();
    return () => {
      shimmerLoop.stop();
      shimmerOpacity.stopAnimation();
      shimmerOpacity.setValue(0.35);
    };
  }, [commentsLoading, shimmerOpacity]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('blur', () => {
      Keyboard.dismiss();
      setCommentText('');
      setReplyingToCommentId(null);
      setCommentSubmitting(false);
      setCommentsSheetVisible(false);
    });
    return unsubscribe;
  }, [navigation]);

  // Load bookmark state for authenticated users
  useEffect(() => {
    if (!user) return;
    isBookmarked(article.id, user.id)
      .then(setBookmarked)
      .catch(() => { });
  }, [article.id, user]);

  const promptSignInForInteraction = useCallback((action: 'like' | 'comment' | 'reply') => {
    Alert.alert(
      'Sign in required',
      `You need to be logged in to ${action}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign In',
          onPress: () => navigation.navigate('Login', {
            redirectTo: 'ArticleDetail',
            redirectParams: { article },
          }),
        },
      ]
    );
  }, [navigation, article]);

  const loadReactionSummary = useCallback(async () => {
    try {
      const summary = await getArticleReactionSummary(article.id);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setLikeCount(summary.likeCount);
      setDislikeCount(summary.dislikeCount);
      setLiked(summary.userReaction === 'like');
      setDisliked(summary.userReaction === 'dislike');
    } catch {
      setLikeCount(0);
      setDislikeCount(0);
      setLiked(false);
      setDisliked(false);
    }
  }, [article.id]);

  // Load reaction state and count
  useEffect(() => {
    void loadReactionSummary();
  }, [loadReactionSummary, user]);

  // Near real-time reaction count refresh (singleton-managed subscription)
  useEffect(() => {
    return subscribeToArticleReactionEvents(article.id, () => {
      void loadReactionSummary();
    });
  }, [article.id, loadReactionSummary]);

  const loadInitialComments = useCallback(async () => {
    const requestId = commentsRequestIdRef.current + 1;
    commentsRequestIdRef.current = requestId;
    setCommentsLoading(true);
    setCommentsLoadingMore(false);
    setCommentsHasMore(true);
    commentsOffsetRef.current = 0;

    try {
      const [{ comments: loaded, hasMore }, count] = await Promise.all([
        fetchCommentsPage(article.id, 0, COMMENT_PAGINATION_SIZE),
        fetchCommentCount(article.id),
      ]);
      if (commentsRequestIdRef.current !== requestId) return;
      setComments(loaded);
      setExpandedReplies(buildExpandedRepliesMap(loaded));
      setCommentsHasMore(hasMore);
      setCommentCount(count);
      commentsOffsetRef.current = loaded.length;
      setCommentsInitialized(true);
    } catch (err) {
      if (__DEV__) console.log('[Comments] Failed to load initial comments:', err);
      if (commentsRequestIdRef.current === requestId) {
        setComments([]);
        setCommentsHasMore(false);
        setCommentsInitialized(true);
      }
    } finally {
      if (commentsRequestIdRef.current === requestId) {
        setCommentsLoading(false);
      }
    }
  }, [article.id]);

  const loadCommentCount = useCallback(async () => {
    try {
      const count = await fetchCommentCount(article.id);
      setCommentCount(count);
    } catch (err) {
      if (__DEV__) console.log('[Comments] Failed to load comment count:', err);
      setCommentCount(0);
    }
  }, [article.id]);

  const loadMoreComments = useCallback(async () => {
    if (commentsLoading || commentsLoadingMore || !commentsHasMore) return;
    setCommentsLoadingMore(true);
    try {
      const { comments: loaded, hasMore } = await fetchCommentsPage(
        article.id,
        commentsOffsetRef.current,
        COMMENT_PAGINATION_SIZE,
      );
      let nextCommentsSnapshot: ArticleComment[] = [];
      setComments((prev) => {
        const existing = new Set(prev.map((item) => item.id));
        const deduped = loaded.filter((item) => !existing.has(item.id));
        const next = sortCommentsAscending([...prev, ...deduped]);
        nextCommentsSnapshot = next;
        return next;
      });
      setExpandedReplies((current) => ({ ...buildExpandedRepliesMap(nextCommentsSnapshot), ...current }));
      commentsOffsetRef.current += loaded.length;
      setCommentsHasMore(hasMore);
    } catch (err) {
      if (__DEV__) console.log('[Comments] Failed to load more comments:', err);
    } finally {
      setCommentsLoadingMore(false);
    }
  }, [article.id, commentsHasMore, commentsLoading, commentsLoadingMore]);

  useEffect(() => {
    void loadCommentCount();
  }, [loadCommentCount]);

  // Near real-time comments updates (singleton-managed subscription)
  useEffect(() => {
    return subscribeToArticleCommentEvents(article.id, (payload) => {
      if (__DEV__) console.log('[Comments] Realtime event:', payload.eventType, payload);

      if (payload.eventType === 'DELETE') {
        const deletedId = payload.old?.id;
        if (!deletedId) return;
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setCommentCount((prev) => Math.max(0, prev - 1));
        setComments((prev) => prev.filter((item) => item.id !== deletedId));
        return;
      }

      const row = payload.new;
      if (!row?.id || !row.article_id || !row.user_id || !row.content || !row.created_at) return;

      const incoming: ArticleComment = {
        id: row.id,
        article_id: row.article_id,
        user_id: row.user_id,
        content: row.content,
        parent_id: row.parent_id ?? null,
        likes_count: row.likes_count ?? 0,
        created_at: row.created_at,
      };

      if (payload.eventType === 'INSERT') {
        if (!commentIdsRef.current.has(incoming.id)) {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setCommentCount((prev) => prev + 1);
        }
      }

      if (!commentsInitialized) return;
      setComments((prev) => upsertComment(prev, incoming));
      if (incoming.parent_id) {
        setExpandedReplies((prev) => ({ ...prev, [incoming.parent_id!]: true }));
      }
    });
  }, [article.id, commentsInitialized]);

  // Load "Read More Like This" recommendations — initial page
  useEffect(() => {
    setSimilarArticles([]);
    setSimilarHasMore(true);
    similarPageRef.current = 1;
    seenIdsRef.current = [];
    setSimilarImageFailures({});

    (async () => {
      setSimilarLoadingMore(true);
      try {
        const { articles, hasMore } = await fetchSimilarArticlesPage(
          article.id, article.category_id, article.source_id, 1, SIMILAR_PAGE_SIZE, []
        );
        setSimilarArticles(articles);
        setSimilarHasMore(hasMore);
        similarPageRef.current = 2;
        seenIdsRef.current = articles.map((a) => a.id);
      } catch (err) {
        console.error('[Similar] Initial fetch failed:', err);
        setSimilarHasMore(false);
      }
      setSimilarLoadingMore(false);
    })();
  }, [article.id, article.category_id, article.source_id]);

  const triggerTapFeedback = useCallback((value: Animated.Value) => {
    Animated.sequence([
      Animated.spring(value, {
        toValue: 0.9,
        useNativeDriver: true,
        speed: 30,
        bounciness: 8,
      }),
      Animated.spring(value, {
        toValue: 1,
        useNativeDriver: true,
        speed: 30,
        bounciness: 12,
      }),
    ]).start();
  }, []);

  const handleReaction = useCallback(async (reaction: ArticleReactionType) => {
    if (!user) {
      promptSignInForInteraction('like');
      return;
    }

    if (reaction === 'like') {
      triggerTapFeedback(likeScale);
    } else {
      triggerTapFeedback(dislikeScale);
    }

    const previousLiked = liked;
    const previousDisliked = disliked;
    const previousLikeCount = likeCount;
    const previousDislikeCount = dislikeCount;
    const nextLiked = reaction === 'like' ? !liked : false;
    const nextDisliked = reaction === 'dislike' ? !disliked : false;

    if (reaction === 'like') {
      setLikeLoading(true);
    } else {
      setDislikeLoading(true);
    }

    setLiked(nextLiked);
    setDisliked(nextDisliked);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLikeCount((prev) => Math.max(0, prev + (
      (nextLiked && !previousLiked ? 1 : 0)
      - (!nextLiked && previousLiked ? 1 : 0)
    )));
    setDislikeCount((prev) => Math.max(0, prev + (
      (nextDisliked && !previousDisliked ? 1 : 0)
      - (!nextDisliked && previousDisliked ? 1 : 0)
    )));

    try {
      const confirmed = await toggleArticleReaction(article.id, reaction);
      setLiked(confirmed === 'like');
      setDisliked(confirmed === 'dislike');
      await loadReactionSummary();
    } catch (err) {
      setLiked(previousLiked);
      setDisliked(previousDisliked);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setLikeCount(previousLikeCount);
      setDislikeCount(previousDislikeCount);
      if (err instanceof InteractionAuthRequiredError) {
        promptSignInForInteraction('like');
      } else {
        Alert.alert('Error', 'Failed to update reaction. Please try again.');
      }
    } finally {
      setLikeLoading(false);
      setDislikeLoading(false);
    }
  }, [
    user,
    promptSignInForInteraction,
    likeScale,
    dislikeScale,
    liked,
    disliked,
    likeCount,
    dislikeCount,
    article.id,
    loadReactionSummary,
    triggerTapFeedback,
  ]);

  const handleAddComment = useCallback(async () => {
    const text = commentText.trim();
    if (!text) return;
    if (!user?.id) {
      promptSignInForInteraction(replyingToCommentId ? 'reply' : 'comment');
      return;
    }

    const parentId = replyingToCommentId;
    const createdAt = new Date().toISOString();
    const optimisticId = generateOptimisticCommentId();
    const optimisticComment: ArticleComment = {
      id: optimisticId,
      article_id: article.id,
      user_id: user.id,
      content: text,
      parent_id: parentId,
      likes_count: 0,
      created_at: createdAt,
    };

    setCommentSubmitting(true);
    setCommentText('');
    setReplyingToCommentId(null);
    setComments((prev) => upsertComment(prev, optimisticComment));
    if (parentId) {
      setExpandedReplies((prev) => ({ ...prev, [parentId]: true }));
    }

    try {
      const inserted = await addComment(article.id, text, parentId, createdAt);
      setComments((prev) => {
        const withoutOptimistic = prev.filter((comment) => comment.id !== optimisticId);
        return upsertComment(withoutOptimistic, inserted);
      });
    } catch (err) {
      setComments((prev) => prev.filter((comment) => comment.id !== optimisticId));
      if (err instanceof InteractionAuthRequiredError) {
        setCommentText(text);
        setReplyingToCommentId(parentId);
        promptSignInForInteraction(parentId ? 'reply' : 'comment');
      } else {
        if (__DEV__) console.log('[Comments] Failed to post comment:', err);
        if (__DEV__ && err && typeof err === 'object' && 'message' in err) {
          console.log('[Comments] Supabase error message:', (err as { message?: string }).message);
        }
        setCommentText(text);
        setReplyingToCommentId(parentId);
        Alert.alert('Error', 'Failed to post comment. Please try again.');
      }
    } finally {
      setCommentSubmitting(false);
    }
  }, [article.id, commentText, replyingToCommentId, promptSignInForInteraction, user]);

  const openCommentsSheet = useCallback(() => {
    setCommentsSheetVisible(true);
    if (!commentsInitialized && !commentsLoading) {
      void loadInitialComments();
    }
  }, [commentsInitialized, commentsLoading, loadInitialComments]);

  const closeCommentsSheet = useCallback(() => {
    Keyboard.dismiss();
    setCommentsSheetVisible(false);
    setReplyingToCommentId(null);
  }, []);

  const toggleReplies = useCallback((commentId: string) => {
    setExpandedReplies((prev) => ({
      ...prev,
      [commentId]: !(prev[commentId] ?? true),
    }));
  }, []);

  const handleBookmark = useCallback(async () => {
    if (!user) {
      Alert.alert(
        'Sign in required',
        'Please sign in to bookmark articles.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign In',
            onPress: () => navigation.navigate('Login', {
              redirectTo: 'ArticleDetail',
              redirectParams: { article },
            }),
          },
        ]
      );
      return;
    }

    setBookmarkLoading(true);
    try {
      const next = await toggleBookmark(article.id, user.id);
      setBookmarked(next);
    } catch (err) {
      console.error('[Bookmark] Toggle failed:', err);
      Alert.alert('Error', 'Failed to update bookmark. Please try again.');
    } finally {
      setBookmarkLoading(false);
    }
  }, [user, article.id, navigation, article]);

  const handleShare = useCallback(async () => {
    try {
      await Share.share(buildArticleShareContent(article));
    } catch (err) {
      console.warn('[Share] Failed:', err);
    }
  }, [article]);

  const handleReport = useCallback(() => {
    Alert.alert('Report', 'Thanks. We have received your report.');
  }, []);

  const handleHeaderMenu = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Favourite', 'Report', 'Share'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            void handleBookmark();
          } else if (buttonIndex === 2) {
            handleReport();
          } else if (buttonIndex === 3) {
            void handleShare();
          }
        }
      );
      return;
    }

    Alert.alert('Actions', undefined, [
      { text: 'Favourite', onPress: () => void handleBookmark() },
      { text: 'Report', onPress: handleReport },
      { text: 'Share', onPress: () => void handleShare() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [handleBookmark, handleReport, handleShare]);

  const handleReadFull = useCallback(async () => {
    // ── Step 1: Internal engagement tracking (personalization / trending) ──────
    // This logs to `article_clicks`, which drives the trending score and the
    // user interest personalisation engine. It is fully separate from the new
    // outbound click tracking below.
    try {
      // Prefer authenticated user ID; fall back to device ID for guest users
      const trackingId = user?.id ?? (await getDeviceId());

      // Dedup: skip insert if this user/device already clicked this article in the last 30 seconds
      const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
      const { data: recent } = await supabasePublic
        .from('article_clicks')
        .select('id')
        .eq('article_id', article.id)
        .eq('device_id', trackingId)
        .gte('clicked_at', thirtySecsAgo)
        .limit(1);

      if (!recent || recent.length === 0) {
        await supabasePublic.from('article_clicks').insert({
          article_id: article.id,
          source_id: article.source_id,
          device_id: trackingId,
        });

        // Atomically insert or increment the user interest score for this category
        if (article.category_id) {
          await supabasePublic.rpc('increment_user_interest', {
            p_user_id: trackingId,
            p_category_id: article.category_id,
          });
        }
      }

      // ── Step 2: Outbound click tracking + UTM injection + browser open ──────
      // openArticleUrl does three things atomically:
      //   a) Appends ?utm_source=newsera&utm_medium=aggregator&utm_campaign=feed
      //   b) Logs to `article_outbound_clicks` (fire-and-forget, never blocks)
      //   c) Opens the browser with the UTM-tagged URL
      await openArticleUrl({
        rawUrl: article.url,
        articleId: article.id,
        sourceId: article.source_id,
        userId: user?.id ?? null,
        deviceId: trackingId,
      });
    } catch (_) {
      // If internal tracking throws before openArticleUrl, fall back to a
      // plain open so the user always reaches the publisher's site.
      try {
        const deviceId = await getDeviceId();
        await openArticleUrl({
          rawUrl: article.url,
          articleId: article.id,
          sourceId: article.source_id,
          userId: user?.id ?? null,
          deviceId,
        });
      } catch {
        // absolute last resort — tracking failure must never strand the user
      }
    }
  }, [user, article.id, article.source_id, article.category_id, article.url]);

  const loadMoreSimilar = useCallback(async () => {
    if (!similarHasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setSimilarLoadingMore(true);
    try {
      const { articles, hasMore } = await fetchSimilarArticlesPage(
        article.id, article.category_id, article.source_id,
        similarPageRef.current, SIMILAR_PAGE_SIZE, seenIdsRef.current
      );
      setSimilarArticles((prev) => [...prev, ...articles]);
      setSimilarHasMore(hasMore);
      similarPageRef.current += 1;
      seenIdsRef.current = [...seenIdsRef.current, ...articles.map((a) => a.id)];
    } catch (err) {
      console.error('[Similar] Load more failed:', err);
    }
    setSimilarLoadingMore(false);
    loadingMoreRef.current = false;
  }, [article.id, article.category_id, article.source_id, similarHasMore]);

  const handleEndReached = useCallback(() => {
    void loadMoreSimilar();
  }, [loadMoreSimilar]);
  const handleCommentsEndReached = useCallback(() => {
    void loadMoreComments();
  }, [loadMoreComments]);
  const similarKeyExtractor = useCallback((item: NewsArticle) => item.id, []);
  const commentKeyExtractor = useCallback((item: ThreadedComment) => item.id, []);

  const handleSimilarImageError = useCallback((articleId: string) => {
    setSimilarImageFailures((prev) => {
      if (prev[articleId]) return prev;
      return { ...prev, [articleId]: true };
    });
  }, []);

  const threadedComments = useMemo(() => buildThreadedComments(comments), [comments]);

  const renderCommentNode = useCallback((comment: ThreadedComment, depth: number = 0): React.ReactNode => {
    const hasReplies = comment.replies.length > 0;
    const repliesExpanded = expandedReplies[comment.id] ?? true;
    const indent = Math.min(depth * REPLY_INDENT_PER_LEVEL, MAX_REPLY_INDENT);
    const authorLabel = getCommentAuthorLabel(comment, user?.id, user?.email);
    const avatarSeed = authorLabel.trim()[0]?.toUpperCase() || 'U';

    return (
      <View key={comment.id} style={{ marginLeft: indent }}>
        <View style={[styles.commentItem, depth > 0 && styles.replyCommentItem]}>
          <View style={styles.commentHeader}>
            <View style={styles.commentIdentityRow}>
              <View style={styles.commentAvatar}>
                <Text style={styles.commentAvatarText}>{avatarSeed}</Text>
              </View>
              <View style={styles.commentMeta}>
                <Text style={styles.commentUser}>{authorLabel}</Text>
                <Text style={styles.commentDate}>{formatRelativeTime(comment.created_at)}</Text>
              </View>
            </View>
          </View>
          <Text style={styles.commentContent}>{comment.content}</Text>
          <View style={styles.commentActionsRow}>
            <TouchableOpacity
              onPress={() => {
                if (!user?.id) {
                  promptSignInForInteraction('reply');
                  return;
                }
                setReplyingToCommentId(comment.id);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.commentActionText}>Reply</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => Alert.alert('Coming soon', 'Comment likes will be available soon.')}
              activeOpacity={0.7}
            >
              <Text style={styles.commentActionText}>Like</Text>
            </TouchableOpacity>
            {hasReplies ? (
              <TouchableOpacity onPress={() => toggleReplies(comment.id)} activeOpacity={0.7}>
                <Text style={styles.commentActionText}>
                  {repliesExpanded ? 'Hide replies' : `View replies (${comment.replies.length})`}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        {hasReplies && repliesExpanded ? comment.replies.map((reply) => renderCommentNode(reply, depth + 1)) : null}
      </View>
    );
  }, [expandedReplies, promptSignInForInteraction, toggleReplies, user?.email, user?.id]);

  const renderSimilarItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <TouchableOpacity
        style={styles.similarCard}
        onPress={() => navigation.replace('ArticleDetail', { article: item })}
        activeOpacity={0.85}
      >
        {item.image_url && !similarImageFailures[item.id] ? (
          <Image
            source={{ uri: item.image_url }}
            style={styles.similarImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            placeholder={{ blurhash: FEED_IMAGE_BLURHASH }}
            transition={200}
            onError={() => handleSimilarImageError(item.id)}
          />
        ) : (
          <View style={[styles.similarImage, styles.similarImagePlaceholder]} />
        )}
        <View style={styles.similarCardContent}>
          <Text style={styles.similarCardTitle} numberOfLines={3}>
            {item.title}
          </Text>
          <Text style={styles.similarCardSource} numberOfLines={1}>
            {item.source_name ?? item.sources?.name ?? ''}
          </Text>
        </View>
      </TouchableOpacity>
    ),
    [navigation, similarImageFailures, handleSimilarImageError]
  );

  const renderThreadedCommentItem = useCallback(
    ({ item }: { item: ThreadedComment }) => <>{renderCommentNode(item)}</>,
    [renderCommentNode]
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar style="dark" />

      {/* ── Custom Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={26} color="#1a1a1a" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.headerBtn}
            onPress={() => navigation.navigate('MainTabs')}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="home" size={22} color="#1a1a1a" />
          </TouchableOpacity>
        </View>

        <View style={styles.headerCenter}>
          <Text style={styles.headerSource} numberOfLines={1} ellipsizeMode="tail">
            {sourceName}
          </Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={handleHeaderMenu}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="ellipsis-vertical" size={20} color="#1a1a1a" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Main scrollable area + sticky comment bar ── */}
      <View style={styles.flex}>
        <FlatList
          data={similarArticles}
          keyExtractor={similarKeyExtractor}
          style={styles.flex}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: COMMENT_BAR_HEIGHT + insets.bottom + STICKY_BAR_CLEARANCE },
          ]}
          showsVerticalScrollIndicator={false}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          initialNumToRender={INITIAL_ITEMS_TO_RENDER}
          maxToRenderPerBatch={MAX_ITEMS_PER_BATCH}
          windowSize={FEED_WINDOW_SIZE}
          updateCellsBatchingPeriod={BATCHING_PERIOD_MS}
          removeClippedSubviews
          ListHeaderComponent={
            <>
              <View style={styles.headerBody}>
                {/* 1. Headline */}
                <Text style={styles.title}>{article.title}</Text>

                {/* 2. Metadata Row: source+logo left · timestamp+reading-time right */}
                <View style={styles.metaRow}>
                  <View style={styles.metaLeft}>
                    {sourceLogo ? (
                      <Image
                        source={{ uri: sourceLogo }}
                        style={styles.sourceLogo}
                        contentFit="contain"
                        cachePolicy="memory-disk"
                        transition={200}
                      />
                    ) : (
                      <View style={styles.sourceLogoPlaceholder}>
                        <Text style={styles.sourceLogoPlaceholderText}>
                          {sourceName.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.source} numberOfLines={1}>{sourceName}</Text>
                  </View>
                  <View style={styles.metaRight}>
                    {publishedTimeText ? (
                      <Text style={styles.sourceMetaText}>{publishedTimeText}</Text>
                    ) : null}
                    {estimatedReadingTime ? (
                      <Text style={styles.readingTime}>{estimatedReadingTime}</Text>
                    ) : null}
                  </View>
                </View>
              </View>

              {/* 3. Featured Image */}
              {article.image_url ? (
                <Image
                  source={{ uri: article.image_url }}
                  style={styles.featuredImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  placeholder={{ blurhash: FEED_IMAGE_BLURHASH }}
                  transition={300}
                />
              ) : null}

              <View style={styles.contentBody}>
                <View style={styles.contentDivider} />

                {/* 4. Article Snippet / Content */}
                {previewText ? (
                  <Text style={styles.articleContent}>{previewText}</Text>
                ) : null}

                {/* 5. Read Full Article */}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.button}
                    onPress={handleReadFull}
                    activeOpacity={0.85}
                  >
                    <View style={styles.buttonInner}>
                      <Ionicons name="open-outline" size={17} color="#fff" />
                      <Text style={styles.buttonText}>Read Full Article</Text>
                    </View>
                  </TouchableOpacity>

                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      style={[
                        styles.bookmarkBtn,
                        bookmarked && styles.bookmarkBtnActive,
                        bookmarkLoading && styles.bookmarkBtnDisabled,
                      ]}
                      onPress={handleBookmark}
                      disabled={bookmarkLoading}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.bookmarkText, bookmarked && styles.bookmarkTextActive]}>
                        {bookmarked ? '🔖 Saved' : '🔖 Bookmark'}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.likeBtn,
                        liked && styles.likeBtnActive,
                        likeLoading && styles.likeBtnDisabled,
                      ]}
                      onPress={() => void handleReaction('like')}
                      disabled={likeLoading}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.likeText, liked && styles.likeTextActive]}>
                        {liked ? '❤️' : '🤍'} {likeCount > 0 ? likeCount : ''}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.shareBtn}
                      onPress={handleShare}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.shareText}>↗ Share</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* 6. "Read More Like This" section header */}
                <View style={styles.similarSection}>
                  <Text style={styles.similarTitle}>Read More</Text>
                </View>

                {/* Skeleton placeholder while first page loads */}
                {similarLoadingMore && similarArticles.length === 0 ? (
                  <>
                    <SkeletonCard />
                    <SkeletonCard />
                    <SkeletonCard />
                  </>
                ) : null}
              </View>
            </>
          }
          renderItem={renderSimilarItem}
          ListFooterComponent={
            <>
              {/* Skeleton while loading next page */}
              {similarLoadingMore && similarArticles.length > 0 ? (
                <>
                  <SkeletonCard />
                  <SkeletonCard />
                </>
              ) : null}
            </>
          }
        />

        {/* ── Sticky Engagement Bar (fixed above Android nav) ── */}
        <View
          style={[
            styles.stickyBar,
            { paddingBottom: Math.max(insets.bottom, STICKY_BAR_CLEARANCE) },
          ]}
        >
          <TouchableOpacity
            style={styles.stickyInputButton}
            onPress={openCommentsSheet}
            activeOpacity={0.85}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={18} color="#8b8b8b" />
            <Text style={styles.stickyInputButtonText}>Write a comment...</Text>
          </TouchableOpacity>

          <View style={styles.stickyActionRow}>
            <TouchableOpacity style={styles.stickyActionBtn} onPress={openCommentsSheet} activeOpacity={0.8}>
              <Text style={styles.stickyActionText}>💬 {commentCount}</Text>
            </TouchableOpacity>

            <Animated.View style={{ transform: [{ scale: likeScale }] }}>
              <TouchableOpacity
                style={[styles.stickyActionBtn, liked && styles.stickyActionBtnActive]}
                onPress={() => void handleReaction('like')}
                disabled={likeLoading}
                activeOpacity={0.8}
              >
                <Text style={[styles.stickyActionText, liked && styles.stickyActionTextActive]}>
                  👍 {likeCount > 0 ? likeCount : ''}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            <Animated.View style={{ transform: [{ scale: dislikeScale }] }}>
              <TouchableOpacity
                style={[styles.stickyActionBtn, disliked && styles.stickyActionBtnActive]}
                onPress={() => void handleReaction('dislike')}
                disabled={dislikeLoading}
                activeOpacity={0.8}
              >
                <Text style={[styles.stickyActionText, disliked && styles.stickyActionTextActive]}>
                  👎 {dislikeCount > 0 ? dislikeCount : ''}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            <TouchableOpacity style={styles.stickyActionBtn} onPress={handleShare} activeOpacity={0.8}>
              <Text style={styles.stickyActionText}>↗ Share</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Modal
          visible={commentsSheetVisible}
          animationType="slide"
          transparent
          statusBarTranslucent
          onRequestClose={closeCommentsSheet}
        >
          <Pressable style={styles.commentsSheetBackdrop} onPress={closeCommentsSheet} />
          <View
            style={[
              styles.commentsSheetContainer,
              {
                bottom: commentsKeyboardInset,
                paddingBottom: Math.max(insets.bottom, 10),
              },
            ]}
          >
            <View style={styles.commentsSheetHandle} />
            <View style={styles.commentsSheetHeader}>
              <Text style={styles.commentsSheetTitle}>Comments</Text>
              <Text style={styles.commentsSheetCount}>{commentCount}</Text>
            </View>

            <View style={styles.commentsSheetBody}>
              {commentsLoading ? (
                <View style={styles.commentSkeletonList}>
                  {[0, 1, 2].map((index) => (
                    <Animated.View
                      key={`comment-skeleton-${index}`}
                      style={[styles.commentSkeletonItem, { opacity: shimmerOpacity }]}
                    >
                      <View style={styles.commentSkeletonAvatar} />
                      <View style={styles.commentSkeletonContent}>
                        <View style={styles.commentSkeletonLineShort} />
                        <View style={styles.commentSkeletonLineLong} />
                        <View style={styles.commentSkeletonLineMedium} />
                      </View>
                    </Animated.View>
                  ))}
                </View>
              ) : comments.length === 0 ? (
                <Text style={styles.noComments}>No comments yet. Be the first!</Text>
              ) : (
                <FlatList
                  data={threadedComments}
                  keyExtractor={commentKeyExtractor}
                  renderItem={renderThreadedCommentItem}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.commentsSheetListContent}
                  onEndReached={handleCommentsEndReached}
                  onEndReachedThreshold={0.4}
                  keyboardShouldPersistTaps="handled"
                  initialNumToRender={INITIAL_ITEMS_TO_RENDER}
                  maxToRenderPerBatch={MAX_ITEMS_PER_BATCH}
                  windowSize={FEED_WINDOW_SIZE}
                  updateCellsBatchingPeriod={BATCHING_PERIOD_MS}
                  removeClippedSubviews
                  ListFooterComponent={commentsLoadingMore ? (
                    <Text style={styles.commentsLoadingMore}>Loading more comments…</Text>
                  ) : null}
                />
              )}
            </View>

            <View>
              {replyingToCommentId ? (
                <View style={styles.replyingBanner}>
                  <Text style={styles.replyingBannerText}>Replying in thread</Text>
                  <TouchableOpacity onPress={() => setReplyingToCommentId(null)} activeOpacity={0.75}>
                    <Text style={styles.replyingBannerCancel}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              <View style={styles.commentsComposer}>
                <TextInput
                  style={styles.commentsComposerInput}
                  placeholder={replyingToCommentId ? 'Write a reply…' : 'Write a comment…'}
                  placeholderTextColor="#9a9a9a"
                  value={commentText}
                  onChangeText={setCommentText}
                  editable={!commentSubmitting}
                  maxLength={500}
                  multiline
                />
                <TouchableOpacity
                  style={[
                    styles.commentsComposerSendBtn,
                    (!commentText.trim() || commentSubmitting) && styles.stickyPostBtnDisabled,
                  ]}
                  onPress={() => void handleAddComment()}
                  disabled={!commentText.trim() || commentSubmitting}
                  activeOpacity={0.85}
                >
                  <Text style={styles.commentsComposerSendText}>Send</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
  flex: {
    flex: 1,
  },
  // ── Custom Header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 88,
    gap: 4,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  headerRight: {
    width: 88,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  headerSource: {
    fontSize: 14,
    color: '#555',
    fontWeight: '600',
    textAlign: 'center',
    maxWidth: '100%',
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  listContent: {
    backgroundColor: '#fff',
  },
  headerBody: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 4,
  },
  contentBody: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 4,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111',
    lineHeight: 26,
    letterSpacing: -0.3,
    marginBottom: 14,
  },
  // ── Metadata Row ──
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 8,
  },
  metaLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  metaRight: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  readingTime: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 2,
  },
  contentDivider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginBottom: 18,
  },
  sourceLogo: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f2f2f2',
  },
  sourceLogoPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f2',
  },
  sourceLogoPlaceholderText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '700',
  },
  sourceMetaWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  source: {
    fontSize: 14,
    color: '#303030',
    fontWeight: '700',
    flexShrink: 1,
  },
  sourceMetaText: {
    fontSize: 12,
    color: '#7a7a7a',
  },
  featuredImage: {
    width: '100%',
    height: 240,
    backgroundColor: '#f1f1f1',
  },
  articleContent: {
    textAlign: 'justify',
    fontSize: 17,
    color: '#242424',
    lineHeight: 29,
    letterSpacing: 0.1,
    marginBottom: 4,
  },
  actions: {
    gap: 15,
    marginBottom: 4,
  },
  button: {
    backgroundColor: '#e63946',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#e63946',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
    }),
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bookmarkBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#e63946',
    backgroundColor: '#fff',
  },
  bookmarkBtnActive: {
    backgroundColor: '#fff5f6',
  },
  bookmarkBtnDisabled: {
    opacity: 0.6,
  },
  bookmarkText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e63946',
  },
  bookmarkTextActive: {
    color: '#e63946',
  },
  likeBtn: {
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#e63946',
    backgroundColor: '#fff',
  },
  likeBtnActive: {
    backgroundColor: '#fff5f6',
  },
  likeBtnDisabled: {
    opacity: 0.6,
  },
  likeText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e63946',
  },
  likeTextActive: {
    color: '#e63946',
  },
  shareBtn: {
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#e63946',
    backgroundColor: '#fff',
  },
  shareText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e63946',
  },
  // ── Read More Like This ──
  similarSection: {
    marginTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 20,
  },
  similarTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  // Horizontal card: image left, content right
  similarCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
    }),
  },
  similarImage: {
    width: 100,
    height: 90,
    borderRadius: 10,
    backgroundColor: '#e8e8e8',
  },
  similarImagePlaceholder: {
    backgroundColor: '#e8e8e8',
  },
  similarCardContent: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'space-between',
    minHeight: 90,
  },
  similarCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1a1a1a',
    lineHeight: 18,
    flex: 1,
  },
  similarCardSource: {
    fontSize: 11,
    color: '#888',
    marginTop: 6,
  },
  // ── Comments ──
  noComments: {
    fontSize: 14,
    color: '#aaa',
    marginTop: 20,
    textAlign: 'center',
  },
  commentItem: {
    marginBottom: 14,
    backgroundColor: '#f9f9f9',
    borderRadius: 10,
    padding: 12,
  },
  replyCommentItem: {
    backgroundColor: '#fcfcfc',
    borderLeftWidth: 2,
    borderLeftColor: '#ececec',
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  commentIdentityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  commentAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e7e7e7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#666',
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentUser: {
    fontSize: 13,
    fontWeight: '700',
    color: '#555',
  },
  commentDate: {
    fontSize: 12,
    color: '#aaa',
  },
  commentContent: {
    fontSize: 14,
    color: '#333',
    lineHeight: 21,
  },
  commentActionsRow: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 16,
  },
  commentActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6f6f6f',
  },
  commentSkeletonList: {
    gap: 10,
  },
  commentSkeletonItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f7f7',
    borderRadius: 10,
    padding: 12,
  },
  commentSkeletonAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e4e4e4',
    marginRight: 10,
  },
  commentSkeletonContent: {
    flex: 1,
    gap: 6,
  },
  commentSkeletonLineShort: {
    width: '35%',
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ececec',
  },
  commentSkeletonLineLong: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ececec',
  },
  commentSkeletonLineMedium: {
    width: '72%',
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ececec',
  },
  commentsLoadingMore: {
    fontSize: 12,
    color: '#8a8a8a',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 6,
  },
  commentsSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  commentsSheetContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: COMMENTS_SHEET_MAX_HEIGHT,
    minHeight: '58%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  commentsSheetHandle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#ddd',
    marginBottom: 12,
  },
  commentsSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  commentsSheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1c1c1c',
  },
  commentsSheetCount: {
    fontSize: 14,
    fontWeight: '700',
    color: '#777',
  },
  commentsSheetBody: {
    flex: 1,
    paddingTop: 12,
  },
  commentsSheetListContent: {
    paddingBottom: 10,
  },
  replyingBanner: {
    marginTop: 8,
    marginBottom: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#f7f7f7',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  replyingBannerText: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600',
  },
  replyingBannerCancel: {
    color: '#7d7d7d',
    fontSize: 12,
    fontWeight: '700',
  },
  commentsComposer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingTop: 8,
  },
  commentsComposerInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderWidth: 1,
    borderColor: '#e2e2e2',
    borderRadius: 20,
    backgroundColor: '#fafafa',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1a1a1a',
    textAlignVertical: 'top',
  },
  commentsComposerSendBtn: {
    backgroundColor: '#e63946',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  commentsComposerSendText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  // ── Sticky Engagement Bar ──
  stickyBar: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#efefef',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.08,
        shadowRadius: 8,
      },
      android: { elevation: 10 },
    }),
  },
  stickyInputButton: {
    minHeight: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#e4e4e4',
    backgroundColor: '#fafafa',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stickyInputButtonText: {
    color: '#8b8b8b',
    fontSize: 14,
    fontWeight: '500',
  },
  stickyActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stickyActionBtn: {
    minHeight: 34,
    minWidth: 66,
    borderRadius: 17,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8f8f8',
    borderWidth: 1,
    borderColor: '#eeeeee',
  },
  stickyActionBtnActive: {
    backgroundColor: '#fff1f3',
    borderColor: '#ffd8dd',
  },
  stickyActionText: {
    color: '#4a4a4a',
    fontSize: 13,
    fontWeight: '700',
  },
  stickyActionTextActive: {
    color: '#d6313f',
  },
  stickyPostBtnDisabled: {
    opacity: 0.5,
  },
});

export default ArticleDetailScreen;
