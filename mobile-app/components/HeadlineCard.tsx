import React from 'react';
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

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SMALL_SCREEN_THRESHOLD = 360;
const MIN_CARD_HEIGHT = 196;
const MAX_CARD_HEIGHT = 232;
const CARD_HEIGHT_RATIO = 0.56;

export const CARD_WIDTH = SCREEN_WIDTH - 48;
export const CARD_HEIGHT = Math.max(MIN_CARD_HEIGHT, Math.min(MAX_CARD_HEIGHT, Math.round(SCREEN_WIDTH * CARD_HEIGHT_RATIO)));
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
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const HeadlineCard: React.FC<Props> = ({ article, onPress }) => {
  const sourceName =
    article.source_name ?? article.sources?.name ?? 'Unknown Source';
  const timestamp = formatTimestamp(article.published_at);

  const cardContent = (
    <View style={styles.card}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.55)']}
        locations={[0.1, 0.58, 1]}
        style={styles.gradientOverlay}
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.42)']}
        locations={[0.35, 1]}
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

  if (article.image_url) {
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => onPress(article)}
        style={styles.touchable}
      >
        <View style={styles.imageBackground}>
          <Image
            source={{ uri: article.image_url }}
            style={styles.backgroundImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            placeholder={{ blurhash: FEED_IMAGE_BLURHASH }}
            transition={260}
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
      onPress={() => onPress(article)}
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
