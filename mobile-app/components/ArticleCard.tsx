import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { NewsArticle } from '../types';

interface Props {
  article: NewsArticle;
  onPress: (article: NewsArticle) => void;
}

export default function ArticleCard({ article, onPress }: Props) {
  return (
    <TouchableOpacity style={styles.card} onPress={() => onPress(article)}>
      {article.image_url ? (
        <Image source={{ uri: article.image_url }} style={styles.image} />
      ) : (
        <View style={styles.placeholder} />
      )}

      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {article.title}
        </Text>

        <Text style={styles.meta}>
          {article.sources?.name ?? 'News'} •{' '}
          {article.published_at
            ? new Date(article.published_at).toLocaleDateString()
            : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 12,
    marginVertical: 8,
    overflow: 'hidden',
    elevation: 2,
  },
  image: {
    width: '100%',
    height: 200,
  },
  placeholder: {
    height: 200,
    backgroundColor: '#eee',
  },
  content: {
    padding: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  meta: {
    marginTop: 6,
    fontSize: 12,
    color: '#888',
  },
});