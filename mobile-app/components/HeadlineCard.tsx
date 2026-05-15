import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { NewsArticle } from '../types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const CARD_WIDTH = SCREEN_WIDTH - 48;
export const CARD_HEIGHT = 210;
export const CARD_SPACING = 12;
export const SNAP_INTERVAL = CARD_WIDTH + CARD_SPACING;
const FEED_IMAGE_BLURHASH = 'L6Pj0^i_.AyE_3t7t7R**0o#DgR4';

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
      {/* Bottom gradient overlay */}
      <View style={styles.gradientOverlayTop} />
      <View style={styles.gradientOverlayBottom} />

      {/* Content at the bottom */}
      <View style={styles.content}>
        <View style={styles.metaRow}>
          <Text style={styles.sourceName} numberOfLines={1}>
            {sourceName}
          </Text>
          {timestamp ? (
            <Text style={styles.timestamp}>{timestamp}</Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={3} ellipsizeMode="tail">
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
            transition={220}
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
  gradientOverlayTop: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.03)',
  },
  gradientOverlayBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: CARD_HEIGHT * 0.45,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  content: {
    padding: 14,
    paddingBottom: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sourceName: {
    fontSize: 11,
    fontWeight: '700',
    color: '#e63946',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
    marginRight: 8,
  },
  timestamp: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '400',
    textShadowColor: 'rgba(0,0,0,0.22)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    lineHeight: 21,
    textShadowColor: 'rgba(0,0,0,0.32)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
