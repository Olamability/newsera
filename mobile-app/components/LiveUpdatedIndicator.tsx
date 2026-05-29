import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRelativeTime } from '../hooks/useRelativeTime';

interface Props {
  /** Newest article timestamp from the loaded feed (ISO string). */
  latestTimestamp: string | null | undefined;
}

/**
 * Subtle "Updated …" indicator rendered near the top of the feed.
 *
 * The label is driven by {@link useRelativeTime} which only triggers a
 * re-render when the displayed string changes — the rest of the feed is
 * unaffected by the 30s tick, so FlatList virtualization is preserved.
 */
function LiveUpdatedIndicator({ latestTimestamp }: Props) {
  const label = useRelativeTime(latestTimestamp ?? null, 30_000);
  if (!label) return null;

  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <View style={styles.dot} />
      <Text style={styles.text} numberOfLines={1}>
        Updated {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#2ecc71',
    marginRight: 6,
  },
  text: {
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});

export default React.memo(LiveUpdatedIndicator);
