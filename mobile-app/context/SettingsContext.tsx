import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserPreferences } from '../types';

const PREFS_KEY = 'newsera_user_prefs';

const DEFAULT_PREFS: UserPreferences = {
  country: 'NG',
  language: 'en',
  widgetOrder: ['headlines', 'trending', 'politics', 'sports', 'entertainment', 'tech'],
  widgetEnabled: {
    headlines: true,
    trending: true,
    politics: true,
    sports: true,
    entertainment: true,
    tech: true,
  },
  dataSaver: false,
};

interface SettingsContextValue {
  prefs: UserPreferences;
  updatePrefs: (patch: Partial<UserPreferences>) => Promise<void>;
  loaded: boolean;
}

const SettingsContext = createContext<SettingsContextValue>({
  prefs: DEFAULT_PREFS,
  updatePrefs: async () => {},
  loaded: false,
});

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<UserPreferences>;
            setPrefs({ ...DEFAULT_PREFS, ...parsed });
          } catch {
            // corrupted — keep defaults
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const updatePrefs = async (patch: Partial<UserPreferences>) => {
    const updated = { ...prefs, ...patch };
    setPrefs(updated);
    try {
      await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(updated));
    } catch {
      // non-fatal
    }
  };

  return (
    <SettingsContext.Provider value={{ prefs, updatePrefs, loaded }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext);
