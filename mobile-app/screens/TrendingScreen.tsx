import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import SkeletonCard from '../components/SkeletonCard';
import { fetchTrendingArticles } from '../services/newsService';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const SKELETON_COUNT = 6;
const SKELETON_DATA = Array.from({ length: SKELETON_COUNT }, (_, i) => i);

const TrendingScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const isFetchingRef = useRef(false);
  const fetchGenerationRef = useRef(0);

  const loadArticles = useCallback(async (pageNum: number, append: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const generation = fetchGenerationRef.current;

    try {
      const { articles: data, hasMore: moreAvailable } = await fetchTrendingArticles(pageNum);
      if (fetchGenerationRef.current !== generation) return;
      setHasMore(moreAvailable);
      setArticles(prev => (append ? [...prev, ...data] : data));
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

  const onRefresh = async () => {
    fetchGenerationRef.current += 1;
    isFetchingRef.current = false;
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    await loadArticles(1, false);
    setRefreshing(false);
  };

  const onEndReached = useCallback(async () => {
    if (loading || loadingMore || !hasMore || isFetchingRef.current) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    setPage(nextPage);
    try {
      await loadArticles(nextPage, true);
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
          keyExtractor={(item) => `skeleton-${item}`}
          renderItem={() => <SkeletonCard />}
          contentContainerStyle={{ paddingBottom: 40 }}
          scrollEnabled={false}
        />
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
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
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
