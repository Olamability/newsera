/**
 * notificationService.ts
 *
 * Handles Expo push-notification registration and breaking-news detection.
 * Push delivery is currently simulated via console.log so the module can be
 * wired into a real Expo Push API call in the future with minimal changes.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { NewsArticle } from '../types';

const DEVICE_ID_KEY = 'newsera_device_id';

/** Returns the persistent device ID (same helper used by ArticleDetailScreen). */
async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Requests push-notification permission, obtains the Expo push token, and
 * persists it to the `user_devices` table (upsert by device_id).
 *
 * Safe to call multiple times — duplicate upserts are no-ops.
 */
export async function registerForPushNotificationsAsync(): Promise<void> {
  try {
    // Android requires an explicit notification channel
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#e63946',
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[Notifications] Permission not granted — skipping token registration.');
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenData.data;
    const deviceId = await getDeviceId();

    await supabase.from('user_devices').upsert(
      { device_id: deviceId, push_token: pushToken },
      { onConflict: 'device_id' }
    );

    console.log('[Notifications] Push token registered:', pushToken);
  } catch (err) {
    // Non-fatal — notification registration must never crash the app
    console.warn('[Notifications] Registration failed:', err);
  }
}

/**
 * Checks whether an article qualifies as "breaking news":
 *   • Published within the last 10 minutes, OR
 *   • Has a high click velocity (≥ 10 clicks in the last 10 minutes).
 *
 * When detected, a local notification is scheduled and a simulated push
 * payload is logged (replace the console.log with a real Expo Push API
 * call when ready).
 */
export async function checkAndNotifyBreakingNews(article: NewsArticle): Promise<void> {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // Check 1: very recent article
    const isRecentArticle =
      article.published_at != null &&
      new Date(article.published_at) >= tenMinutesAgo;

    // Check 2: high click velocity
    let isHighVelocity = false;
    const { count } = await supabase
      .from('article_clicks')
      .select('id', { count: 'exact', head: true })
      .eq('article_id', article.id)
      .gte('clicked_at', tenMinutesAgo.toISOString());

    if ((count ?? 0) >= 10) {
      isHighVelocity = true;
    }

    if (!isRecentArticle && !isHighVelocity) return;

    const message = `Breaking: ${article.title}`;

    // Schedule a local notification (visible even without a push server)
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'NewsEra Breaking News',
        body: message,
        data: { articleId: article.id },
      },
      trigger: null, // deliver immediately
    });

    // Simulated remote push — replace with actual Expo Push API call
    console.log('[Notifications] Breaking news push (simulated):', message);
  } catch (err) {
    console.warn('[Notifications] Breaking-news check failed:', err);
  }
}
