import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import ArticleCard from '../components/ArticleCard';
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

export default function HomeScreen() {
  const navigation = useNavigation<any>();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(CATEGORY_ALL);
  const [refreshing, setRefreshing] = useState(false);

  const loadArticles = useCallback(async (categoryId: string) => {
    if (categoryId === CATEGORY_ALL) {
      const data = await fetchArticles(0, null);
      setArticles(data);
    } else if (categoryId === CATEGORY_FOR_YOU) {
      const data = await fetchPersonalizedArticles();
      setArticles(data);
    } else if (categoryId === CATEGORY_TRENDING) {
      const data = await fetchTrendingArticles();
      setArticles(data);
    } else {
      const data = await fetchArticles(0, categoryId);
      setArticles(data);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    const c = await fetchCategories();
    setCategories(c);
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadArticles(selectedCategory);
  }, [selectedCategory, loadArticles]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadArticles(selectedCategory);
    setRefreshing(false);
  };

  const openArticle = (article: NewsArticle) => {
    navigation.navigate('ArticleDetail', { article });
  };

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
});
