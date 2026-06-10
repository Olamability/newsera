import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Animated, Easing, Text, View, StyleSheet } from 'react-native';
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
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { SettingsProvider } from './context/SettingsContext';
import { registerForPushNotificationsAsync } from './services/notificationService';
import { emitHomeRefresh } from './services/homeRefreshBus';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

const ACTIVE_COLOR = '#e63946';
const INACTIVE_COLOR = '#9e9e9e';
const HOME_REFRESH_ROTATION_ANGLE = '180deg';

// Error Boundary Component to catch crashes and show user-friendly error
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={errorStyles.container}>
          <Ionicons name="alert-circle-outline" size={64} color="#e63946" />
          <Text style={errorStyles.title}>Something went wrong</Text>
          <Text style={errorStyles.message}>
            {this.state.error?.message || 'Please restart the app'}
          </Text>
        </View>
      );
    }

    return this.props.children;
  }
}

const errorStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 16,
    marginBottom: 8,
  },
  message: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginTop: 8,
  },
});

function MainTabs() {
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const c = theme.colors;
  const tabBarPaddingBottom = Math.max(insets.bottom, 10);
  const tabBarHeight = 56 + tabBarPaddingBottom;
  const homeRefreshSpin = useRef(new Animated.Value(0)).current;

  const spinStyle = useMemo(() => ({
    transform: [
      {
        rotate: homeRefreshSpin.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', HOME_REFRESH_ROTATION_ANGLE],
        }),
      },
    ],
  }), [homeRefreshSpin]);

  const animateHomeRefreshIcon = useCallback(() => {
    homeRefreshSpin.stopAnimation();
    homeRefreshSpin.setValue(0);
    Animated.timing(homeRefreshSpin, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      homeRefreshSpin.setValue(0);
    });
  }, [homeRefreshSpin]);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ color, size, focused }) => {
          let iconName: React.ComponentProps<typeof Ionicons>['name'];
          if (route.name === 'Home') {
            iconName = focused ? 'refresh' : 'home';
          } else if (route.name === 'Search') {
            iconName = 'search';
          } else if (route.name === 'Notifications') {
            iconName = 'notifications';
          } else {
            iconName = 'person';
          }
          if (route.name === 'Home') {
            return (
              <Animated.View style={focused ? spinStyle : undefined}>
                <Ionicons name={iconName} size={size} color={color} />
              </Animated.View>
            );
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
        listeners={({ navigation }) => ({
          tabPress: (event) => {
            if (!navigation.isFocused()) return;
            event.preventDefault();
            animateHomeRefreshIcon();
            emitHomeRefresh('active-tab-press');
          },
        })}
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
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <SettingsProvider>
            <AuthProvider>
              <AppNavigator />
            </AuthProvider>
          </SettingsProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
