import { Alert, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const RATE_US_KEY = 'newsera_rate_us';
// Update APP_STORE_ID with the production app identifiers when available.
const ANDROID_PACKAGE = 'com.newsera.app';
const IOS_APP_ID = '000000000'; // placeholder — replace before release

interface RateUsState {
  lastPromptedAt?: string;
  rated: boolean;
  neverAsk: boolean;
  launchCount: number;
}

async function getRateUsState(): Promise<RateUsState> {
  try {
    const raw = await AsyncStorage.getItem(RATE_US_KEY);
    return raw
      ? (JSON.parse(raw) as RateUsState)
      : { rated: false, neverAsk: false, launchCount: 0 };
  } catch {
    return { rated: false, neverAsk: false, launchCount: 0 };
  }
}

async function setRateUsState(state: RateUsState): Promise<void> {
  try {
    await AsyncStorage.setItem(RATE_US_KEY, JSON.stringify(state));
  } catch {
    // non-fatal
  }
}

export async function incrementLaunchCount(): Promise<void> {
  const state = await getRateUsState();
  await setRateUsState({ ...state, launchCount: state.launchCount + 1 });
}

export async function openStoreReview(): Promise<void> {
  const state = await getRateUsState();
  await setRateUsState({ ...state, rated: true, lastPromptedAt: new Date().toISOString() });

  const url =
    Platform.OS === 'android'
      ? `market://details?id=${ANDROID_PACKAGE}`
      : `itms-apps://itunes.apple.com/app/id${IOS_APP_ID}?action=write-review`;

  const fallbackUrl =
    Platform.OS === 'android'
      ? `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`
      : `https://apps.apple.com/app/id${IOS_APP_ID}?action=write-review`;

  try {
    const canOpen = await Linking.canOpenURL(url).catch(() => false);
    await Linking.openURL(canOpen ? url : fallbackUrl);
  } catch {
    Alert.alert('Rate Us', 'Thank you for your support! ⭐');
  }
}

/** Returns true if the app should prompt the user to rate it. */
export async function shouldPromptRating(): Promise<boolean> {
  const state = await getRateUsState();
  if (state.rated || state.neverAsk) return false;
  if (state.launchCount < 5) return false;
  if (state.lastPromptedAt) {
    const daysSince =
      (Date.now() - new Date(state.lastPromptedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) return false;
  }
  return true;
}

export async function dismissRatingPrompt(neverAsk = false): Promise<void> {
  const state = await getRateUsState();
  await setRateUsState({
    ...state,
    neverAsk,
    lastPromptedAt: new Date().toISOString(),
  });
}
