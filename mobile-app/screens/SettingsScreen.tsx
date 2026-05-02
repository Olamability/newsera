import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: APP_VERSION } = require('../package.json') as { version: string };

const SETTINGS_KEY = 'newsera_settings';

interface AppSettings {
  pushNotifications: boolean;
  dataSaver: boolean;
  darkMode: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  pushNotifications: true,
  dataSaver: false,
  darkMode: false,
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

const SettingsScreen: React.FC = () => {
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
    <View style={styles.container}>
      <Text style={styles.sectionHeader}>Preferences</Text>

      <View style={styles.section}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Push Notifications</Text>
            <Text style={styles.rowSub}>Receive breaking news alerts</Text>
          </View>
          <Switch
            value={settings.pushNotifications}
            onValueChange={(v) => update({ pushNotifications: v })}
            trackColor={{ false: '#ccc', true: '#e63946' }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Data Saver</Text>
            <Text style={styles.rowSub}>Load lower-resolution images</Text>
          </View>
          <Switch
            value={settings.dataSaver}
            onValueChange={(v) => update({ dataSaver: v })}
            trackColor={{ false: '#ccc', true: '#e63946' }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Dark Mode</Text>
            <Text style={styles.rowSub}>Coming soon</Text>
          </View>
          <Switch
            value={settings.darkMode}
            onValueChange={(v) => update({ darkMode: v })}
            trackColor={{ false: '#ccc', true: '#e63946' }}
            thumbColor="#fff"
            disabled
          />
        </View>
      </View>

      <Text style={styles.version}>NewsEra v{APP_VERSION}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    paddingTop: 16,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginHorizontal: 20,
    marginBottom: 8,
  },
  section: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  row: {
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
  rowLabel: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '500',
  },
  rowSub: {
    fontSize: 13,
    color: '#888',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginLeft: 20,
  },
  version: {
    marginTop: 32,
    textAlign: 'center',
    fontSize: 13,
    color: '#bbb',
  },
});

export default SettingsScreen;
