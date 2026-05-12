import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeMode, AppTheme } from '../types';

const THEME_KEY = 'newsera_theme_mode';

const LIGHT_COLORS: AppTheme['colors'] = {
  background: '#f2f2f2',
  surface: '#ffffff',
  primary: '#e63946',
  text: '#1a1a1a',
  textSecondary: '#888888',
  border: '#eeeeee',
  card: '#ffffff',
  accent: '#e63946',
  error: '#d32f2f',
  success: '#388e3c',
};

const DARK_COLORS: AppTheme['colors'] = {
  background: '#121212',
  surface: '#1e1e1e',
  primary: '#e63946',
  text: '#f0f0f0',
  textSecondary: '#aaaaaa',
  border: '#2e2e2e',
  card: '#1e1e1e',
  accent: '#e63946',
  error: '#ef5350',
  success: '#66bb6a',
};

interface ThemeContextValue {
  themeMode: ThemeMode;
  theme: AppTheme;
  setThemeMode: (mode: ThemeMode) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeMode: 'system',
  theme: { mode: 'light', colors: LIGHT_COLORS },
  setThemeMode: () => {},
  isDark: false,
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY)
      .then((val) => {
        if (val === 'light' || val === 'dark' || val === 'system') {
          setThemeModeState(val);
        }
      })
      .catch(() => {});
  }, []);

  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    AsyncStorage.setItem(THEME_KEY, mode).catch(() => {});
  };

  const isDark = useMemo(() => {
    if (themeMode === 'system') return systemScheme === 'dark';
    return themeMode === 'dark';
  }, [themeMode, systemScheme]);

  const theme: AppTheme = useMemo(
    () => ({
      mode: isDark ? 'dark' : 'light',
      colors: isDark ? DARK_COLORS : LIGHT_COLORS,
    }),
    [isDark]
  );

  return (
    <ThemeContext.Provider value={{ themeMode, theme, setThemeMode, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
