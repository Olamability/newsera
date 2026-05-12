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
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import {
  fetchBlockedEntries,
  unblockEntry,
  getBlockedSourceIds,
  unblockSourceLocally,
} from '../services/blockedUsersService';
import { BlockedEntry } from '../types';

const BlockedUsersScreen: React.FC = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const c = theme.colors;

  const [entries, setEntries] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (user) {
        const data = await fetchBlockedEntries(user.id);
        setEntries(data);
      } else {
        // Guest: show locally blocked source IDs only
        const ids = await getBlockedSourceIds();
        const guestEntries: BlockedEntry[] = ids.map((id) => ({
          id,
          blocked_source_id: id,
          created_at: '',
        }));
        setEntries(guestEntries);
      }
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUnblock = useCallback(
    (entry: BlockedEntry) => {
      Alert.alert('Unblock', 'Remove this block?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          style: 'destructive',
          onPress: async () => {
            setEntries((prev) => prev.filter((e) => e.id !== entry.id));
            if (user) {
              await unblockEntry(entry.id, user.id, entry.blocked_source_id).catch(() => {});
            } else if (entry.blocked_source_id) {
              await unblockSourceLocally(entry.blocked_source_id).catch(() => {});
            }
          },
        },
      ]);
    },
    [user]
  );

  const renderItem = useCallback(
    ({ item }: { item: BlockedEntry }) => {
      const name =
        item.blocked_source?.name ??
        (item.blocked_source_id ? `Source ID: ${item.blocked_source_id.slice(0, 8)}…` : 'Unknown');
      const date = item.created_at
        ? new Date(item.created_at).toLocaleDateString()
        : '';
      return (
        <View style={[styles.item, { backgroundColor: c.card, borderColor: c.border }]}>
          <View style={styles.itemContent}>
            <Text style={[styles.itemName, { color: c.text }]}>{name}</Text>
            {date ? (
              <Text style={[styles.itemDate, { color: c.textSecondary }]}>
                Blocked {date}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.unblockBtn, { borderColor: '#e63946' }]}
            onPress={() => handleUnblock(item)}
            activeOpacity={0.7}
          >
            <Text style={styles.unblockText}>Unblock</Text>
          </TouchableOpacity>
        </View>
      );
    },
    [c, handleUnblock]
  );

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>🚫</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>No blocked content</Text>
        <Text style={[styles.emptySub, { color: c.textSecondary }]}>
          You can block news sources from article pages. Blocked content will be hidden from your feed.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
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
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  itemContent: { flex: 1 },
  itemName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  itemDate: { fontSize: 12 },
  unblockBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  unblockText: {
    fontSize: 13,
    color: '#e63946',
    fontWeight: '700',
  },
});

export default BlockedUsersScreen;
