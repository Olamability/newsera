import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CompositeNavigationProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import { supabasePublic } from '../services/supabase';
import { ArticleRow, mapArticle } from '../services/articleUtils';
import { NewsArticle, RootStackParamList, MainTabParamList } from '../types';

type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Search'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const ARTICLE_SELECT = '*, sources(name, website_url), categories(name)';

const SearchScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const { data, error } = await supabasePublic
        .from('articles')
        .select(ARTICLE_SELECT)
        .textSearch('fts_content', q.trim(), { type: 'websearch', config: 'english' })
        .order('published_at', { ascending: false })
        .limit(30);

      if (error) throw error;
      setResults(((data as ArticleRow[]) ?? []).map(mapArticle));
    } catch (err) {
      console.warn('[Search] Failed:', err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  const openArticle = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <ArticleCard article={item} onPress={openArticle} />
    ),
    [openArticle]
  );

  const renderEmpty = () => {
    if (!searched || loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>🔍</Text>
        <Text style={styles.emptyTitle}>No results found</Text>
        <Text style={styles.emptySub}>Try a different search term.</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Search articles…"
          placeholderTextColor="#aaa"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#e63946" />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f2f2',
  },
  inputRow: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  input: {
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#1a1a1a',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    paddingTop: 8,
    paddingBottom: 40,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 14,
    color: '#888',
  },
});

export default SearchScreen;
