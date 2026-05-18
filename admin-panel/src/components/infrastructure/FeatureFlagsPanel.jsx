import { useEffect, useState } from 'react'
import {
  fetchFeatureFlags, fetchFeatureFlagImpact,
  updateFeatureFlag, emergencyDisableFeatureFlag,
} from '../../services/infrastructure'
import { Panel, Banner, Badge, Button, formatRelative } from './UI'

const KNOWN_FLAGS = [
  'queue_based_ingestion',
  'backend_notification_dispatch',
  'personalization_v1',
  'ranking_v1',
  'breaking_feed_v1',
  'worker_heartbeats_required',
]

function FlagCard({ flag, onChange, onEmergencyDisable, busy }) {
  const [enabled, setEnabled] = useState(flag.enabled)
  const [rollout, setRollout] = useState(flag.rollout_percent ?? 0)
  const [impact, setImpact] = useState(null)
  const [reason, setReason] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const dirty = enabled !== flag.enabled || rollout !== (flag.rollout_percent ?? 0)

  useEffect(() => {
    setEnabled(flag.enabled)
    setRollout(flag.rollout_percent ?? 0)
  }, [flag])

  async function preview() {
    setPreviewing(true)
    try {
      const res = await fetchFeatureFlagImpact(flag.name, rollout)
      setImpact(Array.isArray(res) ? res[0] : res)
    } catch (e) {
      window.alert(`Preview failed: ${e.message ?? e}`)
    } finally {
      setPreviewing(false)
    }
  }

  async function save() {
    if (!window.confirm(`Apply flag change to '${flag.name}'?\n  enabled: ${flag.enabled} → ${enabled}\n  rollout: ${flag.rollout_percent ?? 0}% → ${rollout}%`)) return
    await onChange(flag.name, enabled, rollout, reason)
    setReason('')
  }

  function reset() {
    setEnabled(flag.enabled)
    setRollout(flag.rollout_percent ?? 0)
    setImpact(null)
  }

  const tone = flag.enabled
    ? (flag.rollout_percent >= 100 ? 'ok' : 'info')
    : 'off'
  const stateLabel = !flag.enabled
    ? 'OFF'
    : (flag.rollout_percent >= 100 ? 'FULL' : `${flag.rollout_percent}% rollout`)

  return (
    <div className="border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-mono text-sm font-semibold text-gray-800">{flag.name}</h3>
          {flag.description && <p className="text-xs text-gray-500 mt-1 max-w-md">{flag.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={tone}>{stateLabel}</Badge>
          <span className="text-[11px] text-gray-500">updated {formatRelative(flag.updated_at)}</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-3">
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={busy} />
            <span>Enabled</span>
          </label>
          <label className="block text-xs text-gray-600 mt-3">
            Rollout %: <span className="font-mono">{rollout}</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={rollout}
            onChange={e => setRollout(parseInt(e.target.value, 10))}
            disabled={busy || !enabled}
            className="w-full"
          />
          <div className="flex gap-1 mt-1">
            {[0, 1, 5, 10, 25, 50, 100].map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setRollout(v)}
                disabled={busy || !enabled}
                className="text-[11px] px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
              >{v}%</button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Audit reason (recommended)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            className="mt-3 w-full text-sm border-gray-300 rounded-lg"
          />
        </div>
        <div>
          <div className="flex gap-2 flex-wrap">
            <Button tone="ghost" onClick={preview} disabled={previewing}>
              {previewing ? 'Previewing…' : 'Preview impact'}
            </Button>
            <Button tone="primary" onClick={save} disabled={!dirty || busy}>Apply</Button>
            <Button tone="ghost" onClick={reset} disabled={!dirty || busy}>Rollback edits</Button>
            <Button tone="danger" onClick={() => onEmergencyDisable(flag.name, reason || 'emergency_disable')} disabled={busy || (!flag.enabled && flag.rollout_percent === 0)}>
              Emergency disable
            </Button>
          </div>
          {impact && (
            <div className="mt-3 text-xs bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p><strong>Total users:</strong> {impact.total_users}</p>
              <p><strong>Current rollout:</strong> {impact.current_enabled ? 'ON' : 'OFF'} @ {impact.current_rollout_percent}%</p>
              <p><strong>Proposed rollout:</strong> {impact.proposed_rollout_percent}%</p>
              <p><strong>Estimated affected:</strong> ~{impact.estimated_affected_users} users</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function FeatureFlagsPanel() {
  const [flags, setFlags] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true); setError('')
    try {
      const list = await fetchFeatureFlags()
      setFlags(list ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  async function apply(name, enabled, rolloutPercent, reason) {
    setBusy(true); setError('')
    try {
      await updateFeatureFlag(name, enabled, rolloutPercent, reason || null)
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  async function emergency(name, reason) {
    if (!window.confirm(`EMERGENCY DISABLE '${name}'?\nThis will set enabled=false and rollout=0% immediately.`)) return
    setBusy(true); setError('')
    try {
      await emergencyDisableFeatureFlag(name, reason)
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const presentNames = new Set(flags.map(f => f.name))
  const missing = KNOWN_FLAGS.filter(n => !presentNames.has(n))

  return (
    <Panel
      title="Feature flag control center"
      subtitle="Staged rollout + emergency kill-switch. Every change is audit-logged."
      action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {missing.length > 0 && (
        <Banner tone="warn" title={`${missing.length} expected flag(s) not seeded`}>
          {missing.join(', ')} — check migration 045.
        </Banner>
      )}
      <Banner tone="info" title="Rollout safety">
        Use <strong>Preview impact</strong> before applying. Increase rollout in small steps (1% → 5% → 25% → 100%). Use <strong>Emergency disable</strong> if a flag causes incidents — it resets to OFF/0% and is audited.
      </Banner>

      <div className="space-y-3">
        {flags.map(f => (
          <FlagCard key={f.name} flag={f} onChange={apply} onEmergencyDisable={emergency} busy={busy} />
        ))}
      </div>
    </Panel>
  )
}
