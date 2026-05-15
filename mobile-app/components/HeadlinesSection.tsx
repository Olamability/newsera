import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  AppStateStatus,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import HeadlineCarousel from './HeadlineCarousel';
import { fetchHeadlinesPublic, invalidateHeadlinesPublicCache } from '../services/newsServicePublic';
import { NewsArticle, RootStackParamList } from '../types';
import { supabasePublic } from '../services/supabase';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Props = {
  refreshSignal?: number;
};
type RefreshMode = 'normal' | 'force' | 'ifStale';
const REFRESH_COOLDOWN_MS = 1200;
const HEADLINES_STALE_MS = 60000;

const HeadlinesSection: React.FC<Props> = ({ refreshSignal = 0 }) => {
  const navigation = useNavigation<Nav>();
  const [headlines, setHeadlines] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const lastUpdatedAtRef = useRef<number | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRequestRef = useRef(0);
  const isRefreshingRef = useRef(false);

  const loadHeadlines = useCallback(async (forceRefresh: boolean = false) => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    if (forceRefresh) invalidateHeadlinesPublicCache();
    try {
      const data = await fetchHeadlinesPublic();
      setHeadlines(data);
      const now = Date.now();
      setLastUpdatedAt(now);
      lastUpdatedAtRef.current = now;
    } catch (err) {
      console.warn('[HeadlinesSection] Failed to load headlines:', err);
    } finally {
      isRefreshingRef.current = false;
      setLoading(false);
    }
  }, []);

  const requestRefresh = useCallback((mode: RefreshMode = 'normal') => {
    const forceRefresh = mode === 'force' || mode === 'ifStale';
    if (
      mode === 'ifStale' &&
      lastUpdatedAtRef.current &&
      Date.now() - lastUpdatedAtRef.current < HEADLINES_STALE_MS
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastRefreshRequestRef.current < REFRESH_COOLDOWN_MS) return;
    lastRefreshRequestRef.current = now;
    void loadHeadlines(forceRefresh);
  }, [loadHeadlines]);

  useEffect(() => {
    requestRefresh();
  }, [requestRefresh]);

  useEffect(() => {
    if (refreshSignal <= 0) return;
    requestRefresh('force');
  }, [refreshSignal, requestRefresh]);

  useFocusEffect(
    useCallback(() => {
      requestRefresh('ifStale');
    }, [requestRefresh]),
  );

  useEffect(() => {
    const onAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        requestRefresh('ifStale');
      }
    };
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, [requestRefresh]);

  useEffect(() => {
    const channel = supabasePublic
      .channel('headlines-article-updates')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'articles' },
        () => {
          if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
          refreshTimeoutRef.current = setTimeout(() => {
            requestRefresh('force');
          }, 400);
        },
      )
      .subscribe();

    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      void supabasePublic.removeChannel(channel);
    };
  }, [requestRefresh]);

  return (
    <View style={styles.section}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Headlines</Text>
        <TouchableOpacity
          style={styles.seeMoreButton}
          onPress={() => navigation.navigate('Trending')}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.seeMoreText}>See More</Text>
          <Ionicons name="chevron-forward" size={14} color="#e63946" />
        </TouchableOpacity>
      </View>

      {/* Carousel */}
      <HeadlineCarousel articles={headlines} loading={loading} />
      {lastUpdatedAt ? (
        <Text
          style={styles.refreshMeta}
          accessibilityLabel={`Headlines last updated at ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
        >
          Updated {new Date(lastUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </Text>
      ) : null}
    </View>
  );
};

export default HeadlinesSection;

const styles = StyleSheet.create({
  section: {
    marginBottom: 16,
    paddingTop: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1a1a1a',
    letterSpacing: -0.3,
  },
  seeMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  seeMoreText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e63946',
  },
  refreshMeta: {
    marginTop: 8,
    marginHorizontal: 16,
    fontSize: 11,
    color: '#8a8a8a',
  },
});
