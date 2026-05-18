// Centralised RPC client for the /infrastructure dashboard.
//
// All calls go through Supabase RPC so the existing RLS + admin gates
// in migrations 046/047 remain authoritative. No direct table writes
// are performed from the client; mutation surfaces are admin-gated and
// audited server-side.

import { supabase } from '../lib/supabaseClient'

function unwrap(res) {
  if (res.error) throw res.error
  return res.data
}

// ---------- Cron health (migration 046) ----------
export async function fetchCronStatus() {
  return unwrap(await supabase.rpc('get_pg_cron_status'))
}
export async function fetchCronJobHealth() {
  return unwrap(await supabase.rpc('get_cron_job_health'))
}
export async function fetchMissingCronJobs() {
  return unwrap(await supabase.rpc('get_missing_expected_cron_jobs'))
}

// ---------- Queue health (migration 047) ----------
export async function fetchQueueHealth() {
  return unwrap(await supabase.rpc('get_queue_health'))
}
export async function fetchDeadLetterSummary() {
  return unwrap(await supabase.rpc('get_dead_letter_summary'))
}
export async function fetchDeadLetterRows({ queue, limit = 50 } = {}) {
  let q = supabase
    .from('job_dead_letter')
    .select('id, queue_name, job_type, dedup_key, payload, attempts, last_error, failed_at, replayed_at, replayed_job_id')
    .order('failed_at', { ascending: false })
    .limit(limit)
  if (queue) q = q.eq('queue_name', queue)
  return unwrap(await q)
}
export async function fetchRecentJobs({ queue, status, limit = 50 } = {}) {
  let q = supabase
    .from('job_queue')
    .select('id, queue_name, job_type, status, attempts, max_attempts, last_error, payload, leased_by, leased_until, created_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (queue) q = q.eq('queue_name', queue)
  if (status) q = q.eq('status', status)
  return unwrap(await q)
}

export async function replayDeadLetter(id, reason) {
  return unwrap(await supabase.rpc('admin_replay_dead_letter', { p_dlq_id: id, p_reason: reason ?? null }))
}
export async function replayDeadLetterBulk(queue, limit, reason) {
  return unwrap(await supabase.rpc('admin_replay_dead_letter_bulk', {
    p_queue_name: queue ?? null,
    p_limit: limit ?? 50,
    p_reason: reason ?? null,
  }))
}
export async function retryFailedJobs(queue, limit, reason) {
  return unwrap(await supabase.rpc('admin_retry_failed_jobs', {
    p_queue_name: queue ?? null,
    p_limit: limit ?? 100,
    p_reason: reason ?? null,
  }))
}
export async function clearCompletedJobs(queue, olderThanHours, reason) {
  return unwrap(await supabase.rpc('admin_clear_completed_jobs', {
    p_queue_name: queue ?? null,
    p_older_than_hours: olderThanHours ?? 24,
    p_reason: reason ?? null,
  }))
}

// ---------- RSS workers + feeds ----------
export async function fetchRssWorkerHealth() {
  return unwrap(await supabase.rpc('get_rss_worker_health'))
}
export async function fetchRssFeedHealth(limit = 200) {
  return unwrap(await supabase.rpc('get_rss_feed_health', { p_limit: limit }))
}
export async function forceReleaseFeedLease(feedId, reason) {
  return unwrap(await supabase.rpc('admin_force_release_feed_lease', {
    p_feed_id: feedId, p_reason: reason ?? null,
  }))
}
export async function setFeedActive(feedId, active, reason) {
  return unwrap(await supabase.rpc('admin_set_feed_active', {
    p_feed_id: feedId, p_active: active, p_reason: reason ?? null,
  }))
}
export async function retryFeed(feedId, reason) {
  return unwrap(await supabase.rpc('admin_retry_feed', {
    p_feed_id: feedId, p_reason: reason ?? null,
  }))
}

// ---------- Feature flags ----------
export async function fetchFeatureFlags() {
  return unwrap(await supabase
    .from('feature_flags')
    .select('name, enabled, rollout_percent, description, updated_at')
    .order('name'))
}
export async function fetchFeatureFlagImpact(name, rolloutPercent) {
  return unwrap(await supabase.rpc('get_feature_flag_impact', {
    p_name: name,
    p_rollout_percent: rolloutPercent ?? null,
  }))
}
export async function updateFeatureFlag(name, enabled, rolloutPercent, reason) {
  return unwrap(await supabase.rpc('admin_update_feature_flag', {
    p_name: name,
    p_enabled: enabled,
    p_rollout_percent: rolloutPercent ?? null,
    p_reason: reason ?? null,
  }))
}
export async function emergencyDisableFeatureFlag(name, reason) {
  return unwrap(await supabase.rpc('admin_emergency_disable_feature_flag', {
    p_name: name, p_reason: reason ?? 'emergency_disable',
  }))
}

// ---------- Notifications ----------
export async function fetchNotificationHealth() {
  return unwrap(await supabase.rpc('get_notification_pipeline_health'))
}
export async function fetchRecentFailedDeliveries(limit = 50) {
  return unwrap(await supabase
    .from('notification_deliveries')
    .select('id, event_id, user_id, channel, status, attempts, provider, error_message, scheduled_for, updated_at')
    .eq('status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(limit))
}
export async function sendTestNotification(userId, title, body, reason) {
  return unwrap(await supabase.rpc('admin_send_test_notification', {
    p_user_id: userId, p_title: title, p_body: body, p_reason: reason ?? 'admin_test',
  }))
}

// ---------- Personalization ----------
export async function fetchPersonalizationHealth() {
  return unwrap(await supabase.rpc('get_personalization_pipeline_health'))
}
export async function fetchUserAffinity(userId) {
  const [cat, src] = await Promise.all([
    supabase.from('user_category_affinity')
      .select('category_id, score, raw_signal_count, last_interaction_at, recomputed_at')
      .eq('user_id', userId)
      .order('score', { ascending: false })
      .limit(50),
    supabase.from('user_source_affinity')
      .select('source_id, score, raw_signal_count, last_interaction_at, recomputed_at')
      .eq('user_id', userId)
      .order('score', { ascending: false })
      .limit(50),
  ])
  if (cat.error) throw cat.error
  if (src.error) throw src.error
  return { categories: cat.data ?? [], sources: src.data ?? [] }
}

// ---------- Ranking ----------
export async function fetchRankingHealth() {
  return unwrap(await supabase.rpc('get_ranking_pipeline_health'))
}

// ---------- Activation matrix ----------
export async function fetchActivationReadiness() {
  return unwrap(await supabase.rpc('get_activation_readiness'))
}
