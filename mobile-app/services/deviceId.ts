/**
 * deviceId.ts
 *
 * Provides a persistent, per-device identifier stored in AsyncStorage.
 * The ID is generated once using the Web Crypto API (available in React
 * Native's Hermes engine and via react-native-url-polyfill) so it is
 * cryptographically random rather than Math.random()-based.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_ID_KEY = 'newsera_device_id';

/** Generates a UUID v4 using the Web Crypto API (crypto.getRandomValues). */
function generateSecureUUID(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  // Set version (4) and variant bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

/**
 * Returns the persistent device ID, generating and storing one on first call.
 * Uses crypto.getRandomValues for cryptographically-secure UUID generation.
 */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateSecureUUID();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
