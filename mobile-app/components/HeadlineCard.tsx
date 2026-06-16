import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { NewsArticle } from '../types';
import { resolveArticleSourceName } from '../services/shareService';
import { formatRelativeTime } from '../services/relativeTime';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SMALL_SCREEN_THRESHOLD = 360;
const MIN_CARD_HEIGHT = 196;
const MAX_CARD_HEIGHT = 232;
const CARD_HEIGHT_RATIO = 0.56;
const PREMIUM_GRADIENT_COLORS = ['rgba(0,0,0,0)', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.45)'] as const;
const PREMIUM_GRADIENT_LOCATIONS = [0.1, 0.58, 1] as const;
const TEXT_REGION_GRADIENT_COLORS = ['rgba(0,0,0,0)', 'rgba(0,0,0,0.32)'] as const;
const TEXT_REGION_GRADIENT_LOCATIONS = [0.35, 1] as const;

export const CARD_WIDTH = SCREEN_WIDTH - 48;
const calculateCardHeight = (screenWidth: number): number =>
  Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, Math.round(screenWidth * CARD_HEIGHT_RATIO)));

export const CARD_HEIGHT = calculateCardHeight(SCREEN_WIDTH);
export const CARD_SPACING = 12;
export const SNAP_INTERVAL = CARD_WIDTH + CARD_SPACING;
const FEED_IMAGE_BLURHASH = 'L6Pj0^i_.AyE_3t7t7R**0o#DgR4';
const TITLE_LINES = SCREEN_WIDTH < SMALL_SCREEN_THRESHOLD ? 2 : 3;
const TITLE_FONT_SIZE = SCREEN_WIDTH < SMALL_SCREEN_THRESHOLD ? 14 : 16;

interface Props {
  article: NewsArticle;
  onPress: (article: NewsArticle) => void;
}

function formatTimestamp(dateStr: string | null): string {
  // Single source of truth for relative time labels across the feed; keeps
  // headline cards and the "Updated …" indicator visually consistent.
  return formatRelativeTime(dateStr) ?? '';
}

const HeadlineCard: React.FC<Props> = ({ article, onPress }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const [timestamp, setTimestamp] = useState<string>(() => 
    formatTimestamp(article.published_at)
  );
  const sourceName = resolveArticleSourceName(article);
  const imageSource = useMemo(() => (
    article.image_url ? { uri: article.image_url } : null
  ), [article.image_url]);

  useEffect(() => {
    setImageFailed(false);
  }, [article.image_url]);

  // Update timestamp every 30 seconds for dynamic relative time
  useEffect(() => {
    const updateTimestamp = () => {
      const next = formatTimestamp(article.published_at);
      setTimestamp((prev) => (prev === next ? prev : next));
    };

    // Update immediately
    updateTimestamp();

    // Then update every 30 seconds
    const interval = setInterval(updateTimestamp, 30_000);
    return () => clearInterval(interval);
  }, [article.published_at]);

  const handlePress = useCallback(() => {
    onPress(article);
  }, [onPress, article]);

  const handleImageError = useCallback(() => {
    setImageFailed(true);
  }, []);

  const cardContent = (
    <View style={styles.card}>
      <LinearGradient
        pointerEvents="none"
        colors={PREMIUM_GRADIENT_COLORS}
        locations={PREMIUM_GRADIENT_LOCATIONS}
        style={styles.gradientOverlay}
      />
      <LinearGradient
        pointerEvents="none"
        colors={TEXT_REGION_GRADIENT_COLORS}
        locations={TEXT_REGION_GRADIENT_LOCATIONS}
        style={styles.textRegionBlend}
      />

      <View style={styles.content}>
        <View style={styles.metaRow}>
          <Text style={styles.sourceName} numberOfLines={1}>
            {sourceName}
          </Text>
          {timestamp ? (
            <Text style={styles.timestamp}>{timestamp}</Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={TITLE_LINES} ellipsizeMode="tail">
          {article.title}
        </Text>
      </View>
    </View>
  );

  if (imageSource && !imageFailed) {
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={handlePress}
        style={styles.touchable}
      >
        <View style={styles.imageBackground}>
          <Image
            source={imageSource}
            style={styles.backgroundImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            placeholder={{ blurhash: FEED_IMAGE_BLURHASH }}
            transition={260}
            onError={handleImageError}
          />
          {cardContent}
        </View>
      </TouchableOpacity>
    );
  }

  // Fallback when no image
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={handlePress}
      style={styles.touchable}
    >
      <View style={[styles.imageBackground, styles.noImageBackground]}>
        {cardContent}
      </View>
    </TouchableOpacity>
  );
};

export default React.memo(HeadlineCard);

const styles = StyleSheet.create({
  touchable: {
    marginRight: CARD_SPACING,
    borderRadius: 16,
    overflow: 'hidden',
    // Shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  imageBackground: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 16,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  backgroundImage: {
    ...StyleSheet.absoluteFillObject,
  },
  noImageBackground: {
    backgroundColor: '#2c2c2e',
  },
  card: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  gradientOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
  },
  textRegionBlend: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: CARD_HEIGHT * 0.52,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  content: {
    paddingHorizontal: 15,
    paddingTop: 12,
    paddingBottom: 16,
    minHeight: Math.max(86, Math.round(CARD_HEIGHT * 0.42)),
    justifyContent: 'flex-end',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sourceName: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#ffd7db',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    flex: 1,
    marginRight: 8,
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  timestamp: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.82)',
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  title: {
    fontSize: TITLE_FONT_SIZE,
    fontWeight: '800',
    color: '#ffffff',
    lineHeight: TITLE_FONT_SIZE * 1.35,
    letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.38)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
