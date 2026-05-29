import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

interface Props {
  count: number;
  onPress: () => void;
}

/**
 * Floating "N new articles" banner shown when polling or realtime detects
 * new content. Tapping it merges the buffered new articles into the feed.
 *
 * Note: we intentionally do NOT scroll the user to the top — they keep
 * their reading position, matching the production-readiness requirement
 * "do NOT force-scroll users to top".
 *
 * The component returns null when `count <= 0`, so callers can render it
 * unconditionally and let it manage its own visibility.
 */
function NewArticlesBanner({ count, onPress }: Props) {
  if (count <= 0) return null;

  const label = count === 1 ? '1 new article' : `${count} new articles`;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Tap to refresh.`}
    >
      <Text style={styles.text}>↑ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 24,
    backgroundColor: '#e63946',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 10,
  },
  pressed: {
    opacity: 0.85,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});

export default React.memo(NewArticlesBanner);
