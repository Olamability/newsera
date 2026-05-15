import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
const FEED_BOTTOM_SPACING = 16;
const INITIAL_ITEMS_TO_RENDER = 8;
const MAX_ITEMS_PER_BATCH = 8;
const FEED_WINDOW_SIZE = 9;
const BATCHING_PERIOD_MS = 60;

const CategoryDetailScreen: React.FC<Props> = ({ route }) => {
  const { categoryId } = route.params;
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

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

  const renderItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <ArticleCard article={item} onPress={openArticle} />
    ),
    [openArticle]
  );

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footer}>
        <ActivityIndicator size="small" color="#888" />
      </View>
    );
  }, [loadingMore]);
  const keyExtractor = useCallback((item: NewsArticle) => item.id, []);
  const skeletonKeyExtractor = useCallback((item: number) => `sk-${item}`, []);
  const renderSkeletonItem = useCallback(() => <View style={styles.skeletonCard} />, []);
  const listPaddingBottom = FEED_BOTTOM_SPACING + insets.bottom;

  if (loading) {
    return (
      <View style={styles.container}>
        <FlatList
          data={SKELETON_DATA}
          keyExtractor={skeletonKeyExtractor}
          renderItem={renderSkeletonItem}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: listPaddingBottom }}
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
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: listPaddingBottom }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={INITIAL_ITEMS_TO_RENDER}
        maxToRenderPerBatch={MAX_ITEMS_PER_BATCH}
        windowSize={FEED_WINDOW_SIZE}
        updateCellsBatchingPeriod={BATCHING_PERIOD_MS}
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
