import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import {
  getLocalReadLater,
  removeLocalReadLater,
  fetchSupabaseReadLater,
  removeSupabaseReadLater,
} from '../services/readLaterService';
import { NewsArticle, ReadLaterEntry, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ReadLater'>;

const ReadLaterScreen: React.FC = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const c = theme.colors;

  const [items, setItems] = useState<ReadLaterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      if (user) {
        const articles = await fetchSupabaseReadLater(user.id);
        const entries: ReadLaterEntry[] = articles.map((a) => ({
          id: `${a.id}_supabase`,
          article: a,
          saved_at: '',
        }));
        setItems(entries);
      } else {
        const local = await getLocalReadLater();
        setItems(local);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = useCallback(
    async (item: ReadLaterEntry) => {
      Alert.alert('Remove', 'Remove this article from Read Later?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setItems((prev) => prev.filter((i) => i.id !== item.id));
            if (user) {
              await removeSupabaseReadLater(item.article.id, user.id).catch(() => {});
            } else {
              await removeLocalReadLater(item.article.id).catch(() => {});
            }
          },
        },
      ]);
    },
    [user]
  );

  const handlePress = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: ReadLaterEntry }) => {
      const { article } = item;
      const source = article.sources?.name ?? article.source_name ?? '';
      const date = article.published_at
        ? new Date(article.published_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })
        : '';
      return (
        <TouchableOpacity
          style={[styles.item, { backgroundColor: c.card, borderColor: c.border }]}
          onPress={() => handlePress(article)}
          activeOpacity={0.8}
        >
          <View style={styles.itemContent}>
            <Text style={[styles.itemTitle, { color: c.text }]} numberOfLines={2}>
              {article.title}
            </Text>
            <Text style={[styles.itemMeta, { color: c.textSecondary }]}>
              {`${source}${date ? ` · ${date}` : ''}`}
            </Text>
            {article.snippet ? (
              <Text style={[styles.itemSnippet, { color: c.textSecondary }]} numberOfLines={2}>
                {article.snippet}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.removeBtn, { borderColor: c.border }]}
            onPress={() => handleRemove(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.removeText, { color: c.primary }]}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      );
    },
    [c, handlePress, handleRemove]
  );

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>⚠️</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>Failed to load</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>🕐</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>No saved articles</Text>
        <Text style={[styles.emptySub, { color: c.textSecondary }]}>
          Tap the bookmark icon on any article to save it for later.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { backgroundColor: c.background }]}
        keyboardShouldPersistTaps="handled"
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#e63946',
  },
  retryText: { color: '#fff', fontWeight: '700' },
  list: { paddingVertical: 8, paddingHorizontal: 12, paddingBottom: 32 },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  itemContent: { flex: 1, marginRight: 12 },
  itemTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
    marginBottom: 4,
  },
  itemMeta: { fontSize: 12, marginBottom: 4 },
  itemSnippet: { fontSize: 13, lineHeight: 18 },
  removeBtn: {
    padding: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  removeText: { fontSize: 14, fontWeight: '700' },
});

export default ReadLaterScreen;
