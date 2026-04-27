import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { NewsArticle } from '../types';

interface Props {
  article: NewsArticle;
  onPress: (article: NewsArticle) => void;
}

const { width } = Dimensions.get('window');
const CARD_IMAGE_HEIGHT = 200;

const ArticleCard: React.FC<Props> = ({ article, onPress }) => {
  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={() => onPress(article)}
    >
      {article.image_url ? (
        <Image
          source={{ uri: article.image_url }}
          style={styles.image}
          contentFit="cover"
          transition={300}
        />
      ) : (
        <View style={[styles.image, styles.imagePlaceholder]}>
          <Text style={styles.placeholderText}>No Image</Text>
        </View>
      )}
      <View style={styles.body}>
        {article.categories?.name ? (
          <Text style={styles.category}>{article.categories.name}</Text>
        ) : null}
        <Text style={styles.title} numberOfLines={3}>
          {article.title}
        </Text>
        {article.snippet ? (
          <Text style={styles.snippet} numberOfLines={3}>
            {article.snippet}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Text style={styles.source}>{article.sources?.name ?? 'Unknown Source'}</Text>
          {article.published_at ? (
            <Text style={styles.date}>
              {new Date(article.published_at).toLocaleDateString()}
            </Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 12,
    marginVertical: 6,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  image: {
    width: '100%',
    height: CARD_IMAGE_HEIGHT,
  },
  imagePlaceholder: {
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#9e9e9e',
    fontSize: 14,
  },
  body: {
    padding: 12,
  },
  category: {
    fontSize: 12,
    fontWeight: '600',
    color: '#e63946',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a1a',
    lineHeight: 22,
    marginBottom: 6,
  },
  snippet: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
    marginBottom: 8,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  source: {
    fontSize: 12,
    color: '#888',
    fontWeight: '500',
  },
  date: {
    fontSize: 12,
    color: '#aaa',
  },
});

export default ArticleCard;
