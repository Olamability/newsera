import { supabaseAuth } from './supabase';

export type FeedbackCategory = 'bug' | 'feature' | 'content' | 'other';

export interface FeedbackPayload {
  category: FeedbackCategory;
  message: string;
  email?: string;
  userId?: string;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const { error } = await supabaseAuth.from('feedback').insert({
    category: payload.category,
    message: payload.message.trim(),
    email: payload.email?.trim() || null,
    user_id: payload.userId ?? null,
  });
  if (error) throw error;
}
