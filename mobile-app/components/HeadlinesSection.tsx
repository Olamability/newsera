import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import HeadlineCarousel from './HeadlineCarousel';
import { fetchHeadlinesPublic } from '../services/newsServicePublic';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const HeadlinesSection: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [headlines, setHeadlines] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const loadHeadlines = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const data = await fetchHeadlinesPublic();
      setHeadlines(data);
    } catch (err) {
      console.warn('[HeadlinesSection] Failed to load headlines:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHeadlines();
  }, [loadHeadlines]);

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
});
