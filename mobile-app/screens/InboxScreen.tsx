import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  fetchInboxMessages,
  markMessageRead,
  deleteMessage,
} from '../services/inboxService';
import { InboxMessage, NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Inbox'>;

const TYPE_COLORS: Record<InboxMessage['type'], string> = {
  breaking: '#e63946',
  editorial: '#1976d2',
  reward: '#f59e0b',
  feature: '#388e3c',
  system: '#888888',
};

const TYPE_LABELS: Record<InboxMessage['type'], string> = {
  breaking: 'Breaking',
  editorial: 'Editorial',
  reward: 'Reward',
  feature: 'New Feature',
  system: 'System',
};

const InboxScreen: React.FC = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const c = theme.colors;

  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(1);

  const loadPage = useCallback(
    async (page: number, append: boolean) => {
      if (!user) return;
      try {
        const data = await fetchInboxMessages(user.id, page);
        setHasMore(data.length === 20);
        setMessages((prev) => (append ? [...prev, ...data] : data));
      } catch {
        if (!append) setMessages([]);
      }
    },
    [user]
  );

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    pageRef.current = 1;
    setLoading(true);
    loadPage(1, false).finally(() => setLoading(false));
  }, [user, loadPage]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !user) return;
    const nextPage = pageRef.current + 1;
    pageRef.current = nextPage;
    setLoadingMore(true);
    await loadPage(nextPage, true);
    setLoadingMore(false);
  }, [loadingMore, hasMore, user, loadPage]);

  const handlePress = useCallback(
    async (msg: InboxMessage) => {
      if (!msg.read) {
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, read: true } : m))
        );
        await markMessageRead(msg.id).catch(() => {});
      }
      if (msg.article_id && msg.article) {
        navigation.navigate('ArticleDetail', {
          article: msg.article as NewsArticle,
        });
      } else {
        Alert.alert(msg.title, msg.body);
      }
    },
    [navigation]
  );

  const handleDelete = useCallback(
    (msg: InboxMessage) => {
      if (!user) return;
      Alert.alert('Delete', 'Delete this message?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
            await deleteMessage(msg.id, user.id).catch(() => {});
          },
        },
      ]);
    },
    [user]
  );

  const renderItem = useCallback(
    ({ item }: { item: InboxMessage }) => {
      const date = new Date(item.created_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const tagColor = TYPE_COLORS[item.type] ?? '#888';
      return (
        <TouchableOpacity
          style={[
            styles.item,
            { backgroundColor: c.card, borderColor: c.border },
            !item.read && { borderLeftColor: '#e63946', borderLeftWidth: 3 },
          ]}
          onPress={() => handlePress(item)}
          onLongPress={() => handleDelete(item)}
          activeOpacity={0.8}
        >
          <View style={styles.itemHeader}>
            <View style={[styles.tag, { backgroundColor: tagColor }]}>
              <Text style={styles.tagText}>{TYPE_LABELS[item.type]}</Text>
            </View>
            {!item.read && <View style={styles.unreadDot} />}
            <Text style={[styles.date, { color: c.textSecondary }]}>{date}</Text>
          </View>
          <Text style={[styles.itemTitle, { color: c.text }]} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={[styles.itemBody, { color: c.textSecondary }]} numberOfLines={3}>
            {item.body}
          </Text>
        </TouchableOpacity>
      );
    },
    [c, handlePress, handleDelete]
  );

  if (!user) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>📬</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>Sign in for your inbox</Text>
        <Text style={[styles.emptySub, { color: c.textSecondary }]}>
          Sign in to receive editorial picks, breaking alerts and reward notifications.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (messages.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>📭</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>No messages yet</Text>
        <Text style={[styles.emptySub, { color: c.textSecondary }]}>
          Editorial updates, breaking alerts and reward notifications will appear here.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { backgroundColor: c.background }]}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator
              size="small"
              color="#888"
              style={{ paddingVertical: 16 }}
            />
          ) : null
        }
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
  list: { paddingVertical: 8, paddingHorizontal: 12, paddingBottom: 32 },
  item: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#e63946',
  },
  date: {
    fontSize: 11,
    marginLeft: 'auto',
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
    marginBottom: 4,
  },
  itemBody: {
    fontSize: 13,
    lineHeight: 18,
  },
});

export default InboxScreen;
