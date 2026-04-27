import React, { useCallback } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;

const ArticleDetailScreen: React.FC<Props> = ({ route }) => {
  const { article } = route.params;

  const handleReadFull = useCallback(async () => {
    const supported = await Linking.canOpenURL(article.url);
    if (supported) {
      await Linking.openURL(article.url);
    } else {
      Alert.alert('Error', 'Unable to open this URL.');
    }
  }, [article.url]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {article.image_url ? (
        <Image
          source={{ uri: article.image_url }}
          style={styles.image}
          contentFit="cover"
          transition={300}
        />
      ) : null}

      <View style={styles.body}>
        {article.categories?.name ? (
          <Text style={styles.category}>{article.categories.name}</Text>
        ) : null}

        <Text style={styles.title}>{article.title}</Text>

        <View style={styles.metaRow}>
          <Text style={styles.source}>
            {article.sources?.name ?? 'Unknown Source'}
          </Text>
          {article.published_at ? (
            <Text style={styles.date}>
              {new Date(article.published_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>
          ) : null}
        </View>

        {article.snippet ? (
          <Text style={styles.snippet}>{article.snippet}</Text>
        ) : null}

        <TouchableOpacity style={styles.button} onPress={handleReadFull} activeOpacity={0.85}>
          <Text style={styles.buttonText}>Read Full Article</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    paddingBottom: 40,
  },
  image: {
    width: '100%',
    height: 240,
  },
  body: {
    padding: 16,
  },
  category: {
    fontSize: 13,
    fontWeight: '700',
    color: '#e63946',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a1a1a',
    lineHeight: 30,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  source: {
    fontSize: 13,
    color: '#888',
    fontWeight: '600',
  },
  date: {
    fontSize: 13,
    color: '#aaa',
  },
  snippet: {
    fontSize: 16,
    color: '#333',
    lineHeight: 26,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#e63946',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});

export default ArticleDetailScreen;
