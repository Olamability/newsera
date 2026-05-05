/**
 * notificationService.ts
 *
 * Handles Expo push-notification registration and breaking-news detection.
 * Push delivery is currently simulated via console.log so the module can be
 * wired into a real Expo Push API call in the future with minimal changes.
 *
 * Also stores breaking-news notifications locally via AsyncStorage so the
 * NotificationsScreen can display them even when the app is restarted.
 */

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getDeviceId } from './deviceId';
import { NewsArticle } from '../types';

const STORED_NOTIFICATIONS_KEY = 'newsera_notifications';
const MAX_STORED_NOTIFICATIONS = 50;

// Push notifications and local notification scheduling are not supported in
// Expo Go (appOwnership === 'expo'). Use this constant to guard those paths.
const IS_EXPO_GO = Constants.appOwnership === 'expo';

export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  articleId: string;
  article: NewsArticle;
  receivedAt: string;
}

/** Persist a breaking-news notification to AsyncStorage. */
async function storeNotification(article: NewsArticle, body: string): Promise<void> {
  try {
    const existing = await getStoredNotifications();
    // Deduplicate by articleId — avoid storing the same article twice
    const filtered = existing.filter((n) => n.articleId !== article.id);
    const entry: StoredNotification = {
      id: `${article.id}_${Date.now()}`,
      title: 'NewsEra Breaking News',
      body,
      articleId: article.id,
      article,
      receivedAt: new Date().toISOString(),
    };
    const updated = [entry, ...filtered].slice(0, MAX_STORED_NOTIFICATIONS);
    await AsyncStorage.setItem(STORED_NOTIFICATIONS_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('[Notifications] Failed to store notification:', err);
  }
}

/** Retrieve all stored notifications (most recent first). */
export async function getStoredNotifications(): Promise<StoredNotification[]> {
  try {
    const raw = await AsyncStorage.getItem(STORED_NOTIFICATIONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredNotification[];
  } catch {
    return [];
  }
}

/** Remove a single stored notification by id. */
export async function removeStoredNotification(id: string): Promise<void> {
  try {
    const existing = await getStoredNotifications();
    const updated = existing.filter((n) => n.id !== id);
    await AsyncStorage.setItem(STORED_NOTIFICATIONS_KEY, JSON.stringify(updated));
  } catch {
    // non-fatal
  }
}

const HIGH_VELOCITY_THRESHOLD = 10;

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

    // Push token registration is only available in standalone/production builds.
    // In Expo Go (appOwnership === 'expo') getExpoPushTokenAsync() throws without
    // a valid projectId, so we skip it here.
    if (IS_EXPO_GO) {
      console.log('[Notifications] Expo Go detected — skipping push token registration.');
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenData.data;
    const deviceId = await getDeviceId();

    const { error: upsertError } = await supabase.from('user_devices').upsert(
      { device_id: deviceId, push_token: pushToken },
      { onConflict: 'device_id' }
    );

    if (upsertError) {
      console.warn('[Notifications] Failed to store push token:', upsertError.message);
    } else {
      console.log('[Notifications] Push token registered:', pushToken);
    }
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

    if ((count ?? 0) >= HIGH_VELOCITY_THRESHOLD) {
      isHighVelocity = true;
    }

    if (!isRecentArticle && !isHighVelocity) return;

    const message = `Breaking: ${article.title}`;

    // Schedule a local notification only in standalone/production builds.
    // expo-notifications scheduling is unreliable in Expo Go.
    if (!IS_EXPO_GO) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'NewsEra Breaking News',
          body: message,
          data: { articleId: article.id },
        },
        trigger: null, // deliver immediately
      });
    }

    // Persist to AsyncStorage so NotificationsScreen can display it
    await storeNotification(article, message);

    // Simulated remote push — replace with actual Expo Push API call
    console.log('[Notifications] Breaking news push (simulated):', message);
  } catch (err) {
    console.warn('[Notifications] Breaking-news check failed:', err);
  }
}
