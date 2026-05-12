import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { BlockedEntry } from '../types';

const BLOCKED_SOURCES_KEY = 'newsera_blocked_sources';

// ─── Local source blocking (works for guests too) ─────────────────────────────

export async function getBlockedSourceIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(BLOCKED_SOURCES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function blockSourceLocally(sourceId: string): Promise<void> {
  const existing = await getBlockedSourceIds();
  if (!existing.includes(sourceId)) {
    await AsyncStorage.setItem(
      BLOCKED_SOURCES_KEY,
      JSON.stringify([...existing, sourceId])
    );
  }
}

export async function unblockSourceLocally(sourceId: string): Promise<void> {
  const existing = await getBlockedSourceIds();
  await AsyncStorage.setItem(
    BLOCKED_SOURCES_KEY,
    JSON.stringify(existing.filter((id) => id !== sourceId))
  );
}

// ─── Supabase (authenticated users) ──────────────────────────────────────────

export async function fetchBlockedEntries(userId: string): Promise<BlockedEntry[]> {
  const { data, error } = await supabase
    .from('blocked_users')
    .select('*, blocked_source:sources(id, name, logo_url)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as BlockedEntry[];
}

export async function blockSourceForUser(userId: string, sourceId: string): Promise<void> {
  const { error } = await supabase.from('blocked_users').upsert(
    { user_id: userId, blocked_source_id: sourceId },
    { onConflict: 'user_id,blocked_source_id' }
  );
  if (error) throw error;
  await blockSourceLocally(sourceId);
}

export async function unblockEntry(
  entryId: string,
  userId: string,
  sourceId?: string | null
): Promise<void> {
  const { error } = await supabase
    .from('blocked_users')
    .delete()
    .eq('id', entryId)
    .eq('user_id', userId);
  if (error) throw error;
  if (sourceId) await unblockSourceLocally(sourceId);
}
