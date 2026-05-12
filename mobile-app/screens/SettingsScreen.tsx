import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { ThemeMode } from '../types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: APP_VERSION } = require('../package.json') as { version: string };

const SETTINGS_KEY = 'newsera_settings';

interface AppSettings {
  pushNotifications: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  pushNotifications: true,
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // non-fatal
  }
}

const THEME_OPTIONS: { value: ThemeMode; label: string; emoji: string }[] = [
  { value: 'light', label: 'Light', emoji: '☀️' },
  { value: 'dark', label: 'Dark', emoji: '🌙' },
  { value: 'system', label: 'Follow System', emoji: '🖥️' },
];

const SettingsScreen: React.FC = () => {
  const { themeMode, setThemeMode, theme } = useTheme();
  const { prefs, updatePrefs } = useSettings();
  const c = theme.colors;
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const update = (patch: Partial<AppSettings>) => {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    saveSettings(updated);
  };

  if (!loaded) return null;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {/* Appearance */}
      <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>APPEARANCE</Text>
      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        {THEME_OPTIONS.map((opt, index) => {
          const active = themeMode === opt.value;
          return (
            <View key={opt.value}>
              <TouchableOpacity
                style={styles.row}
                onPress={() => setThemeMode(opt.value)}
                activeOpacity={0.7}
              >
                <Text style={styles.optEmoji}>{opt.emoji}</Text>
                <Text style={[styles.rowLabel, { color: c.text }]}>{opt.label}</Text>
                {active && (
                  <Text style={[styles.activeCheck, { color: c.primary }]}>✓</Text>
                )}
              </TouchableOpacity>
              {index < THEME_OPTIONS.length - 1 && (
                <View style={[styles.divider, { backgroundColor: c.border }]} />
              )}
            </View>
          );
        })}
      </View>

      {/* Preferences */}
      <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>PREFERENCES</Text>
      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.switchRow}>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, { color: c.text }]}>Push Notifications</Text>
            <Text style={[styles.rowSub, { color: c.textSecondary }]}>
              Receive breaking news alerts
            </Text>
          </View>
          <Switch
            value={settings.pushNotifications}
            onValueChange={(v) => update({ pushNotifications: v })}
            trackColor={{ false: '#ccc', true: '#e63946' }}
            thumbColor="#fff"
          />
        </View>

        <View style={[styles.divider, { backgroundColor: c.border }]} />

        <View style={styles.switchRow}>
          <View style={styles.rowText}>
            <Text style={[styles.rowLabel, { color: c.text }]}>Data Saver</Text>
            <Text style={[styles.rowSub, { color: c.textSecondary }]}>
              Load lower-resolution images
            </Text>
          </View>
          <Switch
            value={prefs.dataSaver}
            onValueChange={(v) => updatePrefs({ dataSaver: v })}
            trackColor={{ false: '#ccc', true: '#e63946' }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <Text style={[styles.version, { color: c.border }]}>NewsEra v{APP_VERSION}</Text>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingTop: 20, paddingBottom: 40 },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginHorizontal: 20,
    marginBottom: 8,
    marginTop: 4,
  },
  section: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  optEmoji: {
    fontSize: 18,
    marginRight: 14,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  activeCheck: {
    fontSize: 18,
    fontWeight: '700',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    justifyContent: 'space-between',
  },
  rowText: {
    flex: 1,
    marginRight: 16,
  },
  rowSub: {
    fontSize: 13,
    marginTop: 2,
  },
  divider: {
    height: 1,
    marginLeft: 20,
  },
  version: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 13,
  },
});

export default SettingsScreen;
