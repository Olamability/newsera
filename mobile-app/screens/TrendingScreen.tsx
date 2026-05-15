import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import SkeletonCard from '../components/SkeletonCard';
import { fetchTrendingArticleById, fetchTrendingArticles } from '../services/newsServicePublic';
import { NewsArticle, RootStackParamList } from '../types';
import { isAuthError } from '../services/publicDataErrors';
import { subscribeToTrendingEngagementEvents } from '../services/realtimeService';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const SKELETON_COUNT = 6;
const SKELETON_DATA = Array.from({ length: SKELETON_COUNT }, (_, i) => i);
const MIN_REALTIME_REFRESH_LIMIT = 20;
const REALTIME_REFRESH_DEBOUNCE_MS = 350;
const REALTIME_PATCH_BATCH_SIZE = 5;
const FEED_BOTTOM_SPACING = 16;
const INITIAL_ITEMS_TO_RENDER = 8;
const MAX_ITEMS_PER_BATCH = 8;
const FEED_WINDOW_SIZE = 9;
const BATCHING_PERIOD_MS = 60;

const TrendingScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const isFetchingRef = useRef(false);
  const fetchGenerationRef = useRef(0);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRealtimeArticleIdsRef = useRef<Set<string>>(new Set());
  const requiresFallbackRefreshRef = useRef(false);

  const loadArticles = useCallback(async (pageNum: number, append: boolean): Promise<boolean> => {
    if (isFetchingRef.current) return false;
    isFetchingRef.current = true;
    const generation = fetchGenerationRef.current;

    try {
      const { articles: data, hasMore: moreAvailable } = await fetchTrendingArticles(pageNum);
      if (fetchGenerationRef.current !== generation) return false;
      setHasMore(moreAvailable);
      setArticles(prev => (append ? [...prev, ...data] : data));
      return true;
    } catch (err) {
      if (fetchGenerationRef.current !== generation) return false;
      if (isAuthError(err)) {
        setHasMore(false);
      }
      return false;
    } finally {
      if (fetchGenerationRef.current === generation) {
        isFetchingRef.current = false;
      }
    }
  }, []);


  useEffect(() => {
    fetchGenerationRef.current += 1;
    isFetchingRef.current = false;
    setLoading(true);
    setPage(1);
    setHasMore(true);
    setArticles([]);
    loadArticles(1, false).finally(() => setLoading(false));
  }, [loadArticles]);

  useEffect(() => {
    const scheduleRealtimeRefresh = (articleId?: string) => {
      if (articleId) {
        pendingRealtimeArticleIdsRef.current.add(articleId);
      } else {
        requiresFallbackRefreshRef.current = true;
      }

      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current);
      }

      realtimeRefreshTimerRef.current = setTimeout(async () => {
        if (isFetchingRef.current) return;
        const generation = fetchGenerationRef.current;
        const pendingIds = Array.from(pendingRealtimeArticleIdsRef.current);
        const useFallbackRefresh = requiresFallbackRefreshRef.current || pendingIds.length === 0;
        pendingRealtimeArticleIdsRef.current.clear();
        requiresFallbackRefreshRef.current = false;

        if (useFallbackRefresh) {
          const limit = MIN_REALTIME_REFRESH_LIMIT;
          try {
            const { articles: data, hasMore: moreAvailable } = await fetchTrendingArticles(1, limit);
            if (fetchGenerationRef.current !== generation) return;
            setArticles(data);
            setHasMore(moreAvailable);
            setPage(1);
          } catch (err) {
            if (fetchGenerationRef.current !== generation) return;
            if (isAuthError(err)) {
              setHasMore(false);
            }
          }
          return;
        }

        try {
          const updatedRows: Array<PromiseSettledResult<NewsArticle | null>> = [];
          for (let index = 0; index < pendingIds.length; index += REALTIME_PATCH_BATCH_SIZE) {
            const batchIds = pendingIds.slice(index, index + REALTIME_PATCH_BATCH_SIZE);
            const batchRows = await Promise.allSettled(
              batchIds.map((id) => fetchTrendingArticleById(id))
            );
            updatedRows.push(...batchRows);
          }
          if (fetchGenerationRef.current !== generation) return;
          setArticles((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            pendingIds.forEach((id, index) => {
              const targetIndex = next.findIndex((article) => article.id === id);
              if (targetIndex === -1) return;
              const settled = updatedRows[index];
              if (!settled || settled.status === 'rejected') return;
              const updated = settled.value;
              if (updated) {
                next[targetIndex] = updated;
              }
            });
            return next;
          });
        } catch (err) {
          if (fetchGenerationRef.current !== generation) return;
          if (isAuthError(err)) {
            setHasMore(false);
          }
        }
      }, REALTIME_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeToTrendingEngagementEvents(({ articleId }) => {
      scheduleRealtimeRefresh(articleId);
    });

    return () => {
      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current);
      }
      unsubscribe();
    };
  }, []);

  const onRefresh = useCallback(async () => {
    fetchGenerationRef.current += 1;
    isFetchingRef.current = false;
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    await loadArticles(1, false);
    setRefreshing(false);
  }, [loadArticles]);

  const onEndReached = useCallback(async () => {
    if (loading || loadingMore || !hasMore || isFetchingRef.current) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const ok = await loadArticles(nextPage, true);
      if (ok) setPage(nextPage);
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, hasMore, page, loadArticles]);

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
  const skeletonKeyExtractor = useCallback((item: number) => `skeleton-${item}`, []);
  const renderSkeletonItem = useCallback(() => <SkeletonCard />, []);
  const listPaddingBottom = FEED_BOTTOM_SPACING + insets.bottom;

  if (loading) {
    return (
      <View style={styles.container}>
        <FlatList
          data={SKELETON_DATA}
          keyExtractor={skeletonKeyExtractor}
          renderItem={renderSkeletonItem}
          contentContainerStyle={{ paddingBottom: listPaddingBottom }}
          scrollEnabled={false}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={articles}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: listPaddingBottom }}
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
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});

export default TrendingScreen;
