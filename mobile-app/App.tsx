import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HomeScreen from './screens/HomeScreen';
import ArticleDetailScreen from './screens/ArticleDetailScreen';
import { RootStackParamList } from './types';
import { CategoryProvider } from './context/CategoryContext';
import { registerForPushNotificationsAsync } from './services/notificationService';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <CategoryProvider>
        <NavigationContainer>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: '#e63946' },
              headerTintColor: '#fff',
              headerTitleStyle: { fontWeight: '700' },
            }}
          >
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'NewsEra' }}
            />
            <Stack.Screen
              name="ArticleDetail"
              component={ArticleDetailScreen}
              options={{ title: 'Article' }}
            />
          </Stack.Navigator>
          <StatusBar style="light" />
        </NavigationContainer>
      </CategoryProvider>
    </SafeAreaProvider>
  );
}
