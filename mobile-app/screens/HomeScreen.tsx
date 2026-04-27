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
import {
  fetchArticles,
  fetchCategories,
  fetchTrendingArticles,
  fetchPersonalizedArticles,
} from '../services/newsService';
import { getRecentlyViewed } from '../services/recentlyViewedService';
import { Category, NewsArticle, RootStackParamList } from '../types';
import { useCategoryContext } from '../context/CategoryContext';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const TRENDING_DISPLAY_COUNT = 5;
const FOR_YOU_MIN = 5;
const FOR_YOU_MAX = 10;

const HomeScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { selectedCategoryId: selectedCategory, setSelectedCategoryId: setSelectedCategory } =
    useCategoryContext();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [trendingArticles, setTrendingArticles] = useState<NewsArticle[]>([]);
  const [personalizedArticles, setPersonalizedArticles] = useState<NewsArticle[]>([]);
  const [recentlyViewed, setRecentlyViewed] = useState<NewsArticle[]>([]);
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

  const loadPersonalized = useCallback(async () => {
    try {
      const data = await fetchPersonalizedArticles();
      setPersonalizedArticles(data.slice(0, FOR_YOU_MAX));
    } catch (_) {
      // personalized section is non-critical
    }
  }, []);

  const loadRecentlyViewed = useCallback(async () => {
    try {
      const data = await getRecentlyViewed();
      setRecentlyViewed(data);
    } catch (_) {
      // recently viewed section is non-critical
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
    loadPersonalized();
    loadRecentlyViewed();
  }, [loadCategories, loadTrending, loadPersonalized, loadRecentlyViewed]);

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
      loadPersonalized(),
      loadRecentlyViewed(),
    ]);
    setRefreshing(false);
  }, [selectedCategory, loadArticles, loadTrending, loadPersonalized, loadRecentlyViewed]);

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
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>Trending Now 🔥</Text>
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

  const renderForYouSection = () => {
    if (personalizedArticles.length < FOR_YOU_MIN) return null;
    return (
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>For You ✨</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.trendingList}
        >
          {personalizedArticles.map((article) => (
            <View key={article.id} style={styles.trendingCardWrapper}>
              <ArticleCard article={article} onPress={handleArticlePress} />
            </View>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderContinueReadingSection = () => {
    if (recentlyViewed.length === 0) return null;
    return (
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>Continue Reading 📖</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.trendingList}
        >
          {recentlyViewed.map((article) => (
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
        ListHeaderComponent={() => (
          <>
            {renderForYouSection()}
            {renderContinueReadingSection()}
            {renderTrendingSection()}
          </>
        )}
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
  sectionContainer: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  sectionTitle: {
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
