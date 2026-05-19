import { useEffect, useState } from 'react'
import { fetchActivationReadiness } from '../services/infrastructure'
import { Panel, Banner, Badge, Table, Button } from '../components/infrastructure/UI'
import CronHealthPanel from '../components/infrastructure/CronHealthPanel'
import QueueOperationsPanel from '../components/infrastructure/QueueOperationsPanel'
import RssWorkerPanel from '../components/infrastructure/RssWorkerPanel'
import FeatureFlagsPanel from '../components/infrastructure/FeatureFlagsPanel'
import NotificationHealthPanel from '../components/infrastructure/NotificationHealthPanel'
import PersonalizationHealthPanel from '../components/infrastructure/PersonalizationHealthPanel'
import RankingHealthPanel from '../components/infrastructure/RankingHealthPanel'
import {
  ProductionHealthPanel,
  DeploymentsPanel,
  IncidentsPanel,
  RolloutTimelinePanel,
  FeedQualityPanel,
  MonetizationPanel,
  SeoHealthPanel,
  MobileReleasePanel,
  CompliancePanel,
  RecoveryCenterPanel,
} from '../components/infrastructure/PhaseGPanels'

const TABS = [
  { id: 'overview',       label: 'Overview' },
  { id: 'cron',           label: 'Cron health' },
  { id: 'queues',         label: 'Queues' },
  { id: 'rss',            label: 'RSS workers' },
  { id: 'flags',          label: 'Feature flags' },
  { id: 'notifications',  label: 'Notifications' },
  { id: 'personalization', label: 'Personalization' },
  { id: 'ranking',        label: 'Ranking' },
  // Phase G tabs:
  { id: 'production_health', label: 'Production Health' },
  { id: 'deployments',       label: 'Deployments' },
  { id: 'incidents',         label: 'Incidents' },
  { id: 'rollout_timeline',  label: 'Rollout Timeline' },
  { id: 'feed_quality',      label: 'Feed Quality' },
  { id: 'monetization',      label: 'Monetization' },
  { id: 'seo_health',        label: 'SEO Health' },
  { id: 'mobile_release',    label: 'Mobile Release' },
  { id: 'compliance',        label: 'Compliance' },
  { id: 'recovery_center',   label: 'Recovery Center' },
]

function OverviewPanel() {
  const [matrix, setMatrix] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true); setError('')
    try {
      setMatrix(await fetchActivationReadiness() ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  const blocked = matrix.filter(m => !m.ready)
  const ready = matrix.filter(m => m.ready)

  return (
    <>
      <Panel
        title="Activation readiness matrix"
        subtitle="Composite check across cron, workers, devices, ranking, personalization, retention."
        action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
      >
        {error && <Banner tone="bad" title="Error">{error}</Banner>}
        {blocked.length > 0 && (
          <Banner tone="warn" title={`${blocked.length} subsystem(s) blocked from activation`}>
            {blocked.map(b => b.subsystem).join(', ')} — see <em>blocked_by</em> column below.
          </Banner>
        )}
        {blocked.length === 0 && matrix.length > 0 && (
          <Banner tone="good" title="All subsystems report ready">
            Every subsystem passed dependency checks. Proceed with staged rollout (see Feature Flags tab).
          </Banner>
        )}

        <Table
          rowKey={r => r.subsystem}
          columns={[
            { key: 'subsystem', header: 'Subsystem', render: r => <span className="font-semibold">{r.subsystem}</span> },
            { key: 'ready', header: 'Ready', render: r =>
              r.ready ? <Badge tone="ok">ready</Badge> : <Badge tone="bad">blocked</Badge>
            },
            { key: 'blocked_by', header: 'Blocked by', render: r =>
              r.blocked_by
                ? <span className="font-mono text-xs text-red-700">{r.blocked_by}</span>
                : <span className="text-gray-400">—</span>
            },
            { key: 'rollout_safe', header: 'Rollout safe', render: r =>
              r.rollout_safe ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">staged only</Badge>
            },
            { key: 'detail', header: 'Detail', render: r =>
              <code className="text-[11px] text-gray-600 whitespace-pre-wrap break-all">
                {JSON.stringify(r.detail ?? {})}
              </code>
            },
          ]}
          rows={matrix}
          empty="No readiness data — RPC returned empty."
        />
      </Panel>

      <Panel title="What this dashboard does">
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
          <li><strong>Cron health</strong> — proves pg_cron schedules exist, run, and don't fail silently.</li>
          <li><strong>Queues</strong> — visibility into job_queue + job_dead_letter, plus safe replay/retry/clear actions (audited).</li>
          <li><strong>RSS workers</strong> — heartbeat health, feed reliability, lease ownership; pause/resume/force-release controls.</li>
          <li><strong>Feature flags</strong> — staged rollout with preview & emergency disable. Replaces blind toggling.</li>
          <li><strong>Notifications / Personalization / Ranking</strong> — pre-activation validation surfaces for each pipeline.</li>
        </ul>
        <p className="text-xs text-gray-500 mt-3">
          All mutations route through SECURITY DEFINER RPCs that re-check the admin role and write to <code>admin_audit_log</code>. No client-side writes to orchestration tables.
        </p>
      </Panel>
    </>
  )
}

export default function Infrastructure() {
  const [tab, setTab] = useState('overview')

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Infrastructure operations</h1>
          <p className="text-sm text-gray-500">Activation readiness, observability, and admin orchestration.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'overview'       && <OverviewPanel />}
      {tab === 'cron'           && <CronHealthPanel />}
      {tab === 'queues'         && <QueueOperationsPanel />}
      {tab === 'rss'            && <RssWorkerPanel />}
      {tab === 'flags'          && <FeatureFlagsPanel />}
      {tab === 'notifications'  && <NotificationHealthPanel />}
      {tab === 'personalization' && <PersonalizationHealthPanel />}
      {tab === 'ranking'        && <RankingHealthPanel />}
      {tab === 'production_health' && <ProductionHealthPanel />}
      {tab === 'deployments'       && <DeploymentsPanel />}
      {tab === 'incidents'         && <IncidentsPanel />}
      {tab === 'rollout_timeline'  && <RolloutTimelinePanel />}
      {tab === 'feed_quality'      && <FeedQualityPanel />}
      {tab === 'monetization'      && <MonetizationPanel />}
      {tab === 'seo_health'        && <SeoHealthPanel />}
      {tab === 'mobile_release'    && <MobileReleasePanel />}
      {tab === 'compliance'        && <CompliancePanel />}
      {tab === 'recovery_center'   && <RecoveryCenterPanel />}
    </div>
  )
}
