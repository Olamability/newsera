import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  FlatList,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
} from 'react-native';
import ArticleCard from '../components/ArticleCard';
import CategoryFilter from '../components/CategoryFilter';
import {
  fetchArticles,
  fetchCategories,
  fetchTrendingArticles,
  fetchPersonalizedArticles,
} from '../services/newsService';
import { NewsArticle, Category } from '../types';
import { useNavigation } from '@react-navigation/native';

export default function HomeScreen() {
  const navigation = useNavigation<any>();

  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [trending, setTrending] = useState<NewsArticle[]>([]);
  const [personalized, setPersonalized] = useState<NewsArticle[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = async () => {
    const [a, c, t, p] = await Promise.all([
      fetchArticles(0, selectedCategory),
      fetchCategories(),
      fetchTrendingArticles(),
      fetchPersonalizedArticles(),
    ]);

    setArticles(a);
    setCategories(c);
    setTrending(t.slice(0, 5));
    setPersonalized(p.slice(0, 5));
  };

  useEffect(() => {
    loadAll();
  }, [selectedCategory]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const openArticle = (article: NewsArticle) => {
    navigation.navigate('ArticleDetail', { article });
  };

  const renderHeader = () => (
    <>
      {/* FOR YOU */}
      {personalized.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>For You</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {personalized.map((item) => (
              <View key={item.id} style={styles.horizontalCard}>
                <ArticleCard article={item} onPress={openArticle} />
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* TRENDING */}
      {trending.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Trending 🔥</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {trending.map((item) => (
              <View key={item.id} style={styles.horizontalCard}>
                <ArticleCard article={item} onPress={openArticle} />
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </>
  );

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
        ListHeaderComponent={renderHeader}
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
  section: {
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    marginLeft: 12,
    marginBottom: 6,
  },
  horizontalCard: {
    width: 320,
    marginLeft: 10,
  },
});