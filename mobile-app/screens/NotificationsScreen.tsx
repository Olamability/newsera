import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CompositeNavigationProp, useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  getStoredNotifications,
  removeStoredNotification,
  StoredNotification,
} from '../services/notificationService';
import { RootStackParamList, MainTabParamList } from '../types';

type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Notifications'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const NotificationsScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);

  const load = useCallback(async () => {
    const stored = await getStoredNotifications();
    setNotifications(stored);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handlePress = useCallback(
    async (notification: StoredNotification) => {
      navigation.navigate('ArticleDetail', { article: notification.article });
    },
    [navigation]
  );

  const handleDismiss = useCallback(async (id: string) => {
    await removeStoredNotification(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: StoredNotification }) => {
      const date = new Date(item.receivedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return (
        <TouchableOpacity
          style={styles.item}
          onPress={() => handlePress(item)}
          activeOpacity={0.8}
        >
          <View style={styles.itemContent}>
            <Text style={styles.itemTitle} numberOfLines={2}>
              {item.body}
            </Text>
            <Text style={styles.itemDate}>{date}</Text>
          </View>
          <TouchableOpacity
            onPress={() => handleDismiss(item.id)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.dismiss}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      );
    },
    [handlePress, handleDismiss]
  );

  if (notifications.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyIcon}>🔔</Text>
        <Text style={styles.emptyTitle}>No notifications yet</Text>
        <Text style={styles.emptySub}>
          Breaking news alerts will appear here.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={notifications}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
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
    backgroundColor: '#f5f5f5',
    paddingVertical: 8,
    paddingBottom: 32,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginVertical: 5,
    borderRadius: 12,
    padding: 14,
  },
  itemContent: {
    flex: 1,
    marginRight: 10,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
    lineHeight: 20,
    marginBottom: 4,
  },
  itemDate: {
    fontSize: 12,
    color: '#888',
  },
  dismiss: {
    fontSize: 16,
    color: '#ccc',
    fontWeight: '700',
  },
});

export default NotificationsScreen;
