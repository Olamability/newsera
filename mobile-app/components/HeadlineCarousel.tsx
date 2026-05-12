import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import HeadlineCard, {
  CARD_WIDTH,
  SNAP_INTERVAL,
} from './HeadlineCard';
import { NewsArticle, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Props {
  articles: NewsArticle[];
  loading: boolean;
}

const SKELETON_COUNT = 3;
const AUTO_SCROLL_INTERVAL_MS = 3500;
const RESET_PAUSE_MS = 100;

const HeadlineCarousel: React.FC<Props> = ({ articles, loading }) => {
  const navigation = useNavigation<Nav>();

  // Prefer articles with images; fall back to all if none have images
  const carouselItems = articles.filter((a) => a.image_url).length > 0
    ? articles.filter((a) => a.image_url)
    : articles;

  // Triple the data for a seamless infinite-scroll illusion
  const tripled = carouselItems.length > 0
    ? [...carouselItems, ...carouselItems, ...carouselItems]
    : [];

  const scrollRef = useRef<ScrollView>(null);
  const indexRef = useRef(carouselItems.length); // start in middle set
  const isResettingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dotIndex, setDotIndex] = useState(0);
  const countRef = useRef(carouselItems.length);

  // Keep countRef in sync with carouselItems.length so the timer callback
  // always has the latest value without needing to be recreated.
  countRef.current = carouselItems.length;

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    if (countRef.current < 2) return;

    timerRef.current = setInterval(() => {
      if (isResettingRef.current) return;

      indexRef.current += 1;

      // When we reach the end of the second (middle) set, silently jump back
      if (indexRef.current >= countRef.current * 2) {
        isResettingRef.current = true;
        scrollRef.current?.scrollTo({
          x: countRef.current * SNAP_INTERVAL,
          animated: false,
        });
        indexRef.current = countRef.current;
        setTimeout(() => { isResettingRef.current = false; }, RESET_PAUSE_MS);
        setDotIndex(0);
        return;
      }

      scrollRef.current?.scrollTo({
        x: indexRef.current * SNAP_INTERVAL,
        animated: true,
      });
      setDotIndex(indexRef.current % countRef.current);
    }, AUTO_SCROLL_INTERVAL_MS);
  }, [stopTimer]);

  // On mount / items change: jump to middle set and kick off auto-scroll
  useEffect(() => {
    if (carouselItems.length === 0) return;

    const startOffset = carouselItems.length * SNAP_INTERVAL;
    const jumpTimer = setTimeout(() => {
      scrollRef.current?.scrollTo({ x: startOffset, animated: false });
      indexRef.current = carouselItems.length;
    }, 50);

    startTimer();

    return () => {
      clearTimeout(jumpTimer);
      stopTimer();
    };
  }, [carouselItems.length, startTimer, stopTimer]);

  const handlePress = (article: NewsArticle) => {
    navigation.navigate('ArticleDetail', { article });
  };

  if (loading) {
    return (
      <View style={styles.loadingRow}>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <View key={i} style={styles.skeleton} />
        ))}
      </View>
    );
  }

  if (carouselItems.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No headlines available</Text>
      </View>
    );
  }

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SNAP_INTERVAL}
        decelerationRate="fast"
        contentContainerStyle={styles.scrollContent}
        onScrollBeginDrag={stopTimer}
        onScrollEndDrag={startTimer}
        scrollEventThrottle={16}
      >
        {tripled.map((article, index) => (
          <HeadlineCard
            key={`${article.id}-${index}`}
            article={article}
            onPress={handlePress}
          />
        ))}
        <View style={styles.trailingSpace} />
      </ScrollView>

      {/* Dot indicators */}
      {carouselItems.length > 1 && (
        <View style={styles.dotsRow}>
          {carouselItems.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === dotIndex && styles.dotActive]}
            />
          ))}
        </View>
      )}
    </View>
  );
};

export default HeadlineCarousel;

const styles = StyleSheet.create({
  scrollContent: {
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
  },
  trailingSpace: {
    width: 12,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
    gap: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#d0d0d0',
  },
  dotActive: {
    width: 18,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#e63946',
  },
  loadingRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
  },
  skeleton: {
    width: CARD_WIDTH,
    height: 210,
    borderRadius: 16,
    backgroundColor: '#e8e8e8',
  },
  emptyContainer: {
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: '#aaa',
    fontSize: 14,
  },
});
