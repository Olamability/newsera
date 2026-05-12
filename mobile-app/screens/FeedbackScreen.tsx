import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { submitFeedback, FeedbackCategory } from '../services/feedbackService';

const CATEGORIES: { value: FeedbackCategory; label: string; emoji: string }[] = [
  { value: 'bug', label: 'Bug Report', emoji: '🐛' },
  { value: 'feature', label: 'Feature Request', emoji: '💡' },
  { value: 'content', label: 'Content Issue', emoji: '📰' },
  { value: 'other', label: 'Other', emoji: '💬' },
];

const FeedbackScreen: React.FC = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const c = theme.colors;

  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (message.trim().length < 10) {
      Alert.alert('Message too short', 'Please write at least 10 characters.');
      return;
    }
    setLoading(true);
    try {
      await submitFeedback({
        category,
        message,
        email: email.trim() || undefined,
        userId: user?.id,
      });
      setSubmitted(true);
    } catch {
      Alert.alert('Error', 'Failed to submit feedback. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [category, message, email, user]);

  if (submitted) {
    return (
      <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
        <View style={styles.successContainer}>
          <Text style={styles.successIcon}>🎉</Text>
          <Text style={[styles.successTitle, { color: c.text }]}>Thank you!</Text>
          <Text style={[styles.successSub, { color: c.textSecondary }]}>
            Your feedback has been received. We read every message and use it to improve NewsEra.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Category */}
        <Text style={[styles.label, { color: c.textSecondary }]}>CATEGORY</Text>
        <View style={styles.categoryRow}>
          {CATEGORIES.map((cat) => {
            const active = cat.value === category;
            return (
              <TouchableOpacity
                key={cat.value}
                style={[
                  styles.categoryBtn,
                  { borderColor: active ? c.primary : c.border },
                  active && { backgroundColor: c.primary },
                ]}
                onPress={() => setCategory(cat.value)}
                activeOpacity={0.7}
              >
                <Text style={styles.catEmoji}>{cat.emoji}</Text>
                <Text
                  style={[
                    styles.catLabel,
                    { color: active ? '#fff' : c.text },
                  ]}
                >
                  {cat.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Message */}
        <Text style={[styles.label, { color: c.textSecondary }]}>MESSAGE *</Text>
        <TextInput
          style={[
            styles.textArea,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              color: c.text,
            },
          ]}
          placeholder="Describe your feedback in detail… (min. 10 characters)"
          placeholderTextColor={c.textSecondary}
          value={message}
          onChangeText={setMessage}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          maxLength={2000}
        />
        <Text style={[styles.charCount, { color: c.textSecondary }]}>
          {message.length}/2000
        </Text>

        {/* Email */}
        <Text style={[styles.label, { color: c.textSecondary }]}>
          EMAIL (optional — for follow-up)
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              color: c.text,
            },
          ]}
          placeholder="you@example.com"
          placeholderTextColor={c.textSecondary}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>Submit Feedback</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    padding: 20,
    paddingBottom: 40,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 10,
    marginTop: 20,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1.5,
    marginBottom: 4,
  },
  catEmoji: {
    fontSize: 16,
    marginRight: 6,
  },
  catLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    minHeight: 140,
    lineHeight: 22,
  },
  charCount: {
    fontSize: 11,
    textAlign: 'right',
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    height: 52,
  },
  submitBtn: {
    marginTop: 32,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: '#e63946',
    alignItems: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  successIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  successTitle: {
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 12,
    textAlign: 'center',
  },
  successSub: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 23,
  },
});

export default FeedbackScreen;
