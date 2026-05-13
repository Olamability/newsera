import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CompositeNavigationProp } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList, MainTabParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { openStoreReview } from '../services/rateUsService';

type Nav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Me'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const ProfileScreen: React.FC = () => {
  const navigation = useNavigation<Nav>();
  const { user, signOut } = useAuth();
  const { themeMode, setThemeMode } = useTheme();
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          setLoading(true);
          try {
            await signOut();
            navigation.replace('MainTabs');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to sign out.';
            Alert.alert('Error', message);
          } finally {
            setLoading(false);
          }
        },
      },
    ]);
  };

  const handleRateUs = useCallback(async () => {
    await openStoreReview();
  }, []);

  const ArrowIcon = () => (
    <Ionicons name="chevron-forward" size={18} color="#ccc" />
  );

  // Toggles between dark and light mode while preserving 'system' when toggling off.
  const handleDarkModeToggle = (v: boolean) =>
    setThemeMode(v ? 'dark' : themeMode === 'system' ? 'system' : 'light');

  const darkModeSwitch = (
    <Switch
      value={themeMode === 'dark'}
      onValueChange={handleDarkModeToggle}
      trackColor={{ false: '#ccc', true: '#e63946' }}
      thumbColor="#fff"
    />
  );

  // ─── Section Renderer ─────────────────────────────────────────────────────

  const renderMenuItem = (
    iconName: React.ComponentProps<typeof Ionicons>['name'],
    label: string,
    onPress: () => void,
    rightElement?: React.ReactNode,
    last = false
  ) => (
    <React.Fragment key={label}>
      <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.7}>
        <View style={styles.menuIconWrap}>
          <Ionicons name={iconName} size={20} color="#e63946" />
        </View>
        <Text style={styles.menuLabel}>{label}</Text>
        {rightElement ?? <ArrowIcon />}
      </TouchableOpacity>
      {!last && <View style={styles.divider} />}
    </React.Fragment>
  );

  // ─── Not Logged In ─────────────────────────────────────────────────────────

  if (!user) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        {/* Guest header */}
        <View style={styles.avatarContainer}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={36} color="#fff" />
          </View>
          <Text style={styles.guestText}>Not signed in</Text>
          <Text style={styles.guestSub}>Sign in to access all features</Text>
        </View>

        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => navigation.navigate('Login')}
          activeOpacity={0.85}
        >
          <Text style={styles.signInText}>Sign In / Create Account</Text>
        </TouchableOpacity>

        {/* Limited access section */}
        <Text style={styles.sectionHeader}>DISCOVER</Text>
        <View style={styles.section}>
          {renderMenuItem('grid-outline', 'Widget', () => navigation.navigate('Widget'))}
          {renderMenuItem('globe-outline', 'Country & Language', () => navigation.navigate('CountryLanguage'))}
          {renderMenuItem('moon-outline', 'Dark Mode', () => {}, darkModeSwitch, true)}
        </View>

        <Text style={styles.sectionHeader}>SUPPORT</Text>
        <View style={styles.section}>
          {renderMenuItem('star-outline', 'Rate Us', handleRateUs)}
          {renderMenuItem('chatbubble-outline', 'Suggestions & Feedback', () => navigation.navigate('Feedback'), undefined, true)}
        </View>
      </ScrollView>
    );
  }

  // ─── Logged In ─────────────────────────────────────────────────────────────

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* User header */}
      <View style={styles.avatarContainer}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user.email?.[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
        <Text style={styles.email}>{user.email}</Text>
        <Text style={styles.guestSub}>Member</Text>
      </View>

      {/* My Content */}
      <Text style={styles.sectionHeader}>MY CONTENT</Text>
      <View style={styles.section}>
        {renderMenuItem('bookmark-outline', 'Favorites', () => navigation.navigate('Bookmarks'))}
        {renderMenuItem('time-outline', 'Recently Viewed', () => navigation.navigate('RecentlyViewed'))}
        {renderMenuItem('download-outline', 'Offline Reading', () => navigation.navigate('OfflineReading'))}
        {renderMenuItem('bookmarks-outline', 'Read Later', () => navigation.navigate('ReadLater'), undefined, true)}
      </View>

      {/* Tools */}
      <Text style={styles.sectionHeader}>TOOLS</Text>
      <View style={styles.section}>
        {renderMenuItem('grid-outline', 'Widget', () => navigation.navigate('Widget'))}
        {renderMenuItem('mail-outline', 'Inbox', () => navigation.navigate('Inbox'))}
        {renderMenuItem('notifications-outline', 'Notifications', () => navigation.navigate('Notifications'))}
        {renderMenuItem('gift-outline', 'Rewards', () => navigation.navigate('Rewards'), undefined, true)}
      </View>

      {/* Settings */}
      <Text style={styles.sectionHeader}>SETTINGS</Text>
      <View style={styles.section}>
        {renderMenuItem('globe-outline', 'Country & Language', () => navigation.navigate('CountryLanguage'))}
        {renderMenuItem('settings-outline', 'App Settings', () => navigation.navigate('Settings'))}
        {renderMenuItem('ban-outline', 'Blocked Users', () => navigation.navigate('BlockedUsers'))}
        {renderMenuItem('moon-outline', 'Dark Mode', () => {}, darkModeSwitch, true)}
      </View>

      {/* Support */}
      <Text style={styles.sectionHeader}>SUPPORT</Text>
      <View style={styles.section}>
        {renderMenuItem('star-outline', 'Rate Us', handleRateUs)}
        {renderMenuItem('chatbubble-outline', 'Suggestions & Feedback', () => navigation.navigate('Feedback'), undefined, true)}
      </View>

      {/* Sign Out */}
      <TouchableOpacity
        style={[styles.signOutBtn, loading && styles.signOutBtnDisabled]}
        onPress={handleSignOut}
        disabled={loading}
        activeOpacity={0.85}
      >
        {loading ? (
          <ActivityIndicator color="#e63946" />
        ) : (
          <Text style={styles.signOutText}>Sign Out</Text>
        )}
      </TouchableOpacity>

      <View style={styles.bottomPad} />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContent: {
    paddingTop: 0,
    paddingBottom: 32,
  },
  avatarContainer: {
    alignItems: 'center',
    paddingVertical: 28,
    backgroundColor: '#fff',
    marginBottom: 20,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e63946',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 36,
    fontWeight: '700',
    color: '#fff',
  },
  email: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '600',
    marginBottom: 4,
  },
  guestText: {
    fontSize: 18,
    color: '#1a1a1a',
    fontWeight: '700',
    marginBottom: 4,
  },
  guestSub: {
    fontSize: 13,
    color: '#888',
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 8,
  },
  section: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#eee',
    marginBottom: 20,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  menuIconWrap: {
    width: 32,
    alignItems: 'center',
    marginRight: 12,
  },
  menuLabel: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: '#f0f0f0',
    marginLeft: 64,
  },
  signInBtn: {
    marginHorizontal: 20,
    marginBottom: 24,
    paddingVertical: 15,
    borderRadius: 10,
    backgroundColor: '#e63946',
    alignItems: 'center',
  },
  signInText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  signOutBtn: {
    marginHorizontal: 20,
    marginTop: 4,
    paddingVertical: 15,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#e63946',
    alignItems: 'center',
  },
  signOutBtnDisabled: {
    opacity: 0.6,
  },
  signOutText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e63946',
  },
  bottomPad: {
    height: 16,
  },
});

export default ProfileScreen;
