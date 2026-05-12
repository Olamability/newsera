import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { getUserRewards, getRewardEvents } from '../services/rewardsService';
import { UserRewards, RewardEvent, RootStackParamList } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Rewards'>;

const MILESTONES = [
  { label: 'First Read', icon: '📖', requiredReads: 1 },
  { label: '10 Articles', icon: '📚', requiredReads: 10 },
  { label: '50 Articles', icon: '🏅', requiredReads: 50 },
  { label: '100 Articles', icon: '🏆', requiredReads: 100 },
  { label: '7-Day Streak', icon: '🔥', requiredStreak: 7 },
  { label: '30-Day Streak', icon: '⚡', requiredStreak: 30 },
];

const EVENT_ICONS: Record<string, string> = {
  read: '📖',
  share: '📤',
  bookmark: '🔖',
  streak: '🔥',
  milestone: '🏆',
};

interface MilestoneState {
  label: string;
  icon: string;
  earned: boolean;
}

function computeMilestones(rewards: UserRewards): MilestoneState[] {
  return MILESTONES.map((m) => {
    let earned = false;
    if (m.requiredReads !== undefined) {
      earned = rewards.articles_read >= m.requiredReads;
    } else if (m.requiredStreak !== undefined) {
      earned = rewards.longest_streak >= m.requiredStreak;
    }
    return { label: m.label, icon: m.icon, earned };
  });
}

const RewardsScreen: React.FC = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const c = theme.colors;

  const [rewards, setRewards] = useState<UserRewards | null>(null);
  const [events, setEvents] = useState<RewardEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(false);
    try {
      const [r, e] = await Promise.all([
        getUserRewards(user.id),
        getRewardEvents(user.id),
      ]);
      setRewards(r);
      setEvents(e);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  if (!user) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>🏆</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>Sign in to track rewards</Text>
        <Text style={[styles.emptySub, { color: c.textSecondary }]}>
          Earn points for reading, sharing and bookmarking articles. Track your streak and milestones.
        </Text>
        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={styles.signInText}>Sign In</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color="#e63946" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={styles.emptyIcon}>⚠️</Text>
        <Text style={[styles.emptyTitle, { color: c.text }]}>Failed to load rewards</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const milestones = rewards ? computeMilestones(rewards) : [];

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: c.background }]} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Points hero */}
        <View style={[styles.heroCard, { backgroundColor: c.primary }]}>
          <Text style={styles.heroPoints}>{rewards?.total_points ?? 0}</Text>
          <Text style={styles.heroLabel}>Total Points</Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={styles.statIcon}>🔥</Text>
            <Text style={[styles.statValue, { color: c.text }]}>{rewards?.current_streak ?? 0}</Text>
            <Text style={[styles.statLabel, { color: c.textSecondary }]}>Day streak</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={styles.statIcon}>⚡</Text>
            <Text style={[styles.statValue, { color: c.text }]}>{rewards?.longest_streak ?? 0}</Text>
            <Text style={[styles.statLabel, { color: c.textSecondary }]}>Best streak</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={styles.statIcon}>📖</Text>
            <Text style={[styles.statValue, { color: c.text }]}>{rewards?.articles_read ?? 0}</Text>
            <Text style={[styles.statLabel, { color: c.textSecondary }]}>Articles read</Text>
          </View>
        </View>

        {/* Milestones */}
        <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>MILESTONES</Text>
        <View style={styles.milestonesGrid}>
          {milestones.map((m) => (
            <View
              key={m.label}
              style={[
                styles.milestoneCard,
                { backgroundColor: c.surface, borderColor: c.border },
                !m.earned && styles.milestoneLocked,
              ]}
            >
              <Text style={[styles.milestoneIcon, !m.earned && styles.milestoneIconLocked]}>
                {m.icon}
              </Text>
              <Text
                style={[
                  styles.milestoneLabel,
                  { color: m.earned ? c.text : c.textSecondary },
                ]}
              >
                {m.label}
              </Text>
              {m.earned && (
                <Text style={styles.milestoneCheck}>✓</Text>
              )}
            </View>
          ))}
        </View>

        {/* Recent activity */}
        {events.length > 0 && (
          <>
            <Text style={[styles.sectionHeader, { color: c.textSecondary }]}>
              RECENT ACTIVITY
            </Text>
            {events.map((ev) => (
              <View
                key={ev.id}
                style={[styles.eventRow, { backgroundColor: c.surface, borderColor: c.border }]}
              >
                <Text style={styles.eventIcon}>{EVENT_ICONS[ev.event_type] ?? '⭐'}</Text>
                <View style={styles.eventContent}>
                  <Text style={[styles.eventDesc, { color: c.text }]}>
                    {ev.description ?? ev.event_type}
                  </Text>
                  <Text style={[styles.eventDate, { color: c.textSecondary }]}>
                    {new Date(ev.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={[styles.eventPoints, { color: c.primary }]}>
                  +{ev.points}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  signInBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#e63946',
  },
  signInText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#e63946',
  },
  retryText: { color: '#fff', fontWeight: '700' },
  scroll: { padding: 20, paddingBottom: 40 },
  heroCard: {
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    marginBottom: 20,
  },
  heroPoints: {
    fontSize: 56,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 64,
  },
  heroLabel: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
  },
  statIcon: { fontSize: 22, marginBottom: 4 },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 2,
  },
  statLabel: { fontSize: 12 },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
    marginTop: 4,
  },
  milestonesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 24,
  },
  milestoneCard: {
    width: '30%',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
  },
  milestoneLocked: {
    opacity: 0.45,
  },
  milestoneIcon: { fontSize: 28, marginBottom: 6 },
  milestoneIconLocked: { opacity: 0.4 },
  milestoneLabel: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  milestoneCheck: {
    fontSize: 13,
    color: '#4caf50',
    fontWeight: '800',
    marginTop: 4,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  eventIcon: { fontSize: 22, marginRight: 12 },
  eventContent: { flex: 1 },
  eventDesc: { fontSize: 14, fontWeight: '500' },
  eventDate: { fontSize: 12, marginTop: 2 },
  eventPoints: {
    fontSize: 15,
    fontWeight: '700',
  },
});

export default RewardsScreen;
