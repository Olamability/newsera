import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, NewsArticle } from '../types';
import { supabase } from '../services/supabase';
import { getDeviceId } from '../services/deviceId';
import { saveRecentlyViewed } from '../services/recentlyViewedService';
import { checkAndNotifyBreakingNews } from '../services/notificationService';
import { isBookmarked, toggleBookmark } from '../services/bookmarkService';
import { isLiked, getLikeCount, toggleLike } from '../services/likeService';
import { fetchComments, addComment, ArticleComment } from '../services/commentService';
import { fetchSimilarArticlesPage } from '../services/newsService';
import { useAuth } from '../context/AuthContext';
import { buildArticleShareContent, resolveArticleSourceName } from '../services/shareService';
import { sanitizeArticleContent } from '../services/articleUtils';
import SkeletonCard from '../components/SkeletonCard';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;
const MAX_PREVIEW_CHARS = 1400;
const COMMENT_BAR_HEIGHT = 62;
const SIMILAR_PAGE_SIZE = 10;
// Extra clearance so content isn't hidden behind the sticky comment bar
const STICKY_BAR_CLEARANCE = 8;

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
    return `Published ${mins} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `Published ${diffHours} hr ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays <= 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }

  return publishedDate.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const ArticleDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { article } = route.params;
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const sourceName = resolveArticleSourceName(article);
  const sourceLogo = article.sources?.logo_url ?? null;
  const previewText = useMemo(() => buildArticlePreview(article.snippet, article.content), [article.content, article.snippet]);
  const publishedTimeText = useMemo(() => formatPublishedTime(article.published_at), [article.published_at]);

  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [likeLoading, setLikeLoading] = useState(false);

  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const [similarArticles, setSimilarArticles] = useState<NewsArticle[]>([]);
  const [similarHasMore, setSimilarHasMore] = useState(true);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const similarPageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const seenIdsRef = useRef<string[]>([]);

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

  // Load bookmark state for authenticated users
  useEffect(() => {
    if (!user) return;
    isBookmarked(article.id, user.id)
      .then(setBookmarked)
      .catch(() => {});
  }, [article.id, user]);

  // Load like state and count (works for both authenticated and guest users)
  useEffect(() => {
    getLikeCount(article.id)
      .then(setLikeCount)
      .catch(() => {});

    (async () => {
      try {
        const userId = user?.id ?? (await getDeviceId());
        const liked = await isLiked(article.id, userId);
        setLiked(liked);
      } catch (_) {}
    })();
  }, [article.id, user]);

  // Load comments
  useEffect(() => {
    fetchComments(article.id)
      .then(setComments)
      .catch(() => {});
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
    setLikeLoading(true);
    try {
      const userId = user?.id ?? (await getDeviceId());
      const next = await toggleLike(article.id, userId);
      setLiked(next);
      // Refetch the authoritative count to stay in sync across devices
      const count = await getLikeCount(article.id);
      setLikeCount(count);
    } catch (err) {
      console.error('[Like] Toggle failed:', err);
    } finally {
      setLikeLoading(false);
    }
  }, [user, article.id]);

  const handleAddComment = useCallback(async () => {
    const text = commentText.trim();
    if (!text) return;

    setCommentSubmitting(true);
    try {
      const userId = user?.id ?? (await getDeviceId());
      await addComment(article.id, userId, text);
      setCommentText('');
      const updated = await fetchComments(article.id);
      setComments(updated);
    } catch (err) {
      console.error('[Comment] Submit failed:', err);
      Alert.alert('Error', 'Failed to post comment. Please try again.');
    } finally {
      setCommentSubmitting(false);
    }
  }, [user, article.id, commentText]);

  const handleBookmark = useCallback(async () => {
    if (!user) {
      Alert.alert(
        'Sign in required',
        'Please sign in to bookmark articles.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign In', onPress: () => navigation.navigate('Login') },
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
  }, [user, article.id, navigation]);

  const handleShare = useCallback(async () => {
    try {
      await Share.share(buildArticleShareContent(article));
    } catch (err) {
      console.warn('[Share] Failed:', err);
    }
  }, [article]);

  const handleReadFull = useCallback(async () => {
    // Track click — non-blocking; link opens regardless of tracking result
    try {
      // Prefer authenticated user ID; fall back to device ID for guest users
      const trackingId = user?.id ?? (await getDeviceId());

      // Dedup: skip insert if this user/device already clicked this article in the last 30 seconds
      const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
      const { data: recent } = await supabase
        .from('article_clicks')
        .select('id')
        .eq('article_id', article.id)
        .eq('device_id', trackingId)
        .gte('clicked_at', thirtySecsAgo)
        .limit(1);

      if (!recent || recent.length === 0) {
        await supabase.from('article_clicks').insert({
          article_id: article.id,
          source_id: article.source_id,
          device_id: trackingId,
        });

        // Atomically insert or increment the user interest score for this category
        if (article.category_id) {
          await supabase.rpc('increment_user_interest', {
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

        <View style={styles.headerCenter} />

        <View style={styles.headerRight}>
          <Text style={styles.headerSource} numberOfLines={1} ellipsizeMode="tail">
            {sourceName}
          </Text>
        </View>
      </View>

      {/* ── Main scrollable area + sticky comment bar ── */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
          onEndReached={loadMoreSimilar}
          onEndReachedThreshold={0.5}
          removeClippedSubviews
          ListHeaderComponent={
            <View style={styles.body}>
              {/* 1. Article Title */}
              <Text style={styles.title}>{article.title}</Text>

              {/* 2. Source Row: logo + stacked name/time */}
              <View style={styles.sourceRow}>
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
                <View style={styles.sourceMetaWrap}>
                  <Text style={styles.source}>{sourceName}</Text>
                  {publishedTimeText ? (
                    <Text style={styles.sourceMetaText}>{publishedTimeText}</Text>
                  ) : null}
                </View>
              </View>

              {/* 3. Featured Image */}
              {article.image_url ? (
                <Image
                  source={{ uri: article.image_url }}
                  style={styles.featuredImage}
                  contentFit="cover"
                  transition={300}
                />
              ) : null}

              {/* 4. Article Snippet / Content */}
              {previewText ? (
                <Text style={styles.articleContent}>{previewText}</Text>
              ) : null}

              {/* 5. Read on Source Website (tight to snippet) */}
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.button}
                  onPress={handleReadFull}
                  activeOpacity={0.85}
                >
                  <Text style={styles.buttonText}>Read on Source Website</Text>
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

                {comments.length === 0 ? (
                  <Text style={styles.noComments}>No comments yet. Be the first!</Text>
                ) : (
                  comments.map((comment) => (
                    <View key={comment.id} style={styles.commentItem}>
                      <View style={styles.commentHeader}>
                        <Text style={styles.commentUser}>Guest</Text>
                        <Text style={styles.commentDate}>
                          {new Date(comment.created_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </Text>
                      </View>
                      <Text style={styles.commentContent}>{comment.content}</Text>
                    </View>
                  ))
                )}
              </View>
            </>
          }
        />

        {/* ── Sticky Comment Bar (fixed above Android nav) ── */}
        <View
          style={[
            styles.stickyBar,
            keyboardVisible && styles.stickyBarKeyboardOpen,
            { paddingBottom: Math.max(insets.bottom, STICKY_BAR_CLEARANCE) },
          ]}
        >
          <Ionicons name="chatbubble-outline" size={18} color="#888" style={styles.stickyBarIcon} />
          <TextInput
            style={styles.stickyInput}
            placeholder="Write a comment…"
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
            <Text style={styles.stickyPostText}>Post</Text>
          </TouchableOpacity>
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
    flexShrink: 0,
  },
  headerCenter: {
    flex: 1,
  },
  headerRight: {
    maxWidth: '55%',
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 8,
  },
  headerSource: {
    fontSize: 14,
    color: '#555',
    fontWeight: '600',
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
    padding: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#1a1a1a',
    lineHeight: 36,
    marginBottom: 12,
  },
  // ── Source row ──
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  sourceLogo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f2f2f2',
  },
  sourceLogoPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f2f2',
  },
  sourceLogoPlaceholderText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '700',
  },
  sourceMetaWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  source: {
    fontSize: 15,
    color: '#303030',
    fontWeight: '700',
  },
  sourceMetaText: {
    fontSize: 13,
    color: '#7a7a7a',
    marginTop: 2,
  },
  featuredImage: {
    width: '100%',
    height: 240,
    borderRadius: 16,
    backgroundColor: '#f1f1f1',
    marginTop: 4,
    marginBottom: 16,
  },
  articleContent: {
    fontSize: 17,
    color: '#242424',
    lineHeight: 30,
    marginBottom: 8,
  },
  actions: {
    marginTop: 2,
    gap: 8,
  },
  button: {
    backgroundColor: '#e63946',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
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
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
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
  stickyBarKeyboardOpen: {
    paddingTop: 8,
  },
  stickyBarIcon: {
    marginRight: 2,
  },
  stickyInput: {
    flex: 1,
    height: 38,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 20,
    paddingHorizontal: 14,
    fontSize: 14,
    color: '#1a1a1a',
    backgroundColor: '#fafafa',
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
});

export default ArticleDetailScreen;
