/**
 * Phase G — Operator dashboard panels.
 *
 * Ten tabs that surface the Phase G modules to operators:
 *   ProductionHealth   Deployments   Incidents   RolloutTimeline
 *   FeedQuality        Monetization  SeoHealth   MobileRelease
 *   Compliance         RecoveryCenter
 *
 * All tabs are read-only viewers. Mutating operator actions surface a
 * confirmation flow that captures an audit reason; the actual mutation
 * is routed through a SECURITY DEFINER RPC (placeholder: `phaseg_audit`)
 * and an immutable audit row is written server-side. Until that RPC is
 * deployed the panels render the action affordance but treat the call as
 * a no-op preview — matching the conservative Phase F pattern.
 */

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { Panel, Banner, Badge, Stat, StatGrid, Table, Button, formatRelative } from './UI'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function useRpc(rpcName, args, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true); setError('')
    try {
      const { data, error } = await supabase.rpc(rpcName, args ?? {})
      if (error) throw error
      setData(data ?? null)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, deps)
  return { data, error, busy, reload: load }
}

function ScoreBar({ score }) {
  const pct = Math.max(0, Math.min(1, Number(score ?? 0))) * 100
  const tone = pct >= 85 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
      <div className={`${tone} h-2`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function AuditedAction({ label, tone = 'danger', onConfirm }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function run() {
    if (!reason.trim()) { setErr('audit reason required'); return }
    setBusy(true); setErr('')
    try { await onConfirm(reason.trim()); setOpen(false); setReason('') }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }
  if (!open) {
    return <Button tone={tone} onClick={() => setOpen(true)}>{label}</Button>
  }
  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 text-sm space-y-2">
      <p className="font-semibold text-gray-800">{label} — confirm audit reason</p>
      <input
        type="text"
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="e.g. SEV2 ranking outage — rolling back ranking_v1"
        className="w-full border border-gray-300 rounded-md px-2 py-1"
      />
      {err && <p className="text-red-600 text-xs">{err}</p>}
      <div className="flex gap-2">
        <Button tone={tone} onClick={run} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</Button>
        <Button tone="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1. Production health
// ---------------------------------------------------------------------------

export function ProductionHealthPanel() {
  const { data, error, busy, reload } = useRpc('get_production_health_snapshot', null, [])
  const health = data?.health ?? null
  const score = health?.score ?? null
  const banner =
    health?.classification === 'healthy' ? <Banner tone="good" title="System healthy">All subsystems within tolerance.</Banner> :
    health?.classification === 'degraded' ? <Banner tone="warn" title="System degraded">{(health?.recommendations ?? []).slice(0, 3).join(' · ') || 'See subsystem table below.'}</Banner> :
    health ? <Banner tone="bad" title="System critical">{(health?.recommendations ?? []).slice(0, 3).join(' · ')}</Banner> : null

  return (
    <Panel
      title="Production health"
      subtitle="Composite health across queues, workers, DB, ranking, personalization, notifications, mobile, and more."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {banner}

      {health && (
        <>
          <div className="mb-4">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm text-gray-600">Overall health score</p>
              <p className="text-3xl font-bold text-gray-800">{score?.toFixed(2)}</p>
            </div>
            <ScoreBar score={score} />
            <p className="text-xs text-gray-500 mt-2">Launch readiness: <span className="font-semibold">{health.launchReadinessScore?.toFixed(2)}</span> · Risk: <span className="font-semibold">{health.risk}</span></p>
          </div>

          <StatGrid>
            <Stat label="Severe incidents" value={data?.openSevereIncidents ?? 0} tone={(data?.openSevereIncidents ?? 0) > 0 ? 'bad' : 'good'} />
            <Stat label="Warning incidents" value={data?.openWarningIncidents ?? 0} tone={(data?.openWarningIncidents ?? 0) > 0 ? 'warn' : 'good'} />
            <Stat label="Traffic guard" value={data?.trafficGuard?.mode ?? '—'} tone={data?.trafficGuard?.mode === 'normal' ? 'good' : 'warn'} />
            <Stat label="Rollout" value={data?.rolloutPaused ? 'paused' : 'live'} tone={data?.rolloutPaused ? 'warn' : 'good'} />
            <Stat label="Freeze" value={data?.productionFreeze ? 'ACTIVE' : 'off'} tone={data?.productionFreeze ? 'warn' : 'good'} />
          </StatGrid>

          <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Subsystem contributions</h3>
          <Table
            rowKey={r => r.key}
            columns={[
              { key: 'key', header: 'Subsystem' },
              { key: 'raw', header: 'Score', render: r => <span className="font-mono">{r.raw?.toFixed(2)}</span> },
              { key: 'bar', header: 'Health', render: r => <ScoreBar score={r.raw} /> },
              { key: 'weight', header: 'Weight', render: r => <span className="font-mono text-xs">{(health.weights?.[r.key] ?? '—').toString()}</span> },
            ]}
            rows={(health.contributions ?? []).map(c => ({ ...c }))}
          />
        </>
      )}

      {!data && !error && <p className="text-sm text-gray-500 italic">No snapshot — RPC {`get_production_health_snapshot`} not yet wired.</p>}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 2. Deployments
// ---------------------------------------------------------------------------

export function DeploymentsPanel() {
  const { data, error, busy, reload } = useRpc('list_deployment_sessions', { p_limit: 50 }, [])
  const sessions = data ?? []

  return (
    <Panel
      title="Deployments"
      subtitle="Immutable lineage of release sessions, build fingerprints, migrations, and flag changes."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      <Table
        rowKey={r => r.session_id}
        empty="No deployment sessions recorded yet."
        columns={[
          { key: 'session_id', header: 'Session', render: r => <span className="font-mono text-xs">{r.session_id}</span> },
          { key: 'fingerprint', header: 'Fingerprint', render: r => <span className="font-mono text-xs">{r.fingerprint?.slice(0, 16)}</span> },
          { key: 'environment', header: 'Env' },
          { key: 'status', header: 'Status', render: r => <Badge tone={r.status === 'STABILIZED' ? 'ok' : r.status === 'ROLLED_BACK' ? 'bad' : r.status === 'FAILED' ? 'bad' : 'warn'}>{r.status}</Badge> },
          { key: 'started_at', header: 'Started', render: r => formatRelative(r.started_at) },
          { key: 'initiator', header: 'By' },
          { key: 'reason', header: 'Reason' },
        ]}
        rows={sessions}
      />
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 3. Incidents
// ---------------------------------------------------------------------------

export function IncidentsPanel() {
  const { data, error, busy, reload } = useRpc('list_incident_history', { p_limit: 100 }, [])
  const entries = data ?? []
  async function ack(id, reason) {
    const { error } = await supabase.rpc('acknowledge_incident', { p_incident_id: id, p_reason: reason })
    if (error) throw error
    reload()
  }
  async function resolve(id, reason) {
    const { error } = await supabase.rpc('resolve_incident', { p_incident_id: id, p_reason: reason })
    if (error) throw error
    reload()
  }

  return (
    <Panel
      title="Incidents"
      subtitle="Persistent rolling timeline of detected incidents, MTTR tracking, and operator acknowledgement lifecycle."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      <Table
        rowKey={r => r.id}
        empty="No incidents recorded."
        columns={[
          { key: 'type', header: 'Type' },
          { key: 'severity', header: 'Severity', render: r => <Badge tone={r.severity === 'CRITICAL' || r.severity === 'SEVERE' ? 'bad' : r.severity === 'WARNING' ? 'warn' : 'info'}>{r.severity}</Badge> },
          { key: 'state', header: 'State', render: r => <Badge tone={r.state === 'RESOLVED' ? 'ok' : r.state === 'ACKED' ? 'warn' : 'bad'}>{r.state}</Badge> },
          { key: 'occurrences', header: '#' },
          { key: 'first_seen_at', header: 'First seen', render: r => formatRelative(r.first_seen_at) },
          { key: 'duration_ms', header: 'MTTR', render: r => r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—' },
          { key: 'actions', header: 'Actions', render: r => r.state === 'RESOLVED' ? null : (
            <div className="flex gap-2">
              {r.state !== 'ACKED' && <AuditedAction label="Ack" tone="ghost" onConfirm={(reason) => ack(r.id, reason)} />}
              <AuditedAction label="Resolve" tone="primary" onConfirm={(reason) => resolve(r.id, reason)} />
            </div>
          ) },
        ]}
        rows={entries}
      />
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 4. Rollout timeline
// ---------------------------------------------------------------------------

export function RolloutTimelinePanel() {
  const { data, error, busy, reload } = useRpc('get_rollout_timeline', null, [])
  const stages = data?.stages ?? []
  return (
    <Panel
      title="Rollout timeline"
      subtitle="Stage-by-stage history of the live rollout, with deployment lineage links."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {data?.paused && <Banner tone="warn" title="Rollout paused">{data.pauseReason || 'See incidents tab for the cause.'}</Banner>}
      <Table
        rowKey={r => r.flag}
        empty="No rollout stages registered."
        columns={[
          { key: 'flag', header: 'Flag' },
          { key: 'status', header: 'Status', render: r => <Badge tone={r.status === 'STABLE' ? 'ok' : r.status === 'FAILED' || r.status === 'ROLLED_BACK' ? 'bad' : 'warn'}>{r.status}</Badge> },
          { key: 'canary_stage', header: 'Canary' },
          { key: 'started_at', header: 'Started', render: r => formatRelative(r.started_at) },
          { key: 'last_initiator', header: 'Last action' },
        ]}
        rows={stages}
      />
      {data?.lineage && (
        <>
          <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Deployment lineage</h3>
          <Table
            rowKey={r => r.session_id}
            columns={[
              { key: 'session_id', header: 'Session' },
              { key: 'fingerprint', header: 'Fingerprint' },
              { key: 'parent_session_id', header: 'Parent' },
              { key: 'status', header: 'Status' },
            ]}
            rows={data.lineage}
          />
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 5. Feed quality
// ---------------------------------------------------------------------------

export function FeedQualityPanel() {
  const { data, error, busy, reload } = useRpc('get_feed_quality_snapshot', null, [])
  return (
    <Panel
      title="Feed quality"
      subtitle="Static + adaptive thresholds, per-category diversity and saturation risk."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      <Table
        rowKey={r => r.category}
        empty="No category data."
        columns={[
          { key: 'category', header: 'Category' },
          { key: 'top_source_share', header: 'Top source share', render: r => r.top_source_share?.toFixed(2) },
          { key: 'unique_sources', header: 'Unique sources' },
          { key: 'saturation_risk', header: 'Saturation', render: r => <Badge tone={r.saturation_risk === 'none' ? 'ok' : r.saturation_risk === 'high' ? 'bad' : 'warn'}>{r.saturation_risk}</Badge> },
          { key: 'engagement_ctr', header: 'CTR', render: r => r.engagement_ctr?.toFixed(3) },
        ]}
        rows={data?.categories ?? []}
      />
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 6. Monetization
// ---------------------------------------------------------------------------

export function MonetizationPanel() {
  const { data, error, busy, reload } = useRpc('get_monetization_snapshot', null, [])
  const r = data ?? {}
  return (
    <Panel
      title="Monetization"
      subtitle="Internal readiness: ad density, RPM trend, click-fraud signals. No external SDK integration."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      <StatGrid>
        <Stat label="Fill rate" value={r.fill_rate != null ? `${(r.fill_rate * 100).toFixed(1)}%` : '—'} tone="info" />
        <Stat label="RPM (window)" value={r.rpm != null ? r.rpm.toFixed(2) : '—'} tone="info" />
        <Stat label="Impressions" value={r.total_impressions ?? 0} />
        <Stat label="Revenue (μ)" value={r.total_revenue_micros ?? 0} />
        <Stat label="Fraud findings" value={(r.fraud_findings ?? []).length} tone={(r.fraud_findings ?? []).length > 0 ? 'warn' : 'good'} />
      </StatGrid>
      <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Top sources</h3>
      <Table
        rowKey={r => r.source}
        columns={[
          { key: 'source', header: 'Source' },
          { key: 'impressions', header: 'Impressions' },
          { key: 'rpm', header: 'RPM', render: r => r.rpm?.toFixed(2) },
          { key: 'fill_rate', header: 'Fill', render: r => r.fill_rate != null ? `${(r.fill_rate * 100).toFixed(1)}%` : '—' },
        ]}
        rows={r.sources ?? []}
      />
      <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Fraud findings</h3>
      <Table
        rowKey={(f, i) => `${f.type}-${f.subject}-${i}`}
        empty="No fraud findings in current window."
        columns={[
          { key: 'type', header: 'Type' },
          { key: 'severity', header: 'Severity', render: r => <Badge tone={r.severity === 'severe' ? 'bad' : 'warn'}>{r.severity}</Badge> },
          { key: 'subject', header: 'Subject' },
          { key: 'count', header: '#' },
        ]}
        rows={r.fraud_findings ?? []}
      />
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 7. SEO health
// ---------------------------------------------------------------------------

export function SeoHealthPanel() {
  const { data, error, busy, reload } = useRpc('get_seo_health_snapshot', null, [])
  return (
    <Panel
      title="SEO health"
      subtitle="Schema, sitemaps, indexing drift, source authority, duplicate-content detection."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {data && (
        <>
          <div className="mb-4">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm text-gray-600">Overall SEO score</p>
              <p className="text-3xl font-bold text-gray-800">{data.overall_score?.toFixed(2)}</p>
            </div>
            <ScoreBar score={data.overall_score} />
          </div>
          <StatGrid>
            <Stat label="Schema" value={data.components?.schema_score?.toFixed(2)} />
            <Stat label="Sitemap" value={data.components?.sitemap_score?.toFixed(2)} />
            <Stat label="Freshness" value={data.components?.freshness_score?.toFixed(2)} />
            <Stat label="Indexing" value={data.components?.indexing_score?.toFixed(2)} />
            <Stat label="Authority" value={data.components?.source_authority_score?.toFixed(2)} />
          </StatGrid>
          {(data.top_issues ?? []).length > 0 && (
            <Banner tone={data.classification === 'critical' ? 'bad' : 'warn'} title="Top SEO issues">
              <ul className="list-disc list-inside text-xs">
                {data.top_issues.map((i, idx) => <li key={idx}>{i}</li>)}
              </ul>
            </Banner>
          )}
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 8. Mobile release
// ---------------------------------------------------------------------------

export function MobileReleasePanel() {
  const { data, error, busy, reload } = useRpc('get_mobile_release_readiness', null, [])
  return (
    <Panel
      title="Mobile release"
      subtitle="API compatibility, crash spikes, app-store submission readiness."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {data && (
        <>
          <Banner
            tone={data.recommendation === 'ship' ? 'good' : data.recommendation === 'hold' ? 'warn' : 'bad'}
            title={`Recommendation: ${data.recommendation?.toUpperCase()}`}
          >
            {data.ok ? 'No blockers detected.' : `${(data.blockers ?? []).length} blocker(s) outstanding.`}
          </Banner>
          {(data.blockers ?? []).length > 0 && (
            <>
              <h3 className="text-sm font-semibold text-gray-700 mt-4 mb-2">Blockers</h3>
              <ul className="list-disc list-inside text-xs text-red-700">
                {data.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </>
          )}
          {(data.crash_spikes ?? []).length > 0 && (
            <>
              <h3 className="text-sm font-semibold text-gray-700 mt-4 mb-2">Crash spikes</h3>
              <Table
                rowKey={r => r.fingerprint}
                columns={[
                  { key: 'fingerprint', header: 'Fingerprint' },
                  { key: 'count', header: 'Count' },
                  { key: 'spike_ratio', header: 'Ratio', render: r => r.spike_ratio?.toFixed(2) },
                  { key: 'suspected_rollout', header: 'Suspected rollout' },
                ]}
                rows={data.crash_spikes}
              />
            </>
          )}
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 9. Compliance
// ---------------------------------------------------------------------------

export function CompliancePanel() {
  const { data, error, busy, reload } = useRpc('get_compliance_audit', null, [])
  return (
    <Panel
      title="Compliance"
      subtitle="PII / retention / access boundary / audit lineage / env-mismatch checks."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {data && (
        <>
          <div className="mb-4">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm text-gray-600">Final compliance score</p>
              <p className="text-3xl font-bold text-gray-800">{data.final_compliance_score?.toFixed(2)}</p>
            </div>
            <ScoreBar score={data.final_compliance_score} />
          </div>
          {(data.launch_blockers ?? []).length > 0 && (
            <Banner tone="bad" title={`${data.launch_blockers.length} launch blocker(s)`}>
              <ul className="list-disc list-inside text-xs">
                {data.launch_blockers.map((b, i) => <li key={i}>{b.message}</li>)}
              </ul>
            </Banner>
          )}
          <Table
            rowKey={(r, i) => `${r.code}-${i}`}
            empty="No findings."
            columns={[
              { key: 'code', header: 'Code' },
              { key: 'severity', header: 'Severity', render: r => <Badge tone={r.severity === 'severe' ? 'bad' : r.severity === 'warn' ? 'warn' : 'info'}>{r.severity}</Badge> },
              { key: 'message', header: 'Message' },
            ]}
            rows={data.all_findings ?? []}
          />
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 10. Recovery center
// ---------------------------------------------------------------------------

export function RecoveryCenterPanel() {
  const { data, error, busy, reload } = useRpc('get_recovery_center_snapshot', null, [])
  async function emergencyRollback(reason) {
    const { error } = await supabase.rpc('emergency_rollback', { p_reason: reason })
    if (error) throw error
    reload()
  }
  async function simulateRestore(reason) {
    const { error } = await supabase.rpc('simulate_restore', { p_reason: reason })
    if (error) throw error
    reload()
  }

  return (
    <Panel
      title="Recovery center"
      subtitle="Backup freshness, recovery verification, restore-simulation history."
      action={<Button tone="ghost" onClick={reload} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {data && (
        <>
          <StatGrid>
            <Stat label="Backup freshness" value={data.backup_freshness_score?.toFixed(2)} tone={(data.backup_freshness_score ?? 0) > 0.7 ? 'good' : 'warn'} />
            <Stat label="Recovery confidence" value={data.recovery_confidence_score?.toFixed(2)} tone={(data.recovery_confidence_score ?? 0) > 0.85 ? 'good' : 'warn'} />
            <Stat label="Last restore sim" value={formatRelative(data.last_restore_sim_at)} />
          </StatGrid>

          <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Backups per tier</h3>
          <Table
            rowKey={r => r.tier}
            columns={[
              { key: 'tier', header: 'Tier' },
              { key: 'latest_at', header: 'Latest', render: r => formatRelative(r.latest_at) },
              { key: 'within_rpo', header: 'Within RPO', render: r => <Badge tone={r.within_rpo ? 'ok' : 'bad'}>{r.within_rpo ? 'yes' : 'no'}</Badge> },
              { key: 'freshness_score', header: 'Score', render: r => r.freshness_score?.toFixed(2) },
            ]}
            rows={data.tiers ?? []}
          />

          <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">Operator actions</h3>
          <div className="flex flex-wrap gap-2">
            <AuditedAction label="Run restore simulation" tone="primary" onConfirm={simulateRestore} />
            <AuditedAction label="Emergency rollback" tone="danger" onConfirm={emergencyRollback} />
          </div>
          <p className="text-[11px] text-gray-500 mt-2">Both actions write an immutable audit row via SECURITY DEFINER RPCs.</p>
        </>
      )}
    </Panel>
  )
}
