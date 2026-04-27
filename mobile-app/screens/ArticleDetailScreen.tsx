import React, { useCallback, useEffect } from 'react';
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
import { supabase } from '../services/supabase';
import { getDeviceId } from '../services/deviceId';
import { saveRecentlyViewed } from '../services/recentlyViewedService';
import { checkAndNotifyBreakingNews } from '../services/notificationService';

type Props = NativeStackScreenProps<RootStackParamList, 'ArticleDetail'>;

const ArticleDetailScreen: React.FC<Props> = ({ route }) => {
  const { article } = route.params;

  // Save to recently viewed and check for breaking news on screen mount
  useEffect(() => {
    saveRecentlyViewed(article);
    checkAndNotifyBreakingNews(article);
  }, [article]);

  const handleReadFull = useCallback(async () => {
    // Track click — non-blocking; link opens regardless of tracking result
    try {
      const deviceId = await getDeviceId();

      // Dedup: skip insert if this device already clicked this article in the last 30 seconds
      const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
      const { data: recent } = await supabase
        .from('article_clicks')
        .select('id')
        .eq('article_id', article.id)
        .eq('device_id', deviceId)
        .gte('clicked_at', thirtySecsAgo)
        .limit(1);

      if (!recent || recent.length === 0) {
        await supabase.from('article_clicks').insert({
          article_id: article.id,
          source_id: article.source_id,
          device_id: deviceId,
        });

        // Update user interest score for this article's category
        if (article.category_id) {
          const { data: existingInterest } = await supabase
            .from('user_interests')
            .select('id, score')
            .eq('user_id', deviceId)
            .eq('category_id', article.category_id)
            .limit(1);

          if (existingInterest && existingInterest.length > 0) {
            await supabase
              .from('user_interests')
              .update({
                score: existingInterest[0].score + 1,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existingInterest[0].id);
          } else {
            await supabase.from('user_interests').insert({
              user_id: deviceId,
              category_id: article.category_id,
              score: 1,
            });
          }
        }
      }
    } catch (_) {
      // tracking failure must never block navigation
    }

    const supported = await Linking.canOpenURL(article.url);
    if (supported) {
      await Linking.openURL(article.url);
    } else {
      Alert.alert('Error', 'Unable to open this URL.');
    }
  }, [article.id, article.source_id, article.category_id, article.url]);

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
