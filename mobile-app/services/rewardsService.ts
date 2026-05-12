import { supabase } from './supabase';
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
  const { data, error } = await supabase
    .from('user_rewards')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data as UserRewards | null;
}

export async function getRewardEvents(userId: string, limit = 20): Promise<RewardEvent[]> {
  const { data, error } = await supabase
    .from('reward_events')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
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

  await supabase
    .from('reward_events')
    .insert({ user_id: userId, event_type: eventType, points, description });

  const now = new Date();
  const today = localDateString(now);
  const existing = await getUserRewards(userId);

  if (!existing) {
    await supabase.from('user_rewards').insert({
      user_id: userId,
      total_points: points,
      articles_read: eventType === 'read' ? 1 : 0,
      current_streak: 1,
      longest_streak: 1,
      last_active_date: today,
    });
    return;
  }

  const lastDate = existing.last_active_date;
  const yesterday = localDateString(new Date(now.getTime() - MS_PER_DAY));
  let newStreak = existing.current_streak;
  if (lastDate !== today) {
    newStreak = lastDate === yesterday ? newStreak + 1 : 1;
  }

  await supabase
    .from('user_rewards')
    .update({
      total_points: existing.total_points + points,
      articles_read: existing.articles_read + (eventType === 'read' ? 1 : 0),
      current_streak: newStreak,
      longest_streak: Math.max(existing.longest_streak, newStreak),
      last_active_date: today,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
}
