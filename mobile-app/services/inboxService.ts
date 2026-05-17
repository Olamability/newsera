import { supabaseAuth } from './supabase';
import { InboxMessage } from '../types';

type NotificationRow = Omit<InboxMessage, 'type'> & { type?: InboxMessage['type'] | null };

export async function fetchInboxMessages(
  userId: string,
  page = 1,
  perPage = 20
): Promise<InboxMessage[]> {
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  const { data, error } = await supabaseAuth
    .from('notifications')
    .select('*')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return ((data ?? []) as NotificationRow[]).map((row) => ({
    ...row,
    type: row.type ?? 'system',
  }));
}

export async function markMessageRead(messageId: string, userId: string): Promise<void> {
  const { error } = await supabaseAuth
    .from('notifications')
    .update({ read: true })
    .eq('id', messageId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const { error } = await supabaseAuth
    .from('notifications')
    .delete()
    .eq('id', messageId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabaseAuth
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .or(`user_id.eq.${userId},user_id.is.null`)
    .eq('read', false);
  if (error) return 0;
  return count ?? 0;
}
