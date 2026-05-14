import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Splash'>;

// How long to keep the branded splash on screen regardless of auth speed.
const SPLASH_MIN_MS = 2000;
// Hard ceiling: never stay on splash longer than this even if auth hangs.
const AUTH_SAFETY_MS = 6000;

const SplashScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { loading: authLoading } = useAuth();
  // Mirror authLoading into a ref so the safety-timer callback always sees the
  // latest value without needing it in the effect dependency array.
  const authLoadingRef = useRef(authLoading);
  authLoadingRef.current = authLoading;

  useEffect(() => {
    let cancelled = false;

    const performNavigation = () => {
      if (cancelled) return;
      // reset() instead of replace() ensures the splash screen is removed from
      // the back-stack entirely, so the Android hardware back button cannot
      // return to it.
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    };

    // Safety net: navigate unconditionally after AUTH_SAFETY_MS.  This
    // guarantees the app never freezes on splash even if auth state is never
    // resolved (e.g. network outage during session restore).
    const safetyTimer = setTimeout(performNavigation, AUTH_SAFETY_MS);

    const checkSession = async () => {
      // Minimum branding delay.
      await new Promise<void>((r) => setTimeout(r, SPLASH_MIN_MS));
      if (cancelled) return;

      if (!authLoadingRef.current) {
        // Auth is already resolved — navigate immediately and cancel the safety timer.
        clearTimeout(safetyTimer);
        performNavigation();
      }
      // If auth is still loading, the effect will re-run when authLoading
      // flips to false (because it is in the dep array), and performNavigation
      // will be called then.  The safetyTimer acts as the fallback.
    };

    void checkSession();

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  }, [navigation, authLoading]);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>Newsera</Text>
      <Text style={styles.tagline}>Your world. Your news.</Text>
      <ActivityIndicator size="large" color="#fff" style={styles.loader} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#e63946',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    fontSize: 48,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 1,
  },
  tagline: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 8,
    marginBottom: 40,
  },
  loader: {
    marginTop: 16,
  },
});

export default SplashScreen;
