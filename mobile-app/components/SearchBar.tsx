import React from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  ViewStyle,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  containerStyle?: ViewStyle;
  editable?: boolean;
  autoFocus?: boolean;
}

const SearchBar: React.FC<Props> = ({
  value,
  onChangeText,
  onFocus,
  onBlur,
  placeholder = 'Search news, topics, categories...',
  containerStyle,
  editable = true,
  autoFocus = false,
}) => {
  return (
    <View style={[styles.container, containerStyle]}>
      <Ionicons name="search-outline" size={16} color="#9e9e9e" style={styles.icon} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor="#b0b0b0"
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        autoFocus={autoFocus}
        clearButtonMode="while-editing"
        selectionColor="#e63946"
        underlineColorAndroid="transparent"
      />
    </View>
  );
};

export default SearchBar;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f4f4f6',
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 9 : 6,
    flex: 1,
  },
  icon: {
    marginRight: 7,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#1a1a1a',
    padding: 0,
    margin: 0,
  },
});
