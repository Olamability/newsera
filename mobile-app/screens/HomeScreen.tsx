import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Share,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ArticleCard from '../components/ArticleCard';
import SkeletonCard from '../components/SkeletonCard';
import CategoryFilter from '../components/CategoryFilter';
import HomeHeader from '../components/HomeHeader';
import HeadlinesSection from '../components/HeadlinesSection';
import {
  fetchArticles,
  fetchCategories,
  fetchTrendingArticles,
  fetchPersonalizedArticles,
  CATEGORY_ALL,
  CATEGORY_FOR_YOU,
  CATEGORY_TRENDING,
} from '../services/newsService';
import { toggleBookmark } from '../services/bookmarkService';
import { NewsArticle, Category } from '../types';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { buildArticleShareContent } from '../services/shareService';

const SKELETON_COUNT = 6;
const SKELETON_DATA = Array.from({ length: SKELETON_COUNT }, (_, i) => i);

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(CATEGORY_ALL);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const flatListRef = useRef<FlatList<NewsArticle>>(null);
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

      console.log('Category:', categoryId);
      console.log('Page:', pageNum);
      console.log('Fetched:', data.length);
      console.log('HasMore:', moreAvailable);

      setHasMore(moreAvailable);
      setArticles(prev => {
        if (!append) return data;
        const merged = [...prev, ...data];
        const unique = merged.filter(
          (item, index, self) =>
            index === self.findIndex(t => t.id === item.id)
        );
        return unique;
      });
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

    // Scroll to top when switching categories
    flatListRef.current?.scrollToOffset({ animated: false, offset: 0 });

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

  const handleLoadMore = useCallback(async () => {
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

  // Filter articles by search query (case-insensitive title match)
  const displayedArticles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => a.title.toLowerCase().includes(q));
  }, [articles, searchQuery]);

  const handleSwipeLeft = useCallback(async (article: NewsArticle) => {
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
    try {
      await toggleBookmark(article.id, user.id);
    } catch (err) {
      console.warn('[HomeScreen] Bookmark swipe failed:', err);
    }
  }, [user, navigation]);

  const handleSwipeRight = useCallback(async (article: NewsArticle) => {
    try {
      await Share.share(buildArticleShareContent(article));
    } catch (err) {
      console.warn('[HomeScreen] Share swipe failed:', err);
    }
  }, []);

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
      <SafeAreaView style={styles.container} edges={['top']}>
        <HomeHeader searchValue={searchQuery} onSearchChange={setSearchQuery} />
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
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <HomeHeader searchValue={searchQuery} onSearchChange={setSearchQuery} />
      <CategoryFilter
        categories={categories}
        selectedId={selectedCategory}
        onSelect={setSelectedCategory}
      />

      <FlatList
        ref={flatListRef}
        data={displayedArticles}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ArticleCard
            article={item}
            onPress={openArticle}
            onSwipeLeft={handleSwipeLeft}
            onSwipeRight={handleSwipeRight}
          />
        )}
        ListHeaderComponent={searchQuery.trim() ? null : <HeadlinesSection />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews
      />
    </SafeAreaView>
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
