import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Animated,
  Alert,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
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
import { isLiked, getLikeCount, toggleLike } from '../services/likeService';
import {
  fetchCommentsPage,
  addComment,
  ArticleComment,
  COMMENTS_PAGE_SIZE,
} from '../services/commentService';
import { fetchSimilarArticlesPage } from '../services/newsServicePublic';
import { useAuth } from '../context/AuthContext';
import { buildArticleShareContent, resolveArticleSourceName } from '../services/shareService';
import { sanitizeArticleContent } from '../services/articleUtils';
import { InteractionAuthRequiredError } from '../services/interactionErrors';
import {
  subscribeToArticleCommentEvents,
  subscribeToArticleLikeEvents,
} from '../services/realtimeService';
import SkeletonCard from '../components/SkeletonCard';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;
type ThreadedComment = ArticleComment & { replies: ThreadedComment[] };
const MAX_PREVIEW_CHARS = 1400;
const COMMENT_BAR_HEIGHT = 62;
const SIMILAR_PAGE_SIZE = 10;
// Extra clearance so content isn't hidden behind the sticky comment bar
const STICKY_BAR_CLEARANCE = 8;
const REPLY_INDENT_PER_LEVEL = 16;
const MAX_REPLY_INDENT = 48;
const COMMENT_PAGINATION_SIZE = COMMENTS_PAGE_SIZE;
const IOS_KEYBOARD_OFFSET = 14;

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

const generateOptimisticCommentId = (): string => (
  `optimistic-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
);

const upsertComment = (items: ArticleComment[], incoming: ArticleComment): ArticleComment[] => {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index === -1) return sortCommentsAscending([...items, incoming]);
  const next = [...items];
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
  const [likeLoading, setLikeLoading] = useState(false);

  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const [commentsHasMore, setCommentsHasMore] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const commentsOffsetRef = useRef(0);
  const commentsRequestIdRef = useRef(0);
  const shimmerOpacity = useRef(new Animated.Value(0.35)).current;

  const [similarArticles, setSimilarArticles] = useState<NewsArticle[]>([]);
  const [similarHasMore, setSimilarHasMore] = useState(true);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const similarPageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const seenIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // Save to recently viewed and check for breaking news on screen mount
  useEffect(() => {
    saveRecentlyViewed(article);
    checkAndNotifyBreakingNews(article);
  }, [article]);

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
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
    };
  }, [shimmerOpacity]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('blur', () => {
      Keyboard.dismiss();
      setCommentText('');
      setReplyingToCommentId(null);
      setCommentSubmitting(false);
    });
    return unsubscribe;
  }, [navigation]);

  // Load bookmark state for authenticated users
  useEffect(() => {
    if (!user) return;
    isBookmarked(article.id, user.id)
      .then(setBookmarked)
      .catch(() => {});
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

  // Load like state and count
  useEffect(() => {
    getLikeCount(article.id)
      .then(setLikeCount)
      .catch(() => {});

    if (!user) {
      setLiked(false);
      return;
    }

    isLiked(article.id)
      .then(setLiked)
      .catch(() => {});
  }, [article.id, user]);

  // Near real-time like count refresh (singleton-managed subscription)
  useEffect(() => {
    return subscribeToArticleLikeEvents(article.id, (payload) => {
      if (payload.eventType === 'INSERT') {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setLikeCount((prev) => prev + 1);
      } else if (payload.eventType === 'DELETE') {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setLikeCount((prev) => Math.max(0, prev - 1));
      }
    });
  }, [article.id]);

  const loadInitialComments = useCallback(async () => {
    const requestId = commentsRequestIdRef.current + 1;
    commentsRequestIdRef.current = requestId;
    setCommentsLoading(true);
    setCommentsLoadingMore(false);
    setCommentsHasMore(true);
    commentsOffsetRef.current = 0;

    try {
      const { comments: loaded, hasMore } = await fetchCommentsPage(article.id, 0, COMMENT_PAGINATION_SIZE);
      if (commentsRequestIdRef.current !== requestId) return;
      setComments(loaded);
      setExpandedReplies(buildExpandedRepliesMap(loaded));
      setCommentsHasMore(hasMore);
      commentsOffsetRef.current = loaded.length;
    } catch (err) {
      console.log('[Comments] Failed to load initial comments:', err);
      if (commentsRequestIdRef.current === requestId) {
        setComments([]);
        setCommentsHasMore(false);
      }
    } finally {
      if (commentsRequestIdRef.current === requestId) {
        setCommentsLoading(false);
      }
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
      console.log('[Comments] Failed to load more comments:', err);
    } finally {
      setCommentsLoadingMore(false);
    }
  }, [article.id, commentsHasMore, commentsLoading, commentsLoadingMore]);

  // Load comments
  useEffect(() => {
    void loadInitialComments();
  }, [loadInitialComments]);

  // Near real-time comments updates (singleton-managed subscription)
  useEffect(() => {
    return subscribeToArticleCommentEvents(article.id, (payload) => {
      console.log('[Comments] Realtime event:', payload.eventType, payload);

      if (payload.eventType === 'DELETE') {
        const deletedId = payload.old?.id;
        if (!deletedId) return;
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

      setComments((prev) => upsertComment(prev, incoming));
      if (incoming.parent_id) {
        setExpandedReplies((prev) => ({ ...prev, [incoming.parent_id!]: true }));
      }
    });
  }, [article.id]);

  // Load "Read More Like This" recommendations — initial page
  useEffect(() => {
    setSimilarArticles([]);
    setSimilarHasMore(true);
    similarPageRef.current = 1;
    seenIdsRef.current = [];

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

  const handleLike = useCallback(async () => {
    if (!user) {
      promptSignInForInteraction('like');
      return;
    }

    const previousLiked = liked;
    const previousCount = likeCount;
    const nextLiked = !previousLiked;
    setLikeLoading(true);
    setLiked(nextLiked);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLikeCount((prev) => Math.max(0, prev + (nextLiked ? 1 : -1)));

    try {
      const confirmed = await toggleLike(article.id);
      setLiked(confirmed);
      const authoritativeCount = await getLikeCount(article.id);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setLikeCount(authoritativeCount);
    } catch (err) {
      setLiked(previousLiked);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setLikeCount(previousCount);
      if (err instanceof InteractionAuthRequiredError) {
        promptSignInForInteraction('like');
      } else {
        Alert.alert('Error', 'Failed to update like. Please try again.');
      }
    } finally {
      setLikeLoading(false);
    }
  }, [user, liked, likeCount, article.id, promptSignInForInteraction]);

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
      const inserted = await addComment(article.id, user.id, text, parentId, createdAt);
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
        console.log('[Comments] Failed to post comment:', err);
        if (err && typeof err === 'object' && 'message' in err) {
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
    // Track click — non-blocking; link opens regardless of tracking result
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
    } catch (_) {
      // tracking failure must never block navigation
    }

    const supported = await Linking.canOpenURL(article.url);
    if (supported) {
      await Linking.openURL(article.url);
    } else {
      Alert.alert('Error', 'Unable to open this URL.');
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
    void loadMoreComments();
  }, [loadMoreComments, loadMoreSimilar]);

  const threadedComments = useMemo(() => buildThreadedComments(comments), [comments]);

  const renderCommentNode = (comment: ThreadedComment, depth: number = 0): React.ReactNode => {
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
  };

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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_OFFSET : 0}
      >
        <FlatList
          data={similarArticles}
          keyExtractor={(item) => item.id}
          style={styles.flex}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: COMMENT_BAR_HEIGHT + insets.bottom + STICKY_BAR_CLEARANCE },
          ]}
          showsVerticalScrollIndicator={false}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          removeClippedSubviews
          ListHeaderComponent={
            <>
              {/* 1. Featured Image — full-bleed at top */}
              {article.image_url ? (
                <Image
                  source={{ uri: article.image_url }}
                  style={styles.featuredImage}
                  contentFit="cover"
                  transition={300}
                />
              ) : null}

              <View style={styles.body}>
                {/* 2. Headline */}
                <Text style={styles.title}>{article.title}</Text>

                {/* 3. Metadata Row: source+logo left · timestamp+reading-time right */}
                <View style={styles.metaRow}>
                  <View style={styles.metaLeft}>
                    {sourceLogo ? (
                      <Image
                        source={{ uri: sourceLogo }}
                        style={styles.sourceLogo}
                        contentFit="contain"
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

                <View style={styles.contentDivider} />

                {/* 4. Article Snippet / Content */}
                {previewText ? (
                  <Text style={styles.articleContent}>{previewText}</Text>
                ) : null}

                {/* 5. Read on Source Website */}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.button}
                    onPress={handleReadFull}
                    activeOpacity={0.85}
                  >
                    <View style={styles.buttonInner}>
                      <Ionicons name="open-outline" size={17} color="#fff" />
                      <Text style={styles.buttonText}>Read on Source Website</Text>
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
                      onPress={handleLike}
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
                  <Text style={styles.similarTitle}>Read More Like This</Text>
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
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.similarCard}
              onPress={() => navigation.replace('ArticleDetail', { article: item })}
              activeOpacity={0.85}
            >
              {item.image_url ? (
                <Image
                  source={{ uri: item.image_url }}
                  style={styles.similarImage}
                  contentFit="cover"
                  transition={200}
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
          )}
          ListFooterComponent={
            <>
              {/* Skeleton while loading next page */}
              {similarLoadingMore && similarArticles.length > 0 ? (
                <>
                  <SkeletonCard />
                  <SkeletonCard />
                </>
              ) : null}

              {/* 7. Comments section */}
              <View style={styles.commentsSection}>
                <Text style={styles.commentsTitle}>
                  Comments{comments.length > 0 ? ` (${comments.length})` : ''}
                </Text>

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
                  threadedComments.map((comment) => renderCommentNode(comment))
                )}

                {commentsLoadingMore ? (
                  <Text style={styles.commentsLoadingMore}>Loading more comments…</Text>
                ) : null}
              </View>
            </>
          }
        />

        {/* ── Sticky Comment Bar (fixed above Android nav) ── */}
        <View
          style={[
            styles.stickyBar,
            { paddingBottom: Math.max(insets.bottom, STICKY_BAR_CLEARANCE) },
          ]}
        >
          <Ionicons
            name={replyingToCommentId ? 'return-up-forward-outline' : 'chatbubble-outline'}
            size={18}
            color="#888"
            style={styles.stickyBarIcon}
          />
          <TextInput
            style={[styles.stickyInput, keyboardVisible && styles.stickyInputFocused]}
            placeholder={replyingToCommentId ? 'Write a reply…' : 'Write a comment…'}
            placeholderTextColor="#aaa"
            value={commentText}
            onChangeText={setCommentText}
            maxLength={500}
            editable={!commentSubmitting}
            returnKeyType="send"
            onSubmitEditing={handleAddComment}
          />
          <TouchableOpacity
            style={[
              styles.stickyPostBtn,
              (!commentText.trim() || commentSubmitting) && styles.stickyPostBtnDisabled,
            ]}
            onPress={handleAddComment}
            disabled={!commentText.trim() || commentSubmitting}
            activeOpacity={0.85}
          >
            <Text style={styles.stickyPostText}>{replyingToCommentId ? 'Reply' : 'Post'}</Text>
          </TouchableOpacity>
          {replyingToCommentId ? (
            <TouchableOpacity
              style={styles.stickyCancelReplyBtn}
              onPress={() => setReplyingToCommentId(null)}
              activeOpacity={0.75}
            >
              <Text style={styles.stickyCancelReplyText}>Cancel</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </KeyboardAvoidingView>
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
  body: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#111',
    lineHeight: 34,
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
    fontSize: 17,
    color: '#242424',
    lineHeight: 29,
    letterSpacing: 0.1,
    marginBottom: 24,
  },
  actions: {
    gap: 10,
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
  commentsSection: {
    marginTop: 24,
    marginHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 20,
    paddingBottom: 8,
  },
  commentsTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#1a1a1a',
    marginBottom: 14,
  },
  noComments: {
    fontSize: 14,
    color: '#aaa',
    marginBottom: 16,
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
  // ── Sticky Comment Bar ──
  stickyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e8e8e8',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.06,
        shadowRadius: 6,
      },
      android: { elevation: 8 },
    }),
  },
  stickyBarIcon: {
    marginRight: 2,
  },
  stickyInput: {
    flex: 1,
    minHeight: 40,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
    lineHeight: 20,
    color: '#1a1a1a',
    backgroundColor: '#fafafa',
    textAlignVertical: 'center', // Android-only; iOS centers text via paddingVertical
  },
  stickyInputFocused: {
    borderColor: '#d0d0d0',
    backgroundColor: '#fff',
  },
  stickyPostBtn: {
    backgroundColor: '#e63946',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyPostBtnDisabled: {
    opacity: 0.5,
  },
  stickyPostText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  stickyCancelReplyBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  stickyCancelReplyText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#7a7a7a',
  },
});

export default ArticleDetailScreen;
