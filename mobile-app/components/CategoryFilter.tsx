import React from 'react';
import {
  ScrollView,
  TouchableOpacity,
  Text,
  StyleSheet,
  View,
} from 'react-native';
import { Category } from '../types';

interface Props {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const CategoryFilter: React.FC<Props> = ({ categories, selectedId, onSelect }) => {
  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.container}
      >
        <TouchableOpacity
          style={[styles.chip, selectedId === null && styles.chipActive]}
          onPress={() => onSelect(null)}
        >
          <Text style={[styles.chipText, selectedId === null && styles.chipTextActive]}>
            All
          </Text>
        </TouchableOpacity>
        {categories.map((cat) => (
          <TouchableOpacity
            key={cat.id}
            style={[styles.chip, selectedId === cat.id && styles.chipActive]}
            onPress={() => onSelect(cat.id)}
          >
            <Text
              style={[styles.chipText, selectedId === cat.id && styles.chipTextActive]}
            >
              {cat.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  container: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  chipActive: {
    backgroundColor: '#e63946',
    borderColor: '#e63946',
  },
  chipText: {
    fontSize: 13,
    color: '#555',
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
});

export default CategoryFilter;
