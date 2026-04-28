import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { supabase } from '../services/supabase';
import { getDeviceId } from '../services/deviceId';
import { saveRecentlyViewed } from '../services/recentlyViewedService';
import { checkAndNotifyBreakingNews } from '../services/notificationService';
import { isBookmarked, toggleBookmark } from '../services/bookmarkService';
import { isLiked, getLikeCount, toggleLike } from '../services/likeService';
import { fetchComments, addComment, ArticleComment } from '../services/commentService';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;

const ArticleDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { article } = route.params;
  const { user } = useAuth();

  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [likeLoading, setLikeLoading] = useState(false);

  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // Save to recently viewed and check for breaking news on screen mount
  useEffect(() => {
    saveRecentlyViewed(article);
    checkAndNotifyBreakingNews(article);
  }, [article]);

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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {article.image_url ? (
        <Image
          source={{ uri: article.image_url }}
          style={styles.image}
          contentFit="cover"
          transition={300}
        />
      ) : null}

      <View style={styles.body}>
        {article.categories?.name ? (
          <Text style={styles.category}>{article.categories.name}</Text>
        ) : null}

        <Text style={styles.title}>{article.title}</Text>

        <View style={styles.metaRow}>
          <Text style={styles.source}>
            {article.sources?.name ?? 'Unknown Source'}
          </Text>
          {article.published_at ? (
            <Text style={styles.date}>
              {new Date(article.published_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>
          ) : null}
        </View>

        {article.snippet ? (
          <Text style={styles.snippet}>{article.snippet}</Text>
        ) : null}

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.button}
            onPress={handleReadFull}
            activeOpacity={0.85}
          >
            <Text style={styles.buttonText}>Read Full Article</Text>
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
          </View>
        </View>

        {/* Comments Section */}
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

          <View style={styles.commentInputRow}>
            <TextInput
              style={styles.commentInput}
              placeholder="Write a comment…"
              placeholderTextColor="#aaa"
              value={commentText}
              onChangeText={setCommentText}
              multiline
              maxLength={500}
              editable={!commentSubmitting}
            />
            <TouchableOpacity
              style={[
                styles.commentSubmitBtn,
                (!commentText.trim() || commentSubmitting) && styles.commentSubmitBtnDisabled,
              ]}
              onPress={handleAddComment}
              disabled={!commentText.trim() || commentSubmitting}
              activeOpacity={0.85}
            >
              <Text style={styles.commentSubmitText}>Post</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    paddingBottom: 40,
  },
  image: {
    width: '100%',
    height: 240,
  },
  body: {
    padding: 16,
  },
  category: {
    fontSize: 13,
    fontWeight: '700',
    color: '#e63946',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a1a1a',
    lineHeight: 30,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  source: {
    fontSize: 13,
    color: '#888',
    fontWeight: '600',
  },
  date: {
    fontSize: 13,
    color: '#aaa',
  },
  snippet: {
    fontSize: 16,
    color: '#333',
    lineHeight: 26,
    marginBottom: 24,
  },
  actions: {
    gap: 12,
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
  // Comments
  commentsSection: {
    marginTop: 28,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingTop: 20,
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
  commentInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    marginTop: 12,
  },
  commentInput: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1a1a1a',
    maxHeight: 100,
    backgroundColor: '#fafafa',
  },
  commentSubmitBtn: {
    backgroundColor: '#e63946',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentSubmitBtnDisabled: {
    opacity: 0.5,
  },
  commentSubmitText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default ArticleDetailScreen;
