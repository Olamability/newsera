import React from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Category } from '../types';

export default function CategoryFilter({
    categories,
    selectedId,
    onSelect,
}: {
    categories: Category[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
}) {
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.container} keyboardShouldPersistTaps="handled">
            <TouchableOpacity onPress={() => onSelect(null)}>
                <Text style={[styles.item, !selectedId && styles.active]}>All</Text>
            </TouchableOpacity>

            {categories.map((cat) => (
                <TouchableOpacity key={cat.id} onPress={() => onSelect(cat.id)}>
                    <Text
                        style={[
                            styles.item,
                            selectedId === cat.id && styles.active,
                        ]}
                    >
                        {cat.name}
                    </Text>
                </TouchableOpacity>
            ))}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#fff',
        paddingVertical: 10,
        paddingLeft: 10,
    },
    item: {
        marginRight: 16,
        fontSize: 14,
        color: '#666',
    },
    active: {
        color: '#e63946',
        fontWeight: '700',
    },
});