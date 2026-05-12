import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';

const WIDGET_META: Array<{
  id: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}> = [
  { id: 'headlines', label: 'Headlines', icon: 'newspaper-outline' },
  { id: 'trending', label: 'Trending', icon: 'trending-up-outline' },
  { id: 'politics', label: 'Politics', icon: 'business-outline' },
  { id: 'sports', label: 'Sports', icon: 'football-outline' },
  { id: 'entertainment', label: 'Entertainment', icon: 'film-outline' },
  { id: 'tech', label: 'AI & Tech', icon: 'hardware-chip-outline' },
];

const WidgetScreen: React.FC = () => {
  const { theme } = useTheme();
  const { prefs, updatePrefs, loaded } = useSettings();
  const c = theme.colors;

  const [order, setOrder] = useState<string[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!loaded) return;
    const validOrder =
      prefs.widgetOrder.length > 0 ? prefs.widgetOrder : WIDGET_META.map((w) => w.id);
    setOrder(validOrder);
    const enabledMap: Record<string, boolean> = {};
    WIDGET_META.forEach((w) => {
      enabledMap[w.id] = prefs.widgetEnabled[w.id] ?? true;
    });
    setEnabled(enabledMap);
  }, [loaded, prefs]);

  const toggleWidget = useCallback(
    async (id: string, value: boolean) => {
      const updated = { ...enabled, [id]: value };
      setEnabled(updated);
      await updatePrefs({ widgetEnabled: updated });
    },
    [enabled, updatePrefs]
  );

  const moveUp = useCallback(
    async (index: number) => {
      if (index === 0) return;
      const newOrder = [...order];
      [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
      setOrder(newOrder);
      await updatePrefs({ widgetOrder: newOrder });
    },
    [order, updatePrefs]
  );

  const moveDown = useCallback(
    async (index: number) => {
      if (index === order.length - 1) return;
      const newOrder = [...order];
      [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
      setOrder(newOrder);
      await updatePrefs({ widgetOrder: newOrder });
    },
    [order, updatePrefs]
  );

  if (!loaded) return null;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={[styles.hint, { color: c.textSecondary }]}>
          Enable or disable sections and reorder them to customise your home feed.
        </Text>

        <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>SECTIONS</Text>

        <View style={[styles.list, { backgroundColor: c.surface, borderColor: c.border }]}>
          {order.map((id, index) => {
            const meta = WIDGET_META.find((w) => w.id === id);
            if (!meta) return null;
            return (
              <View key={id}>
                <View style={styles.row}>
                  {/* Icon + label */}
                  <View style={[styles.iconWrap, { backgroundColor: c.background }]}>
                    <Ionicons name={meta.icon} size={20} color="#e63946" />
                  </View>
                  <Text style={[styles.label, { color: c.text }]}>{meta.label}</Text>

                  {/* Reorder buttons */}
                  <TouchableOpacity
                    onPress={() => moveUp(index)}
                    disabled={index === 0}
                    style={[styles.arrowBtn, index === 0 && styles.arrowDisabled]}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons
                      name="chevron-up"
                      size={18}
                      color={index === 0 ? c.border : c.textSecondary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => moveDown(index)}
                    disabled={index === order.length - 1}
                    style={[
                      styles.arrowBtn,
                      index === order.length - 1 && styles.arrowDisabled,
                    ]}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons
                      name="chevron-down"
                      size={18}
                      color={
                        index === order.length - 1 ? c.border : c.textSecondary
                      }
                    />
                  </TouchableOpacity>

                  {/* Enable toggle */}
                  <Switch
                    value={enabled[id] ?? true}
                    onValueChange={(v) => toggleWidget(id, v)}
                    trackColor={{ false: '#ccc', true: '#e63946' }}
                    thumbColor="#fff"
                    style={styles.switch}
                  />
                </View>
                {index < order.length - 1 && (
                  <View style={[styles.divider, { backgroundColor: c.border }]} />
                )}
              </View>
            );
          })}
        </View>

        <Text style={[styles.footerNote, { color: c.textSecondary }]}>
          Changes are saved automatically.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  list: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  arrowBtn: {
    padding: 4,
    marginHorizontal: 2,
  },
  arrowDisabled: {
    opacity: 0.3,
  },
  switch: {
    marginLeft: 8,
  },
  divider: {
    height: 1,
    marginLeft: 64,
  },
  footerNote: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 20,
  },
});

export default WidgetScreen;
