import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import ArticleCard from '../components/ArticleCard';
import { fetchBookmarkedArticles, removeBookmark } from '../services/bookmarkService';
import { NewsArticle, RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Bookmarks'>;

const BookmarksScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { user, loading: authLoading } = useAuth();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  // Redirect unauthenticated users to Login
  useEffect(() => {
    if (!authLoading && !user) {
      navigation.replace('Login');
    }
  }, [user, authLoading, navigation]);

  const loadBookmarks = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await fetchBookmarkedArticles(user.id);
      setArticles(data);
    } catch (err) {
      console.error('[Bookmarks] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const handleArticlePress = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const handleRemove = useCallback(
    async (article: NewsArticle) => {
      if (!user) return;
      try {
        await removeBookmark(article.id, user.id);
        setArticles((prev) => prev.filter((a) => a.id !== article.id));
      } catch (err) {
        console.error('[Bookmarks] Failed to remove:', err);
      }
    },
    [user]
  );

  const renderItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <View>
        <ArticleCard article={item} onPress={handleArticlePress} />
        <TouchableOpacity
          style={styles.removeBtn}
          onPress={() => handleRemove(item)}
          activeOpacity={0.7}
        >
          <Text style={styles.removeBtnText}>Remove Bookmark</Text>
        </TouchableOpacity>
      </View>
    ),
    [handleArticlePress, handleRemove]
  );

  const keyExtractor = (item: NewsArticle) => item.id;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (articles.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>🔖</Text>
        <Text style={styles.emptyTitle}>No bookmarks yet</Text>
        <Text style={styles.emptySubtitle}>
          Tap the bookmark icon on any article to save it here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={articles}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={7}
      updateCellsBatchingPeriod={50}
      removeClippedSubviews
    />
  );
};

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
    lineHeight: 22,
  },
  list: {
    paddingVertical: 8,
    paddingBottom: 24,
    backgroundColor: '#f5f5f5',
  },
  removeBtn: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#fff0f0',
    borderWidth: 1,
    borderColor: '#ffd0d0',
  },
  removeBtnText: {
    fontSize: 13,
    color: '#e63946',
    fontWeight: '600',
  },
});

export default BookmarksScreen;
