import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { Country, Language } from '../types';

const COUNTRIES: Country[] = [
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
  { code: 'GH', name: 'Ghana', flag: '🇬🇭' },
  { code: 'KE', name: 'Kenya', flag: '🇰🇪' },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
];

const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ha', name: 'Hausa', nativeName: 'Hausa' },
  { code: 'yo', name: 'Yoruba', nativeName: 'Yorùbá' },
  { code: 'ig', name: 'Igbo', nativeName: 'Igbo' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
];

const CountryLanguageScreen: React.FC = () => {
  const { theme } = useTheme();
  const { prefs, updatePrefs } = useSettings();
  const c = theme.colors;

  const [country, setCountry] = useState(prefs.country);
  const [language, setLanguage] = useState(prefs.language);
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(async () => {
    await updatePrefs({ country, language });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [country, language, updatePrefs]);

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Country */}
        <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>COUNTRY</Text>
        <View style={[styles.listContainer, { backgroundColor: c.surface, borderColor: c.border }]}>
          {COUNTRIES.map((item, index) => {
            const active = item.code === country;
            return (
              <View key={item.code}>
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => setCountry(item.code)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.flag}>{item.flag}</Text>
                  <Text style={[styles.rowLabel, { color: c.text }]}>{item.name}</Text>
                  {active && <Text style={[styles.check, { color: c.primary }]}>✓</Text>}
                </TouchableOpacity>
                {index < COUNTRIES.length - 1 && (
                  <View style={[styles.divider, { backgroundColor: c.border }]} />
                )}
              </View>
            );
          })}
        </View>

        {/* Language */}
        <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>LANGUAGE</Text>
        <View style={[styles.listContainer, { backgroundColor: c.surface, borderColor: c.border }]}>
          {LANGUAGES.map((item, index) => {
            const active = item.code === language;
            return (
              <View key={item.code}>
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => setLanguage(item.code)}
                  activeOpacity={0.7}
                >
                  <View style={styles.langTextWrap}>
                    <Text style={[styles.rowLabel, { color: c.text }]}>{item.name}</Text>
                    {item.nativeName !== item.name && (
                      <Text style={[styles.nativeName, { color: c.textSecondary }]}>
                        {item.nativeName}
                      </Text>
                    )}
                  </View>
                  {active && <Text style={[styles.check, { color: c.primary }]}>✓</Text>}
                </TouchableOpacity>
                {index < LANGUAGES.length - 1 && (
                  <View style={[styles.divider, { backgroundColor: c.border }]} />
                )}
              </View>
            );
          })}
        </View>

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveBtn, saved && styles.saveBtnDone]}
          onPress={handleSave}
          activeOpacity={0.85}
        >
          <Text style={styles.saveText}>{saved ? '✓ Saved!' : 'Save Preferences'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 8,
  },
  listContainer: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  flag: {
    fontSize: 22,
    marginRight: 14,
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  check: {
    fontSize: 18,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    marginLeft: 52,
  },
  langTextWrap: { flex: 1 },
  nativeName: { fontSize: 13, marginTop: 1 },
  saveBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: '#e63946',
    alignItems: 'center',
    marginTop: 8,
  },
  saveBtnDone: {
    backgroundColor: '#388e3c',
  },
  saveText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});

export default CountryLanguageScreen;
