import { supabase } from './supabase';
import { InboxMessage } from '../types';

export async function fetchInboxMessages(
  userId: string,
  page = 1,
  perPage = 20
): Promise<InboxMessage[]> {
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  const { data, error } = await supabase
    .from('inbox_messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return (data ?? []) as InboxMessage[];
}

export async function markMessageRead(messageId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_messages')
    .update({ read: true })
    .eq('id', messageId);
  if (error) throw error;
}

export async function deleteMessage(messageId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_messages')
    .delete()
    .eq('id', messageId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('inbox_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);
  if (error) return 0;
  return count ?? 0;
}
