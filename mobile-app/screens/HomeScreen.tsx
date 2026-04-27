import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import ArticleCard from '../components/ArticleCard';
import CategoryFilter from '../components/CategoryFilter';
import { fetchArticles, fetchCategories } from '../services/newsService';
import { Category, NewsArticle, RootStackParamList } from '../types';
import { useCategoryContext } from '../context/CategoryContext';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const HomeScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { selectedCategoryId: selectedCategory, setSelectedCategoryId: setSelectedCategory } =
    useCategoryContext();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
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
  }, [loadCategories]);

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
    await loadArticles(0, selectedCategory, true);
    setRefreshing(false);
  }, [selectedCategory, loadArticles]);

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
});

export default HomeScreen;
