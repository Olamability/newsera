import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import { fetchArticles } from '../services/newsServicePublic';
import { NewsArticle, RootStackParamList } from '../types';
import { isAuthError } from '../services/publicDataErrors';

type Props = NativeStackScreenProps<RootStackParamList, 'CategoryDetail'>;
type Nav = NativeStackNavigationProp<RootStackParamList, 'CategoryDetail'>;

const SKELETON_COUNT = 4;
const SKELETON_DATA = Array.from({ length: SKELETON_COUNT }, (_, i) => i);

const CategoryDetailScreen: React.FC<Props> = ({ route }) => {
  const { categoryId } = route.params;
  const navigation = useNavigation<Nav>();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const isFetchingRef = useRef(false);

  const loadPage = useCallback(
    async (pageNum: number, append: boolean): Promise<boolean> => {
      if (isFetchingRef.current) return false;
      isFetchingRef.current = true;
      try {
        const { articles: data, hasMore: more } = await fetchArticles(pageNum, categoryId);
        setHasMore(more);
        setArticles((prev) => (append ? [...prev, ...data] : data));
        return true;
      } catch (err) {
        if (isAuthError(err)) {
          setHasMore(false);
        }
        console.warn('[CategoryDetail] Failed to load:', err);
        return false;
      } finally {
        isFetchingRef.current = false;
      }
    },
    [categoryId]
  );

  useEffect(() => {
    setLoading(true);
    setPage(1);
    setHasMore(true);
    setArticles([]);
    loadPage(1, false).finally(() => setLoading(false));
  }, [loadPage]);

  const onEndReached = useCallback(async () => {
    if (loading || loadingMore || !hasMore || isFetchingRef.current) return;
    const next = page + 1;
    setLoadingMore(true);
    try {
      const ok = await loadPage(next, true);
      if (ok) setPage(next);
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, hasMore, page, loadPage]);

  const openArticle = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footer}>
        <ActivityIndicator size="small" color="#888" />
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <FlatList
          data={SKELETON_DATA}
          keyExtractor={(item) => `sk-${item}`}
          renderItem={() => <View style={styles.skeletonCard} />}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}
          scrollEnabled={false}
        />
      </View>
    );
  }

  if (!loading && articles.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>📰</Text>
        <Text style={styles.emptyTitle}>No articles found</Text>
        <Text style={styles.emptySub}>Check back soon for updates.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={articles}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ArticleCard article={item} onPress={openArticle} />
        )}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f2f2',
  },
  centered: {
    flex: 1,
    backgroundColor: '#f2f2f2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  skeletonCard: {
    height: 120,
    backgroundColor: '#e0e0e0',
    borderRadius: 16,
    marginHorizontal: 12,
    marginVertical: 6,
  },
});

export default CategoryDetailScreen;
