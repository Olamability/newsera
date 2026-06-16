/**
 * app.config.js (CLEAN - NO STAGING LABELS)
 */

const appEnv = process.env.APP_ENV ?? 'development';

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  expo: {
    name: 'NewsEra', // ✅ fixed: always same name
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
        NSUserNotificationsUsageDescription:
          'NewsEra sends breaking news alerts and personalized notifications.',
        UIBackgroundModes: ['fetch', 'remote-notification'],
      },
    },

    android: {
      adaptiveIcon: {
        foregroundImage: './assets/icon.png',
        backgroundColor: '#ffffff',
      },
      package: 'com.newsera.mobile',
      permissions: [
        'RECEIVE_BOOT_COMPLETED',
        'VIBRATE',
        'INTERNET',
        'ACCESS_NETWORK_STATE',
      ],
    },

    web: {
      favicon: './assets/icon.png',
    },

    scheme: 'newsera',

    notification: {
      icon: './assets/icon.png',
      color: '#e63946',
      iosDisplayInForeground: true,
    },

    // ✅ Hermes enabled
    jsEngine: 'hermes',

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
            jvmArgs: ['-Xmx3G'],
            hermesEnabled: true,
          },
          ios: {
            hermesEnabled: true,
          },
        },
      ],
      'expo-secure-store',
      'expo-font',
      'expo-system-ui',
    ],

    extra: {
      appEnv,
      eas: {
        projectId: 'f0bcba5d-0b42-41c4-92dc-0569a26b659f',
      },
    },
  },
};