import { supabaseAuth } from './supabase';
import { UserRewards, RewardEvent } from '../types';

const POINTS: Record<RewardEvent['event_type'], number> = {
  read: 5,
  share: 10,
  bookmark: 3,
  streak: 20,
  milestone: 50,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Returns local date string YYYY-MM-DD (timezone-aware, uses device local time). */
function localDateString(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export async function getUserRewards(userId: string): Promise<UserRewards | null> {
  const { data, error } = await supabaseAuth
    .from('reward_events')
    .select('id, user_id, event_type, points, description')
    .eq('user_id', userId)
    .order('id', { ascending: false })
    .limit(1000);
  if (error) throw error;

  const events = (data ?? []) as RewardEvent[];
  if (events.length === 0) return null;

  const rewardDays = events
    .filter((event) => event.description?.startsWith('reward-date:'))
    .map((event) => event.description?.replace('reward-date:', '') ?? '')
    .filter(Boolean)
    .sort();
  const uniqueRewardDays = Array.from(new Set(rewardDays));

  let currentStreak = 0;
  let longestStreak = 0;
  let running = 0;
  let previousDay: string | null = null;
  for (const day of uniqueRewardDays) {
    if (!previousDay) {
      running = 1;
    } else {
      const prev = new Date(previousDay);
      const cur = new Date(day);
      const diff = Math.round((cur.getTime() - prev.getTime()) / MS_PER_DAY);
      running = diff === 1 ? running + 1 : 1;
    }
    previousDay = day;
    longestStreak = Math.max(longestStreak, running);
  }

  const today = localDateString(new Date());
  const latestDay = uniqueRewardDays[uniqueRewardDays.length - 1] ?? null;
  if (latestDay === today) {
    currentStreak = running;
  } else if (latestDay) {
    const latest = new Date(latestDay);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    currentStreak = latest.toDateString() === yesterday.toDateString() ? running : 0;
  }

  const totalPoints = events.reduce((sum, event) => sum + Number(event.points ?? 0), 0);
  const articlesRead = events.filter((event) => event.event_type === 'read').length;

  return {
    id: `derived-${userId}`,
    user_id: userId,
    total_points: totalPoints,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    last_active_date: latestDay,
    articles_read: articlesRead,
  };
}

export async function getRewardEvents(userId: string, limit = 20): Promise<RewardEvent[]> {
  const { data, error } = await supabaseAuth
    .from('reward_events')
    .select('id, event_type, points, description')
    .eq('user_id', userId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as RewardEvent[];
}

export async function recordRewardEvent(
  userId: string,
  eventType: RewardEvent['event_type'],
  description?: string
): Promise<void> {
  const points = POINTS[eventType] ?? 0;

  await supabaseAuth
    .from('reward_events')
    .insert({
      user_id: userId,
      event_type: eventType,
      points,
      description: description ?? `reward-date:${localDateString(new Date())}`,
    });
}
