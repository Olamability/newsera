import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import HomeScreen from './screens/HomeScreen';
import SearchScreen from './screens/SearchScreen';
import NotificationsScreen from './screens/NotificationsScreen';
import ProfileScreen from './screens/ProfileScreen';
import ArticleDetailScreen from './screens/ArticleDetailScreen';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import BookmarksScreen from './screens/BookmarksScreen';
import SettingsScreen from './screens/SettingsScreen';
import CategoryDetailScreen from './screens/CategoryDetailScreen';
import RecentlyViewedScreen from './screens/RecentlyViewedScreen';
import TrendingScreen from './screens/TrendingScreen';
import CountryLanguageScreen from './screens/CountryLanguageScreen';
import FeedbackScreen from './screens/FeedbackScreen';
import ReadLaterScreen from './screens/ReadLaterScreen';
import OfflineReadingScreen from './screens/OfflineReadingScreen';
import WidgetScreen from './screens/WidgetScreen';
import InboxScreen from './screens/InboxScreen';
import RewardsScreen from './screens/RewardsScreen';
import BlockedUsersScreen from './screens/BlockedUsersScreen';
import { RootStackParamList, MainTabParamList } from './types';
import { CategoryProvider } from './context/CategoryContext';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { SettingsProvider } from './context/SettingsContext';
import { registerForPushNotificationsAsync } from './services/notificationService';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

const ACTIVE_COLOR = '#e63946';
const INACTIVE_COLOR = '#9e9e9e';

function MainTabs() {
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const c = theme.colors;
  const tabBarPaddingBottom = Math.max(insets.bottom, 10);
  const tabBarHeight = 56 + tabBarPaddingBottom;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ color, size }) => {
          let iconName: React.ComponentProps<typeof Ionicons>['name'];
          if (route.name === 'Home') {
            iconName = 'home';
          } else if (route.name === 'Search') {
            iconName = 'search';
          } else if (route.name === 'Notifications') {
            iconName = 'notifications';
          } else {
            iconName = 'person';
          }
          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: ACTIVE_COLOR,
        tabBarInactiveTintColor: INACTIVE_COLOR,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderTopColor: c.border,
          paddingBottom: tabBarPaddingBottom,
          paddingTop: 4,
          height: tabBarHeight,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
          marginBottom: 2,
        },
        headerStyle: { backgroundColor: '#e63946' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
      })}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ headerShown: false, tabBarLabel: 'Home' }}
      />
      <Tab.Screen
        name="Search"
        component={SearchScreen}
        options={{ title: 'Search', tabBarLabel: 'Search' }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ title: 'Notifications', tabBarLabel: 'Notifications' }}
      />
      <Tab.Screen
        name="Me"
        component={ProfileScreen}
        options={{ title: 'My Profile', tabBarLabel: 'Me' }}
      />
    </Tab.Navigator>
  );
}

function AppNavigator() {
  const { isDark } = useTheme();

  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  return (
    <>
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Splash"
          screenOptions={{
            headerStyle: { backgroundColor: '#e63946' },
            headerTintColor: '#fff',
            headerTitleStyle: { fontWeight: '700' },
          }}
        >
          {/* Splash / onboarding */}
          <Stack.Screen
            name="Splash"
            component={SplashScreen}
            options={{ headerShown: false }}
          />

          {/* Auth screens */}
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Register"
            component={RegisterScreen}
            options={{ title: 'Create Account' }}
          />
          <Stack.Screen
            name="ForgotPassword"
            component={ForgotPasswordScreen}
            options={{ title: 'Reset Password' }}
          />

          {/* Main app — bottom tabs */}
          <Stack.Screen
            name="MainTabs"
            component={MainTabs}
            options={{ headerShown: false }}
          />

          {/* Detail screens that open above the tab bar */}
          <Stack.Screen
            name="ArticleDetail"
            component={ArticleDetailScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="CategoryDetail"
            component={CategoryDetailScreen}
            options={({ route }) => ({ title: route.params.categoryName })}
          />

          <Stack.Screen
            name="Trending"
            component={TrendingScreen}
            options={{ title: 'Headlines' }}
          />

          {/* Secondary screens */}
          <Stack.Screen
            name="Bookmarks"
            component={BookmarksScreen}
            options={{ title: 'My Bookmarks' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Settings' }}
          />
          <Stack.Screen
            name="RecentlyViewed"
            component={RecentlyViewedScreen}
            options={{ title: 'Recently Viewed' }}
          />

          {/* Feature screens — all fully implemented */}
          <Stack.Screen
            name="Widget"
            component={WidgetScreen}
            options={{ title: 'Customise Feed' }}
          />
          <Stack.Screen
            name="Inbox"
            component={InboxScreen}
            options={{ title: 'Inbox' }}
          />
          <Stack.Screen
            name="OfflineReading"
            component={OfflineReadingScreen}
            options={{ title: 'Offline Reading' }}
          />
          <Stack.Screen
            name="ReadLater"
            component={ReadLaterScreen}
            options={{ title: 'Read Later' }}
          />
          <Stack.Screen
            name="BlockedUsers"
            component={BlockedUsersScreen}
            options={{ title: 'Blocked Content' }}
          />
          <Stack.Screen
            name="CountryLanguage"
            component={CountryLanguageScreen}
            options={{ title: 'Country & Language' }}
          />
          <Stack.Screen
            name="Rewards"
            component={RewardsScreen}
            options={{ title: 'Rewards' }}
          />
          <Stack.Screen
            name="Feedback"
            component={FeedbackScreen}
            options={{ title: 'Suggestions & Feedback' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SettingsProvider>
          <AuthProvider>
            <CategoryProvider>
              <AppNavigator />
            </CategoryProvider>
          </AuthProvider>
        </SettingsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

