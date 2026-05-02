import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, TouchableOpacity } from 'react-native';
import HomeScreen from './screens/HomeScreen';
import ArticleDetailScreen from './screens/ArticleDetailScreen';
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import BookmarksScreen from './screens/BookmarksScreen';
import ProfileScreen from './screens/ProfileScreen';
import SettingsScreen from './screens/SettingsScreen';
import SearchScreen from './screens/SearchScreen';
import NotificationsScreen from './screens/NotificationsScreen';
import CategoryDetailScreen from './screens/CategoryDetailScreen';
import RecentlyViewedScreen from './screens/RecentlyViewedScreen';
import { RootStackParamList } from './types';
import { CategoryProvider } from './context/CategoryContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { registerForPushNotificationsAsync } from './services/notificationService';

const Stack = createNativeStackNavigator<RootStackParamList>();

function AppNavigator() {
  const { user } = useAuth();

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

          {/* Main app screens — publicly accessible */}
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={({ navigation }) => ({
              title: 'NewsEra',
              headerRight: () => (
                <>
                  <TouchableOpacity
                    onPress={() => navigation.navigate('Search')}
                    style={{ marginRight: 8 }}
                  >
                    <Text style={{ color: '#fff', fontSize: 22 }}>🔍</Text>
                  </TouchableOpacity>
                  {user ? (
                    <TouchableOpacity
                      onPress={() => navigation.navigate('Profile')}
                      style={{ marginRight: 4 }}
                    >
                      <Text style={{ color: '#fff', fontSize: 24 }}>👤</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      onPress={() => navigation.navigate('Login')}
                      style={{ marginRight: 4 }}
                    >
                      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
                        Sign In
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              ),
            })}
          />
          <Stack.Screen
            name="ArticleDetail"
            component={ArticleDetailScreen}
            options={{ title: 'Article' }}
          />
          <Stack.Screen
            name="Search"
            component={SearchScreen}
            options={{ title: 'Search' }}
          />
          <Stack.Screen
            name="CategoryDetail"
            component={CategoryDetailScreen}
            options={({ route }) => ({ title: route.params.categoryName })}
          />

          {/* Auth-protected screens */}
          <Stack.Screen
            name="Bookmarks"
            component={BookmarksScreen}
            options={{ title: 'My Bookmarks' }}
          />
          <Stack.Screen
            name="Profile"
            component={ProfileScreen}
            options={{ title: 'Profile' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Settings' }}
          />
          <Stack.Screen
            name="Notifications"
            component={NotificationsScreen}
            options={{ title: 'Notifications' }}
          />
          <Stack.Screen
            name="RecentlyViewed"
            component={RecentlyViewedScreen}
            options={{ title: 'Recently Viewed' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      {/* StatusBar must live outside NavigationContainer so it cannot be
          accidentally layered above interactive screens */}
      <StatusBar style="light" />
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <CategoryProvider>
          <AppNavigator />
        </CategoryProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
