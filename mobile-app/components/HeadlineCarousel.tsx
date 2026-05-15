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

const HeadlineCarousel: React.FC<Props> = ({ articles, loading }) => {
  const navigation = useNavigation<Nav>();

  const carouselItems = articles;

  const scrollRef = useRef<ScrollView>(null);
  const indexRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dotIndex, setDotIndex] = useState(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    if (carouselItems.length < 2) return;

    timerRef.current = setInterval(() => {
      const nextIndex = (indexRef.current + 1) % carouselItems.length;
      indexRef.current = nextIndex;

      scrollRef.current?.scrollTo({
        x: nextIndex * SNAP_INTERVAL,
        animated: true,
      });
      setDotIndex(nextIndex);
    }, AUTO_SCROLL_INTERVAL_MS);
  }, [carouselItems.length, stopTimer]);

  useEffect(() => {
    indexRef.current = 0;
    setDotIndex(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    startTimer();
    return () => {
      stopTimer();
    };
  }, [articles, startTimer, stopTimer]);

  const handlePress = (article: NewsArticle) => {
    navigation.navigate('ArticleDetail', { article });
  };

  const handleMomentumScrollEnd = useCallback((event: { nativeEvent: { contentOffset: { x: number } } }) => {
    if (carouselItems.length === 0) return;
    const rawIndex = Math.round(event.nativeEvent.contentOffset.x / SNAP_INTERVAL);
    const normalizedIndex = ((rawIndex % carouselItems.length) + carouselItems.length) % carouselItems.length;
    indexRef.current = normalizedIndex;
    setDotIndex(normalizedIndex);
  }, [carouselItems.length]);

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
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}
      >
        {carouselItems.map((article) => (
          <HeadlineCard
            key={article.id}
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
              key={`dot-${i}`}
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
