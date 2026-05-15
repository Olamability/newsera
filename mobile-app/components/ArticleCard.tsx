import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { NewsArticle } from '../types';

interface Props {
  article: NewsArticle;
  onPress: (article: NewsArticle) => void;
  /** Called when the user swipes left (bookmark action). */
  onSwipeLeft?: (article: NewsArticle) => void;
  /** Called when the user swipes right (share action). */
  onSwipeRight?: (article: NewsArticle) => void;
}

const PLACEHOLDER_COLOR = '#e8e8e8';
const SWIPE_THRESHOLD = 60;
const FEED_IMAGE_BLURHASH = 'L6Pj0^i_.AyE_3t7t7R**0o#DgR4';
const CARD_RIPPLE = { color: 'rgba(0,0,0,0.06)', borderless: false } as const;

function ArticleCard({ article, onPress, onSwipeLeft, onSwipeRight }: Props) {
  const sourceName = article.source_name ?? article.sources?.name ?? 'Unknown Source';
  const likeCount = article.like_count ?? 0;
  const commentCount = article.comment_count ?? 0;
  const [imageFailed, setImageFailed] = useState(false);

  const translateX = useRef(new Animated.Value(0)).current;
  const latestArticleRef = useRef(article);
  const latestSwipeLeftRef = useRef(onSwipeLeft);
  const latestSwipeRightRef = useRef(onSwipeRight);

  useEffect(() => {
    latestArticleRef.current = article;
    latestSwipeLeftRef.current = onSwipeLeft;
    latestSwipeRightRef.current = onSwipeRight;
  }, [article, onSwipeLeft, onSwipeRight]);

  useEffect(() => {
    setImageFailed(false);
  }, [article.image_url]);

  const imageSource = useMemo(() => (
    article.image_url ? { uri: article.image_url } : null
  ), [article.image_url]);

  const handleCardPress = useCallback(() => {
    onPress(article);
  }, [onPress, article]);

  const handleImageError = useCallback(() => {
    setImageFailed(true);
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      // Only capture gesture when horizontal movement is dominant
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8,
      onPanResponderMove: (_, { dx }) => {
        // Clamp so card doesn't fly too far off screen
        const clamped = Math.max(-120, Math.min(120, dx));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: (_, { dx }) => {
        const activeArticle = latestArticleRef.current;
        const swipeLeft = latestSwipeLeftRef.current;
        const swipeRight = latestSwipeRightRef.current;

        if (dx < -SWIPE_THRESHOLD && swipeLeft) {
          Animated.timing(translateX, {
            toValue: -300,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            swipeLeft(activeArticle);
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          });
        } else if (dx > SWIPE_THRESHOLD && swipeRight) {
          Animated.timing(translateX, {
            toValue: 300,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            swipeRight(activeArticle);
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          });
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  const hasSwipe = !!(onSwipeLeft || onSwipeRight);

  return (
    <View style={styles.swipeWrapper}>
      {/* Action revealed on swipe-right (share) */}
      {onSwipeRight ? (
        <View style={[styles.actionBg, styles.actionShareBg]}>
          <Text style={styles.actionText}>↗ Share</Text>
        </View>
      ) : null}
      {/* Action revealed on swipe-left (bookmark) */}
      {onSwipeLeft ? (
        <View style={[styles.actionBg, styles.actionBookmarkBg, styles.actionRight]}>
          <Text style={styles.actionText}>🔖 Save</Text>
        </View>
      ) : null}

      <Animated.View
        style={[styles.animatedCard, { transform: [{ translateX }] }]}
        {...(hasSwipe ? panResponder.panHandlers : {})}
      >
        <Pressable
          style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          onPress={handleCardPress}
          android_ripple={CARD_RIPPLE}
        >
      {/* Left: Image */}
      {imageSource && !imageFailed ? (
        <Image
          source={imageSource}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          placeholder={{ blurhash: FEED_IMAGE_BLURHASH }}
          transition={180}
          onError={handleImageError}
        />
      ) : (
        <View style={[styles.image, styles.placeholder]} />
      )}

      {/* Right: Content */}
      <View style={styles.content}>
        {/* Title */}
        <Text style={styles.title} numberOfLines={3} ellipsizeMode="tail">
          {article.title}
        </Text>

        {/* Bottom row: source + icons */}
        <View style={styles.bottomRow}>
          <Text style={styles.sourceName} numberOfLines={1}>
            {sourceName}
          </Text>

          <View style={styles.iconsRow}>
            <View style={styles.iconItem}>
              <Text style={styles.iconEmoji}>❤️</Text>
              <Text style={styles.iconCount}>{likeCount}</Text>
            </View>
            <View style={styles.iconItem}>
              <Text style={styles.iconEmoji}>💬</Text>
              <Text style={styles.iconCount}>{commentCount}</Text>
            </View>
          </View>
        </View>
      </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const areArticleCardPropsEqual = (prev: Props, next: Props): boolean => {
  if (prev.onPress !== next.onPress) return false;
  if (prev.onSwipeLeft !== next.onSwipeLeft) return false;
  if (prev.onSwipeRight !== next.onSwipeRight) return false;

  const previous = prev.article;
  const current = next.article;
  return previous.id === current.id
    && previous.title === current.title
    && previous.image_url === current.image_url
    && previous.source_name === current.source_name
    && previous.sources?.name === current.sources?.name
    && previous.like_count === current.like_count
    && previous.comment_count === current.comment_count;
};

export default React.memo(ArticleCard, areArticleCardPropsEqual);

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 12,
    alignItems: 'flex-start',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 6,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  cardPressed: {
    // iOS press feedback — Android uses android_ripple above
    opacity: 0.85,
  },
  animatedCard: {
    // Clip any ripple or press effect to the card boundary so action
    // backgrounds behind the card cannot leak through on press.
    overflow: 'hidden',
    borderRadius: 16,
    marginHorizontal: 12,
    marginVertical: 6,
  },
  image: {
    width: 100,
    height: 100,
    borderRadius: 12,
  },
  placeholder: {
    backgroundColor: PLACEHOLDER_COLOR,
  },
  content: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'space-between',
    minHeight: 100,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    lineHeight: 21,
    flexShrink: 1,
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  sourceName: {
    flex: 1,
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
    marginRight: 8,
  },
  iconsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  iconItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  iconEmoji: {
    fontSize: 13,
  },
  iconCount: {
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
  },
  swipeWrapper: {
    overflow: 'hidden',
    position: 'relative',
  },
  actionBg: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    width: 80,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
  },
  actionShareBg: {
    left: 12,
    backgroundColor: '#4caf50',
  },
  actionBookmarkBg: {
    backgroundColor: '#e63946',
  },
  actionRight: {
    right: 12,
    left: undefined,
  },
  actionText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});
