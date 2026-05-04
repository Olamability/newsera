import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Splash'>;

const SplashScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      // Show splash for at least 2 seconds for branding
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (cancelled) return;

      navigation.replace('MainTabs');
    };

    checkSession();

    return () => {
      cancelled = true;
    };
  }, [navigation]);

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
