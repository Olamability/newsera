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
import { fetchArticles } from '../services/newsService';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const HEADLINES_LIMIT = 8;

const HeadlinesSection: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const [headlines, setHeadlines] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const loadHeadlines = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const { articles } = await fetchArticles(1, null);
      // Prefer articles with images; pad with any remaining if needed
      const withImages = articles.filter((a) => a.image_url);
      const withoutImages = articles.filter((a) => !a.image_url);
      const combined = [...withImages, ...withoutImages].slice(0, HEADLINES_LIMIT);
      setHeadlines(combined);
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
