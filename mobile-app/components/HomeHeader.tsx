import React from 'react';
import {
  View,
  Image,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import SearchBar from './SearchBar';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Props {
  searchValue: string;
  onSearchChange: (text: string) => void;
}

const HomeHeader: React.FC<Props> = ({ searchValue, onSearchChange }) => {
  const navigation = useNavigation<Nav>();

  return (
    <View style={styles.container}>
      {/* Logo */}
      <Image
        source={require('../assets/icon.png')}
        style={styles.logo}
        resizeMode="contain"
      />

      {/* Search bar */}
      <SearchBar
        value={searchValue}
        onChangeText={onSearchChange}
        placeholder="Search news, topics, categories..."
        containerStyle={styles.searchFlex}
      />

      {/* Offline Reading button */}
      <TouchableOpacity
        style={styles.iconButton}
        onPress={() => navigation.navigate('OfflineReading')}
        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
        activeOpacity={0.7}
      >
        <Ionicons name="cloud-download-outline" size={24} color="#e63946" />
      </TouchableOpacity>
    </View>
  );
};

export default HomeHeader;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 8,
    flexShrink: 0,
  },
  searchFlex: {
    flex: 1,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#fff5f5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderColor: '#fde8e9',
  },
});
