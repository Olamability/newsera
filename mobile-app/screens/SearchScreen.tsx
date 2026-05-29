import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
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
import { fetchTrendingArticlesPublic } from '../services/newsServicePublic';
import { resolveArticleSourceName } from '../services/shareService';
import { NewsArticle, RootStackParamList, MainTabParamList } from '../types';

type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Search'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const ARTICLE_SELECT = '*, sources(name, website_url), categories(name)';
const POSTGRES_UNDEFINED_COLUMN_ERROR = '42703';

// Three-state search UX: idle (trending), typing (live suggestions),
// results (full article list). Each state has its own debounce + payload
// so suggestions feel instant while heavyweight results only fire once the
// query settles.
type SearchMode = 'idle' | 'typing' | 'results';

const SUGGESTION_DEBOUNCE_MS = 120;
const RESULTS_DEBOUNCE_MS = 300;
const SUGGESTION_LIMIT = 6;
const RESULTS_LIMIT = 30;
const TRENDING_LIMIT = 12;

async function runFullTextSearch(q: string, limit: number): Promise<NewsArticle[]> {
  let query = supabasePublic
    .from('articles')
    .select(ARTICLE_SELECT)
    .textSearch('fts_title_snippet', q, { type: 'websearch', config: 'english' })
    .order('published_at', { ascending: false })
    .limit(limit);

  let { data, error } = await query;
  if (error?.code === POSTGRES_UNDEFINED_COLUMN_ERROR) {
    query = supabasePublic
      .from('articles')
      .select(ARTICLE_SELECT)
      .textSearch('fts_content', q, { type: 'websearch', config: 'english' })
      .order('published_at', { ascending: false })
      .limit(limit);
    ({ data, error } = await query);
  }

  if (error) throw error;
  return ((data as ArticleRow[]) ?? []).map(mapArticle);
}

const SearchScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NewsArticle[]>([]);
  const [suggestions, setSuggestions] = useState<NewsArticle[]>([]);
  const [trending, setTrending] = useState<NewsArticle[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [resultsForQuery, setResultsForQuery] = useState<string | null>(null);

  const resultsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track in-flight request generations so out-of-order responses cannot
  // overwrite a newer query's results.
  const resultsGenRef = useRef(0);
  const suggestionsGenRef = useRef(0);

  const trimmed = query.trim();

  // Load trending content once for the idle state.
  useEffect(() => {
    let cancelled = false;
    setTrendingLoading(true);
    fetchTrendingArticlesPublic(1, TRENDING_LIMIT)
      .then((res) => {
        if (!cancelled) setTrending(res.articles);
      })
      .catch((err) => {
        console.warn('[Search] Trending load failed:', err);
      })
      .finally(() => {
        if (!cancelled) setTrendingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Suggestions: short debounce so the list refreshes live as the user
  // types. We keep them lightweight (small limit) so latency stays low.
  useEffect(() => {
    if (suggestionsDebounceRef.current) clearTimeout(suggestionsDebounceRef.current);
    if (!trimmed) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }
    setLoadingSuggestions(true);
    const gen = ++suggestionsGenRef.current;
    suggestionsDebounceRef.current = setTimeout(async () => {
      try {
        const data = await runFullTextSearch(trimmed, SUGGESTION_LIMIT);
        if (gen !== suggestionsGenRef.current) return;
        setSuggestions(data);
      } catch (err) {
        if (gen !== suggestionsGenRef.current) return;
        console.warn('[Search] Suggestions failed:', err);
        setSuggestions([]);
      } finally {
        if (gen === suggestionsGenRef.current) setLoadingSuggestions(false);
      }
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      if (suggestionsDebounceRef.current) clearTimeout(suggestionsDebounceRef.current);
    };
  }, [trimmed]);

  // Full results: longer debounce + full payload. The "results" state is
  // only entered once this fires successfully.
  useEffect(() => {
    if (resultsDebounceRef.current) clearTimeout(resultsDebounceRef.current);
    if (!trimmed) {
      setResults([]);
      setResultsForQuery(null);
      setLoadingResults(false);
      return;
    }
    setLoadingResults(true);
    const gen = ++resultsGenRef.current;
    resultsDebounceRef.current = setTimeout(async () => {
      try {
        const data = await runFullTextSearch(trimmed, RESULTS_LIMIT);
        if (gen !== resultsGenRef.current) return;
        setResults(data);
        setResultsForQuery(trimmed);
      } catch (err) {
        if (gen !== resultsGenRef.current) return;
        console.warn('[Search] Failed:', err);
        setResults([]);
        setResultsForQuery(trimmed);
      } finally {
        if (gen === resultsGenRef.current) setLoadingResults(false);
      }
    }, RESULTS_DEBOUNCE_MS);

    return () => {
      if (resultsDebounceRef.current) clearTimeout(resultsDebounceRef.current);
    };
  }, [trimmed]);

  const mode: SearchMode = useMemo(() => {
    if (!trimmed) return 'idle';
    if (resultsForQuery === trimmed && !loadingResults) return 'results';
    return 'typing';
  }, [trimmed, resultsForQuery, loadingResults]);

  const openArticle = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation],
  );

  const renderArticleItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <ArticleCard article={item} onPress={openArticle} />
    ),
    [openArticle],
  );

  const renderSuggestionItem = useCallback(
    ({ item }: { item: NewsArticle }) => (
      <Pressable
        style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
        onPress={() => openArticle(item)}
        android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
      >
        <Text style={styles.suggestionIcon}>🔎</Text>
        <View style={styles.suggestionTextWrap}>
          <Text style={styles.suggestionTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.suggestionSource} numberOfLines={1}>
            {resolveArticleSourceName(item)}
          </Text>
        </View>
      </Pressable>
    ),
    [openArticle],
  );

  const keyExtractor = useCallback((item: NewsArticle) => item.id, []);

  const renderIdleState = () => (
    <View style={styles.idleContainer}>
      <Text style={styles.sectionHeading}>🔥 Trending now</Text>
      {trendingLoading && trending.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#e63946" />
        </View>
      ) : trending.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📰</Text>
          <Text style={styles.emptyTitle}>Nothing trending right now</Text>
          <Text style={styles.emptySub}>Try searching for a topic above.</Text>
        </View>
      ) : (
        <FlatList
          data={trending}
          keyExtractor={keyExtractor}
          renderItem={renderArticleItem}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews
        />
      )}
    </View>
  );

  const renderTypingState = () => (
    <View style={styles.typingContainer}>
      <View style={styles.typingHeaderRow}>
        <Text style={styles.sectionHeading}>Suggestions</Text>
        {loadingSuggestions || loadingResults ? (
          <ActivityIndicator size="small" color="#e63946" />
        ) : null}
      </View>
      <FlatList
        data={suggestions}
        keyExtractor={keyExtractor}
        renderItem={renderSuggestionItem}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={styles.suggestionSeparator} />}
        ListEmptyComponent={
          loadingSuggestions ? null : (
            <Text style={styles.typingHint}>
              Keep typing to see live suggestions…
            </Text>
          )
        }
      />
    </View>
  );

  const renderResultsState = () => {
    if (results.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.emptyTitle}>No results found</Text>
          <Text style={styles.emptySub}>Try a different search term.</Text>
        </View>
      );
    }
    return (
      <FlatList
        data={results}
        keyExtractor={keyExtractor}
        renderItem={renderArticleItem}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        ListHeaderComponent={
          <Text style={styles.resultsHeading}>
            Results for “{resultsForQuery}”
          </Text>
        }
      />
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
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      {mode === 'idle' && renderIdleState()}
      {mode === 'typing' && renderTypingState()}
      {mode === 'results' && renderResultsState()}
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
    paddingTop: 40,
  },
  list: {
    paddingTop: 4,
    paddingBottom: 40,
    flexGrow: 1,
  },
  sectionHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1a1a1a',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    letterSpacing: 0.2,
  },
  resultsHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  idleContainer: {
    flex: 1,
  },
  typingContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  typingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
  },
  typingHint: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#888',
    fontSize: 13,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  suggestionRowPressed: {
    backgroundColor: '#f5f5f5',
  },
  suggestionIcon: {
    fontSize: 14,
    marginRight: 12,
    color: '#888',
  },
  suggestionTextWrap: {
    flex: 1,
  },
  suggestionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
    lineHeight: 19,
  },
  suggestionSource: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
    fontWeight: '500',
  },
  suggestionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eee',
    marginLeft: 42,
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
