import { supabase } from '../../lib/supabaseClient'

/**
 * Thin wrapper around the moderation service + Supabase reads.
 *
 * Read paths go directly to Supabase (RLS enforces access).
 * Mutations go through the moderation service so the audit log is written
 * in the same transaction as the business change.
 *
 * When VITE_MODERATION_API_URL is unset (e.g. local dev without the
 * service running), the action calls degrade gracefully and surface an
 * informative error instead of silently doing nothing.
 */
const API_BASE = import.meta.env.VITE_MODERATION_API_URL || ''

function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `r-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function apiFetch(path, { method = 'GET', body, actorId } = {}) {
  if (!API_BASE) {
    throw new Error(
      'Moderation API not configured. Set VITE_MODERATION_API_URL to enable admin actions.',
    )
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-request-id': newRequestId(),
      ...(actorId ? { 'x-actor-id': actorId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed: ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

// --- Reads (Supabase direct) ----------------------------------------------

export async function fetchReportQueue({ limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('report_queue')
    .select('*')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function fetchCase(caseId) {
  const c = await supabase.from('moderation_cases').select('*').eq('id', caseId).maybeSingle()
  if (c.error) throw c.error
  if (!c.data) return { case: null, reports: [], actions: [], signals: [] }

  const [reports, actions, signals] = await Promise.all([
    supabase.from('reports').select('*').eq('case_id', caseId).order('created_at'),
    supabase.from('moderation_actions').select('*').eq('case_id', caseId).order('occurred_at'),
    // Only signals for the case's subject — not unrelated rows.
    supabase.from('fraud_signals').select('*')
      .eq('subject_type', c.data.target_type)
      .eq('subject_id',   c.data.target_id)
      .order('occurred_at', { ascending: false })
      .limit(50),
  ])
  return {
    case: c.data,
    reports: reports.data ?? [],
    actions: actions.data ?? [],
    signals: signals.data ?? [],
  }
}

export async function fetchVerifications({ status } = {}) {
  let q = supabase.from('verifications').select('*').order('requested_at', { ascending: false }).limit(200)
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function fetchFraudSignals({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('fraud_signals')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function fetchRiskScores({ band, limit = 200 } = {}) {
  let q = supabase.from('risk_scores').select('*').order('score', { ascending: false }).limit(limit)
  if (band) q = q.eq('band', band)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function fetchAuditLog({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('admin_activity_log')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function fetchMetricsDaily({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('moderation_metrics_daily')
    .select('*')
    .gte('day', since)
    .order('day', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function fetchSuspensions({ activeOnly = false } = {}) {
  let q = supabase.from('user_suspensions').select('*').order('starts_at', { ascending: false }).limit(200)
  if (activeOnly) q = q.is('lifted_at', null)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

// --- Writes (moderation service) ------------------------------------------

export function applyAction({ actorId, actionId, target, payload }) {
  return apiFetch(`/v1/actions/${encodeURIComponent(actionId)}`, {
    method: 'POST',
    body: { target, payload },
    actorId,
  })
}

export function verifyAuditChain() {
  return apiFetch('/v1/audit/verify')
}
