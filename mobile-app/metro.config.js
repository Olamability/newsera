const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Optimize bundle size and enable minification
config.transformer = {
  ...config.transformer,
  minifierConfig: {
    compress: {
      // Drop console statements in production builds
      drop_console: process.env.APP_ENV === 'production',
    },
  },
};

module.exports = config;
