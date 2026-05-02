import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import { getRecentlyViewed } from '../services/recentlyViewedService';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'RecentlyViewed'>;

const RecentlyViewedScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRecentlyViewed()
      .then(setArticles)
      .finally(() => setLoading(false));
  }, []);

  const openArticle = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (articles.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>🕑</Text>
        <Text style={styles.emptyTitle}>Nothing here yet</Text>
        <Text style={styles.emptySub}>
          Articles you open will appear here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={articles}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <ArticleCard article={item} onPress={openArticle} />
      )}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
    />
  );
};

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  emptySub: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
    lineHeight: 22,
  },
  list: {
    paddingTop: 8,
    paddingBottom: 32,
    backgroundColor: '#f5f5f5',
  },
});

export default RecentlyViewedScreen;
