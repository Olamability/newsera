import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import ArticleCard from '../components/ArticleCard';
import CategoryFilter from '../components/CategoryFilter';
import { fetchArticles, fetchCategories, fetchTrendingArticles } from '../services/newsService';
import { Category, NewsArticle, RootStackParamList } from '../types';
import { useCategoryContext } from '../context/CategoryContext';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const TRENDING_DISPLAY_COUNT = 5;

const HomeScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { selectedCategoryId: selectedCategory, setSelectedCategoryId: setSelectedCategory } =
    useCategoryContext();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [trendingArticles, setTrendingArticles] = useState<NewsArticle[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const pageRef = useRef(0);
  const loadingRef = useRef(false);

  const loadCategories = useCallback(async () => {
    try {
      const cats = await fetchCategories();
      setCategories(cats);
    } catch (_) {
      // categories are non-critical
    }
  }, []);

  const loadTrending = useCallback(async () => {
    try {
      const data = await fetchTrendingArticles();
      setTrendingArticles(data.slice(0, TRENDING_DISPLAY_COUNT));
    } catch (_) {
      // trending section is non-critical
    }
  }, []);

  const loadArticles = useCallback(
    async (pageNum: number, catId: string | null, replace: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const data = await fetchArticles(pageNum, catId);
        if (replace) {
          setArticles(data);
        } else {
          setArticles((prev) => [...prev, ...data]);
        }
        setHasMore(data.length === 20);
        pageRef.current = pageNum;
      } catch (err) {
        console.error('Failed to load articles:', err);
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    []
  );

  useEffect(() => {
    loadCategories();
    loadTrending();
  }, [loadCategories, loadTrending]);

  useEffect(() => {
    setPage(0);
    setHasMore(true);
    loadArticles(0, selectedCategory, true);
  }, [selectedCategory, loadArticles]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    const nextPage = pageRef.current + 1;
    setPage(nextPage);
    loadArticles(nextPage, selectedCategory, false);
  }, [hasMore, selectedCategory, loadArticles]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setHasMore(true);
    await Promise.all([
      loadArticles(0, selectedCategory, true),
      loadTrending(),
    ]);
    setRefreshing(false);
  }, [selectedCategory, loadArticles, loadTrending]);

  const handleArticlePress = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <ArticleCard article={item} onPress={handleArticlePress} />
    ),
    [handleArticlePress]
  );

  const renderFooter = () => {
    if (!loading) return null;
    return (
      <View style={styles.footer}>
        <ActivityIndicator size="small" color="#e63946" />
      </View>
    );
  };

  const renderTrendingSection = () => {
    if (trendingArticles.length === 0) return null;
    return (
      <View style={styles.trendingSection}>
        <Text style={styles.trendingTitle}>Trending Now 🔥</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.trendingList}
        >
          {trendingArticles.map((article) => (
            <View key={article.id} style={styles.trendingCardWrapper}>
              <ArticleCard article={article} onPress={handleArticlePress} />
            </View>
          ))}
        </ScrollView>
      </View>
    );
  };

  const keyExtractor = (item: NewsArticle) => item.id;

  return (
    <View style={styles.container}>
      <CategoryFilter
        categories={categories}
        selectedId={selectedCategory}
        onSelect={setSelectedCategory}
      />
      <FlatList
        data={articles}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.list}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={renderTrendingSection}
        ListFooterComponent={renderFooter}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={['#e63946']}
            tintColor="#e63946"
          />
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No articles found.</Text>
            </View>
          ) : null
        }
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={10}
        initialNumToRender={10}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  list: {
    paddingVertical: 8,
    paddingBottom: 24,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 16,
    color: '#999',
  },
  trendingSection: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  trendingTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1a1a1a',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  trendingList: {
    paddingHorizontal: 6,
  },
  trendingCardWrapper: {
    width: 280,
    marginHorizontal: 6,
  },
});

export default HomeScreen;
