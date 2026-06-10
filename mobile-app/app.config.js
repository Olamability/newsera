/**
 * app.config.js
 *
 * Dynamic Expo configuration that reads environment variables so secrets and
 * environment-specific values are never hardcoded in version control.
 *
 * Environment selection:
 *   APP_ENV=development  (default / Expo Go)
 *   APP_ENV=staging      (preview EAS builds)
 *   APP_ENV=production   (production EAS builds / store submission)
 *
 * Required environment variables (must be set before building):
 *   EXPO_PUBLIC_SUPABASE_URL
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY
 *
 * Optional EAS / CI environment variables:
 *   EAS_BUILD_GIT_COMMIT_HASH   – auto-set by EAS, used in build metadata
 */

const appEnv = process.env.APP_ENV ?? 'development';

const envLabels = {
  development: '(Dev)',
  staging: '(Staging)',
  production: '',
};

const appNameSuffix = envLabels[appEnv] ?? '';
const appName = appNameSuffix ? `NewsEra ${appNameSuffix}` : 'NewsEra';

// Android version code is automatically incremented by EAS when autoIncrement
// is true; this value is the baseline for local/manual builds.
const ANDROID_VERSION_CODE = 1;

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  expo: {
    name: appName,
    slug: 'newsera',
    version: '1.0.0',
    orientation: 'portrait',


    cli: {
      appVersionSource: 'remote',
    },

    icon: './assets/icon.png',

    userInterfaceStyle: 'automatic',

    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },

    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.newsera.mobile',
      infoPlist: {
        // Push notifications usage description (required for App Store)
        NSUserNotificationsUsageDescription:
          'NewsEra sends breaking news alerts and personalized notifications.',
        // Background fetch so push delivery works when the app is backgrounded
        UIBackgroundModes: ['fetch', 'remote-notification'],
      },
    },

    android: {
      adaptiveIcon: {
        foregroundImage: './assets/icon.png',
        backgroundColor: '#ffffff',
      },
      package: 'com.newsera.mobile',
      versionCode: ANDROID_VERSION_CODE,
      permissions: [
        // Push notifications
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
        // Network (implicit but declaring keeps the manifest clean)
        'INTERNET',
        'ACCESS_NETWORK_STATE',
      ],
    },

    web: {
      favicon: './assets/icon.png',
    },

    // Deep-link scheme used by Supabase auth redirects
    scheme: 'newsera',

    // Expo notification configuration
    notification: {
      icon: './assets/icon.png',
      color: '#e63946',
      iosDisplayInForeground: true,
    },

    plugins: [
      [
        'expo-notifications',
        {
          icon: './assets/icon.png',
          color: '#e63946',
          defaultChannel: 'default',
        },
      ],
      [
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            minifyEnabled: true,
            shrinkResources: true,
            jvmArgs: ['-Xmx3G']
          }
        }
      ],
      'expo-secure-store',
      'expo-font',
      'expo-system-ui',
    ],

    extra: {
      // Surface the active environment to the JS bundle for runtime checks
      appEnv,
      eas: {
        projectId: 'f0bcba5d-0b42-41c4-92dc-0569a26b659f',
      },
    },
  },
};