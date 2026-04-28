import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import ArticleCard from '../components/ArticleCard';
import SkeletonCard from '../components/SkeletonCard';
import CategoryFilter from '../components/CategoryFilter';
import {
  fetchArticles,
  fetchCategories,
  fetchTrendingArticles,
  fetchPersonalizedArticles,
  CATEGORY_ALL,
  CATEGORY_FOR_YOU,
  CATEGORY_TRENDING,
} from '../services/newsService';
import { NewsArticle, Category } from '../types';
import { useNavigation } from '@react-navigation/native';

const SKELETON_COUNT = 6;
// Stable data array for the skeleton FlatList - avoids re-creating on every render
const SKELETON_DATA = Array.from({ length: SKELETON_COUNT }, (_, i) => i);

export default function HomeScreen() {
  const navigation = useNavigation<any>();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(CATEGORY_ALL);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // Prevent duplicate concurrent fetches
  const isFetchingRef = useRef(false);

  const loadArticles = useCallback(async (categoryId: string, pageNum: number, append: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      let data: NewsArticle[];
      if (categoryId === CATEGORY_FOR_YOU) {
        data = await fetchPersonalizedArticles();
        setHasMore(false);
      } else if (categoryId === CATEGORY_TRENDING) {
        data = await fetchTrendingArticles();
        setHasMore(false);
      } else {
        data = await fetchArticles(pageNum, categoryId === CATEGORY_ALL ? null : categoryId);
        setHasMore(data.length > 0);
      }

      setArticles(prev => append ? [...prev, ...data] : data);
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  const loadCategories = useCallback(async () => {
    const c = await fetchCategories();
    setCategories(c);
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  // Reset and reload when category changes
  useEffect(() => {
    setLoading(true);
    setPage(0);
    setHasMore(true);
    setArticles([]);
    loadArticles(selectedCategory, 0, false).finally(() => setLoading(false));
  }, [selectedCategory, loadArticles]);

  const onRefresh = async () => {
    setRefreshing(true);
    setPage(0);
    setHasMore(true);
    await loadArticles(selectedCategory, 0, false);
    setRefreshing(false);
  };

  const onEndReached = useCallback(async () => {
    if (!hasMore || loadingMore || isFetchingRef.current) return;
    // For virtual categories (For You / Trending) there's no pagination
    if (selectedCategory === CATEGORY_FOR_YOU || selectedCategory === CATEGORY_TRENDING) return;

    const nextPage = page + 1;
    setLoadingMore(true);
    setPage(nextPage);
    try {
      await loadArticles(selectedCategory, nextPage, true);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, page, selectedCategory, loadArticles]);

  const openArticle = (article: NewsArticle) => {
    navigation.navigate('ArticleDetail', { article });
  };

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
        <CategoryFilter
          categories={categories}
          selectedId={selectedCategory}
          onSelect={setSelectedCategory}
        />
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
      <CategoryFilter
        categories={categories}
        selectedId={selectedCategory}
        onSelect={setSelectedCategory}
      />

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
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </View>
  );
}

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
