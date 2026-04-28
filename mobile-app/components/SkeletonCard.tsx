import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';

export default function SkeletonCard() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <View style={styles.card}>
      {/* Image placeholder */}
      <Animated.View style={[styles.image, { opacity }]} />

      {/* Content placeholder */}
      <View style={styles.content}>
        <Animated.View style={[styles.titleLine, styles.lineFull, { opacity }]} />
        <Animated.View style={[styles.titleLine, styles.lineFull, { opacity }]} />
        <Animated.View style={[styles.titleLine, styles.lineShort, { opacity }]} />
        <View style={styles.bottomRow}>
          <Animated.View style={[styles.sourceLine, { opacity }]} />
        </View>
      </View>
    </View>
  );
}

const SKELETON_COLOR = '#e0e0e0';

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    marginHorizontal: 12,
    marginVertical: 6,
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
  image: {
    width: 100,
    height: 100,
    borderRadius: 12,
    backgroundColor: SKELETON_COLOR,
  },
  content: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'space-between',
    minHeight: 100,
  },
  titleLine: {
    height: 14,
    borderRadius: 7,
    backgroundColor: SKELETON_COLOR,
    marginBottom: 8,
  },
  lineFull: {
    width: '100%',
  },
  lineShort: {
    width: '60%',
  },
  bottomRow: {
    marginTop: 8,
  },
  sourceLine: {
    height: 10,
    width: '40%',
    borderRadius: 5,
    backgroundColor: SKELETON_COLOR,
  },
});
