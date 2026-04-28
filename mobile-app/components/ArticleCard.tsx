import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { NewsArticle } from '../types';

interface Props {
  article: NewsArticle;
  onPress: (article: NewsArticle) => void;
}

const PLACEHOLDER_COLOR = '#e8e8e8';

export default function ArticleCard({ article, onPress }: Props) {
  const sourceName = article.source_name ?? article.sources?.name ?? 'Unknown Source';
  const likeCount = article.like_count ?? 0;
  const commentCount = article.comment_count ?? 0;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onPress(article)}
      activeOpacity={0.85}
    >
      {/* Left: Image */}
      {article.image_url ? (
        <Image
          source={{ uri: article.image_url }}
          style={styles.image}
          resizeMode="cover"
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
    </TouchableOpacity>
  );
}

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
});
