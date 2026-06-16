/**
 * outboundClickService.ts
 *
 * Phase 1 + Phase 3 — Traffic Attribution & In-App Browser (Option B)
 *
 * Responsibilities:
 *  1. Build a tracked URL by appending standard UTM parameters so Google
 *     Analytics shows NewsEra as the traffic source on every publisher site.
 *  2. Log each outbound tap to `article_outbound_clicks` (Supabase) so we
 *     can report "NewsEra sent X visits this month" to publishers.
 *  3. Open the publisher URL inside an in-app browser (Chrome Custom Tabs
 *     on Android, SFSafariViewController on iOS) using
 *     react-native-inappbrowser-reborn.
 *       ✅ Publisher analytics work correctly (real browser session)
 *       ✅ Publisher ads load correctly
 *       ✅ Publisher gets full credit
 *       ✅ User stays inside NewsEra (no context switch to another app)
 *     Falls back to Linking.openURL if InAppBrowser is unavailable.
 *
 * UTM parameters added to every outbound URL:
 *   utm_source   = newsera
 *   utm_medium   = aggregator
 *   utm_campaign = feed
 */

import { Alert, Platform } from 'react-native';
import { Linking } from 'react-native';
import InAppBrowser from 'react-native-inappbrowser-reborn';
import { supabasePublic } from './supabase';

// ─── Brand Colors ─────────────────────────────────────────────────────────────

/** NewsEra primary red — used to brand the in-app browser toolbar. */
const BRAND_COLOR = '#e63946';
const BRAND_TEXT_COLOR = '#ffffff';

// ─── UTM Constants ────────────────────────────────────────────────────────────

const UTM_SOURCE = 'newsera';
const UTM_MEDIUM = 'aggregator';
const UTM_CAMPAIGN = 'feed';

/** UTM values used when the publisher URL is included in a user share. */
const UTM_SHARE_MEDIUM = 'share';
const UTM_SHARE_CAMPAIGN = 'user_share';

// ─── URL Builder ──────────────────────────────────────────────────────────────

interface UtmOverrides {
  medium?: string;
  campaign?: string;
}

/**
 * Appends UTM query parameters to any URL.
 *
 * Handles both clean URLs and those already containing a query string.
 * Uses the WHATWG URL API (available in Hermes / React Native) for robust
 * parsing; falls back to string concatenation if parsing throws.
 *
 * @param rawUrl   - The original publisher URL.
 * @param overrides - Optional override for utm_medium / utm_campaign.
 *                    Defaults: medium=aggregator, campaign=feed.
 *
 * @example
 * buildTrackedUrl('https://bbc.com/news/story-123')
 * // → '...?utm_source=newsera&utm_medium=aggregator&utm_campaign=feed'
 *
 * buildTrackedUrl('https://bbc.com/news/story-123', { medium: 'share', campaign: 'user_share' })
 * // → '...?utm_source=newsera&utm_medium=share&utm_campaign=user_share'
 */
export function buildTrackedUrl(rawUrl: string, overrides: UtmOverrides = {}): string {
  const medium = overrides.medium ?? UTM_MEDIUM;
  const campaign = overrides.campaign ?? UTM_CAMPAIGN;
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set('utm_source', UTM_SOURCE);
    parsed.searchParams.set('utm_medium', medium);
    parsed.searchParams.set('utm_campaign', campaign);
    return parsed.toString();
  } catch {
    // Fallback for malformed URLs — append manually rather than crash
    const separator = rawUrl.includes('?') ? '&' : '?';
    return (
      `${rawUrl}${separator}` +
      `utm_source=${UTM_SOURCE}` +
      `&utm_medium=${medium}` +
      `&utm_campaign=${campaign}`
    );
  }
}

/**
 * Builds a UTM-tagged URL specifically for user shares.
 * Uses utm_medium=share & utm_campaign=user_share so GA4 can distinguish
 * organic aggregator traffic from user-driven referral traffic.
 */
export function buildShareTrackedUrl(rawUrl: string): string {
  return buildTrackedUrl(rawUrl, {
    medium: UTM_SHARE_MEDIUM,
    campaign: UTM_SHARE_CAMPAIGN,
  });
}

// ─── Click Logger ─────────────────────────────────────────────────────────────

interface OutboundClickPayload {
  articleId: string;
  sourceId: string | null;
  /** Authenticated user UUID — null for guests */
  userId: string | null;
  /** Device UUID from getDeviceId() — always present */
  deviceId: string;
  /** The full URL that was actually opened, including UTM params */
  utmUrl: string;
}

/**
 * Inserts a row into `article_outbound_clicks`.
 *
 * Fire-and-forget by design — a Supabase error must never block navigation.
 */
export async function logOutboundClick(payload: OutboundClickPayload): Promise<void> {
  const { error } = await supabasePublic.from('article_outbound_clicks').insert({
    article_id: payload.articleId,
    source_id: payload.sourceId ?? null,
    user_id: payload.userId ?? null,
    device_id: payload.deviceId,
    clicked_at: new Date().toISOString(),
    device_type: Platform.OS, // 'ios' | 'android' | 'web'
    utm_url: payload.utmUrl,
  });

  if (error && __DEV__) {
    console.warn('[OutboundClick] Failed to log click:', error.message);
  }
}

// ─── In-App Browser Opener ───────────────────────────────────────────────────

/**
 * Opens a URL using InAppBrowser (Chrome Custom Tab / SFSafariViewController).
 * Falls back to Linking.openURL if the in-app browser is not available.
 */
async function openInAppBrowser(url: string): Promise<void> {
  const isAvailable = await InAppBrowser.isAvailable();

  if (isAvailable) {
    await InAppBrowser.open(url, {
      // ── iOS options (SFSafariViewController) ──────────────────────────────
      dismissButtonStyle: 'done',
      preferredBarTintColor: BRAND_COLOR,
      preferredControlTintColor: BRAND_TEXT_COLOR,
      readerMode: false,
      animated: true,
      modalPresentationStyle: 'overFullScreen',
      modalTransitionStyle: 'crossDissolve',
      modalEnabled: true,
      enableBarCollapsing: true,

      // ── Android options (Chrome Custom Tabs) ──────────────────────────────
      showTitle: true,
      toolbarColor: BRAND_COLOR,
      secondaryToolbarColor: '#1a1a2e',
      navigationBarColor: '#1a1a2e',
      enableUrlBarHiding: true,
      enableDefaultShare: true,
      forceCloseOnRedirection: false,
      // Smooth slide-in animation matching React Navigation feel
      animations: {
        startEnter: 'slide_in_right',
        startExit: 'slide_out_left',
        endEnter: 'slide_in_left',
        endExit: 'slide_out_right',
      },
    });
  } else {
    // Fallback: open in the external default browser
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
    } else {
      Alert.alert('Cannot open article', 'This URL is not supported on your device.');
    }
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

interface OpenArticleUrlOptions {
  rawUrl: string;
  articleId: string;
  sourceId: string | null;
  userId: string | null;
  deviceId: string;
}

/**
 * The single function to call when a user taps "Read Full Article".
 *
 * Flow:
 *   1. Build a tracked URL with UTM params.
 *   2. Fire-and-forget: log the click to Supabase (never blocks step 3).
 *   3. Open URL in InAppBrowser (Chrome Custom Tab / SFSafariViewController)
 *      → falls back to Linking.openURL on unsupported devices.
 *
 * Navigation is never delayed or blocked by tracking. If Supabase is
 * unreachable the user still reaches the publisher's site immediately.
 */
export async function openArticleUrl(options: OpenArticleUrlOptions): Promise<void> {
  const { rawUrl, articleId, sourceId, userId, deviceId } = options;

  // Step 1: Build the UTM-tagged URL
  const trackedUrl = buildTrackedUrl(rawUrl);

  // Step 2: Log the click (fire-and-forget — never awaited, never throws)
  void logOutboundClick({
    articleId,
    sourceId,
    userId,
    deviceId,
    utmUrl: trackedUrl,
  }).catch(() => {
    // Silently swallow — tracking must never surface errors to users
  });

  // Step 3: Open in InAppBrowser (with Linking fallback)
  try {
    await openInAppBrowser(trackedUrl);
  } catch (err) {
    if (__DEV__) console.warn('[OutboundClick] InAppBrowser failed, falling back:', err);
    // Last-resort: try raw URL without UTM params
    try {
      await openInAppBrowser(rawUrl);
    } catch {
      Alert.alert('Error', 'Unable to open this article.');
    }
  }
}
