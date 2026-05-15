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
import {
  getOfflineArticles,
  removeOfflineArticle,
  OfflineArticle as OfflineArticleData,
} from '../services/offlineService';
import { NewsArticle, RootStackParamList } from '../types';

// Re-export for convenience
export { OfflineArticleData };

type Nav = NativeStackNavigationProp<RootStackParamList, 'OfflineReading'>;

const MAX_OFFLINE = 30;

const OfflineReadingScreen: React.FC = () => {
  const { theme } = useTheme();
  const navigation = useNavigation<Nav>();
  const c = theme.colors;

  const [items, setItems] = useState<OfflineArticleData[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getOfflineArticles();
      setItems(data);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = useCallback((entry: OfflineArticleData) => {
    Alert.alert('Remove', 'Remove this article from offline storage?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setItems((prev) => prev.filter((i) => i.article.id !== entry.article.id));
          await removeOfflineArticle(entry.article.id).catch(() => {});
        },
      },
    ]);
  }, []);

  const handlePress = useCallback(
    (article: NewsArticle) => {
      navigation.navigate('ArticleDetail', { article });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: OfflineArticleData }) => {
      const { article } = item;
      const source = article.sources?.name ?? article.source_name ?? '';
      const savedDate = item.saved_at
        ? new Date(item.saved_at).toLocaleDateString(undefined, {
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
              {`${source}${savedDate ? ` · Saved ${savedDate}` : ''}`}
            </Text>
            {item.content_snapshot ? (
              <Text
                style={[styles.itemSnippet, { color: c.textSecondary }]}
                numberOfLines={2}
              >
                {item.content_snapshot}
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

  const storagePercent = Math.min((items.length / MAX_OFFLINE) * 100, 100);

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      {/* Storage stats bar */}
      <View style={[styles.statsBar, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <Text style={[styles.statsText, { color: c.textSecondary }]}>
          {items.length}/{MAX_OFFLINE} articles saved
        </Text>
        <View style={[styles.progressTrack, { backgroundColor: c.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${storagePercent}%` as `${number}%`,
                backgroundColor: storagePercent > 80 ? '#e63946' : '#4caf50',
              },
            ]}
          />
        </View>
      </View>

      {items.length === 0 ? (
        <View style={[styles.centered, { backgroundColor: c.background }]}>
          <Text style={styles.emptyIcon}>📥</Text>
          <Text style={[styles.emptyTitle, { color: c.text }]}>No offline articles</Text>
          <Text style={[styles.emptySub, { color: c.textSecondary }]}>
            Open any article and tap the download icon to save it for offline reading.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.article.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
        />
      )}
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
  statsBar: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 8,
  },
  statsText: { fontSize: 13, fontWeight: '500' },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
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

export default OfflineReadingScreen;
