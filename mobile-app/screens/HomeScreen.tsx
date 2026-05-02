import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Text,
  Alert,
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
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // Prevents duplicate concurrent fetches within the same feed/page.
  const isFetchingRef = useRef(false);
  // Incremented whenever the category changes or a refresh is triggered so that
  // any in-flight fetch from the previous feed is silently discarded.
  const fetchGenerationRef = useRef(0);

  const loadArticles = useCallback(async (categoryId: string, pageNum: number, append: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const generation = fetchGenerationRef.current;

    try {
      let data: NewsArticle[];
      let moreAvailable: boolean;

      if (categoryId === CATEGORY_FOR_YOU) {
        const result = await fetchPersonalizedArticles(pageNum);
        data = result.articles;
        moreAvailable = result.hasMore;
      } else if (categoryId === CATEGORY_TRENDING) {
        const result = await fetchTrendingArticles(pageNum);
        data = result.articles;
        moreAvailable = result.hasMore;
      } else {
        const result = await fetchArticles(pageNum, categoryId === CATEGORY_ALL ? null : categoryId);
        data = result.articles;
        moreAvailable = result.hasMore;
      }

      // Discard stale results if the category changed or a refresh fired mid-flight.
      if (fetchGenerationRef.current !== generation) return;

      setHasMore(moreAvailable);
      setArticles(prev => append ? [...prev, ...data] : data);
    } finally {
      // Only release the lock when it still belongs to this fetch.
      if (fetchGenerationRef.current === generation) {
        isFetchingRef.current = false;
      }
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
    // Invalidate any in-flight fetch from the previous feed and release the lock
    // so the fresh fetch below is never blocked.
    fetchGenerationRef.current += 1;
    isFetchingRef.current = false;

    setLoading(true);
    setPage(1);
    setHasMore(true);
    setArticles([]);
    loadArticles(selectedCategory, 1, false).finally(() => setLoading(false));
  }, [selectedCategory, loadArticles]);

  const onRefresh = async () => {
    fetchGenerationRef.current += 1;
    isFetchingRef.current = false;

    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    await loadArticles(selectedCategory, 1, false);
    setRefreshing(false);
  };

  const onEndReached = useCallback(async () => {
    // Guard: skip if already loading or no more pages
    if (loading || loadingMore || !hasMore || isFetchingRef.current) return;

    const nextPage = page + 1;
    setLoadingMore(true);
    setPage(nextPage);
    try {
      await loadArticles(selectedCategory, nextPage, true);
    } finally {
      setLoadingMore(false);
    }
  }, [loading, hasMore, loadingMore, page, selectedCategory, loadArticles]);

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
        {/* DEBUG — remove once touch events are confirmed working */}
        <TouchableOpacity
          style={styles.testButton}
          onPress={() => Alert.alert('Touch works ✅', 'Touch events are firing correctly.')}
          activeOpacity={0.7}
        >
          <Text style={styles.testButtonText}>🛠 DEBUG: Test Touch</Text>
        </TouchableOpacity>
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
          keyboardShouldPersistTaps="handled"
          scrollEnabled={false}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* DEBUG — remove once touch events are confirmed working */}
      <TouchableOpacity
        style={styles.testButton}
        onPress={() => Alert.alert('Touch works ✅', 'Touch events are firing correctly.')}
        activeOpacity={0.7}
      >
        <Text style={styles.testButtonText}>🛠 DEBUG: Test Touch</Text>
      </TouchableOpacity>
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
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
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
  // DEBUG — remove after touch events are confirmed working
  testButton: {
    backgroundColor: '#ff9800',
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  testButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});
