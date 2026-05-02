import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import ArticleCard from '../components/ArticleCard';
import { supabase } from '../services/supabase';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Search'>;

const ARTICLE_SELECT = '*, sources(name, website_url), categories(name)';

interface ArticleRow {
  image_url?: string | null;
  image?: string | null;
  content?: string | null;
  sources?: { name?: string | null } | null;
  categories?: { name?: string | null } | null;
  [key: string]: unknown;
}

function extractFirstImage(content: string | null | undefined): string | null {
  if (!content) return null;
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function mapArticle(row: ArticleRow): NewsArticle {
  const imageUrl =
    (row.image_url as string | null) ??
    (row.image as string | null) ??
    extractFirstImage(row.content as string | null);
  return {
    ...(row as unknown as NewsArticle),
    image_url: imageUrl,
    source_name: row.sources?.name ?? 'Unknown source',
    category_name: row.categories?.name ?? null,
  };
}

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
      const { data, error } = await supabase
        .from('articles')
        .select(ARTICLE_SELECT)
        .ilike('title', `%${q.trim()}%`)
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
          autoFocus
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
          renderItem={({ item }) => (
            <ArticleCard article={item} onPress={openArticle} />
          )}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
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
