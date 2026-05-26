import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchReportQueue, applyAction } from '../../services/moderation/api'
import { useAuth } from '../../auth/AuthContext'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import ActionConfirmModal from '../../components/moderation/ActionConfirmModal'
import {
  REASON_CODES, SEVERITY_COLOR, SEVERITY_LABEL, STATUS_COLOR,
} from '../../services/moderation/constants'

const FILTERS = {
  severity: ['', '1', '2', '3', '4', '5'],
  status:   ['', 'open', 'triaged', 'in_review'],
  target:   ['', 'listing', 'user', 'comment', 'message', 'article'],
}

export default function ReportsQueue() {
  const { user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null })
  const [items, setItems] = useState([])
  const [filters, setFilters] = useState({ severity: '', status: '', target: '', reason: '' })
  const [selected, setSelected] = useState(new Set())
  const [pendingAction, setPendingAction] = useState(null) // { actionId, target, label }

  function load() {
    setState({ loading: true, error: null })
    fetchReportQueue({ limit: 200 })
      .then((rows) => { setItems(rows); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }
  useEffect(load, [])

  const filtered = useMemo(() => items.filter(r =>
    (!filters.severity || String(r.severity) === filters.severity) &&
    (!filters.status   || r.status === filters.status) &&
    (!filters.target   || r.target_type === filters.target) &&
    (!filters.reason   || r.reason_code === filters.reason)
  ), [items, filters])

  function toggleSelect(id) {
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function startBulk(actionId, label) {
    if (selected.size === 0) return
    setPendingAction({ actionId, label, bulk: true })
  }

  async function runAction({ reasonCode, reasonText }) {
    if (!pendingAction) return
    const targets = pendingAction.bulk
      ? [...selected].map((id) => items.find(r => r.id === id)).filter(Boolean)
      : [pendingAction.target]
    for (const t of targets) {
      await applyAction({
        actorId: user?.id,
        actionId: pendingAction.actionId,
        target: { id: t.id, type: 'report' },
        payload: { reasonCode, reasonText },
      })
    }
    setPendingAction(null)
    setSelected(new Set())
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Reports Queue</h1>
        <div className="flex gap-2">
          <button
            onClick={() => startBulk('report.assign', `Assign ${selected.size} reports to me`)}
            disabled={selected.size === 0}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
          >Claim selected ({selected.size})</button>
          <button
            onClick={() => startBulk('report.dismiss', `Dismiss ${selected.size} reports`)}
            disabled={selected.size === 0}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
          >Dismiss selected</button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-4 flex flex-wrap gap-3 items-end">
        <FilterSelect label="Severity" value={filters.severity}
          onChange={(v) => setFilters(f => ({ ...f, severity: v }))} options={FILTERS.severity}
          render={(v) => v ? SEVERITY_LABEL[v] : 'Any'} />
        <FilterSelect label="Status" value={filters.status}
          onChange={(v) => setFilters(f => ({ ...f, status: v }))} options={FILTERS.status}
          render={(v) => v || 'Any'} />
        <FilterSelect label="Target" value={filters.target}
          onChange={(v) => setFilters(f => ({ ...f, target: v }))} options={FILTERS.target}
          render={(v) => v || 'Any'} />
        <div>
          <label className="block text-xs text-gray-500 mb-1">Reason</label>
          <select value={filters.reason} onChange={(e) => setFilters(f => ({ ...f, reason: e.target.value }))}
                  className="rounded-lg border-gray-300 text-sm">
            <option value="">Any</option>
            {REASON_CODES.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
      </div>

      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : filtered.length === 0 ? (
        <EmptyState icon="📭" title="No reports match your filters"
          hint="Try clearing filters — empty state usually means clean queue or restricted view." />
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">SLA</th>
                <th className="px-3 py-2">Age</th>
                <th className="px-3 py-2">Case</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} />
                  </td>
                  <td className="px-3 py-2"><Badge className={SEVERITY_COLOR[r.severity]}>{SEVERITY_LABEL[r.severity]}</Badge></td>
                  <td className="px-3 py-2"><Badge className={STATUS_COLOR[r.status]}>{r.status}</Badge></td>
                  <td className="px-3 py-2 font-medium text-gray-800">{r.reason_code}</td>
                  <td className="px-3 py-2 text-gray-600 font-mono text-xs">{r.target_type}:{r.target_id}</td>
                  <td className="px-3 py-2">
                    {r.sla_hours_remaining === 0
                      ? <span className="text-red-600 font-medium">Breached</span>
                      : `${Number(r.sla_hours_remaining).toFixed(1)}h`}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{relativeTime(r.created_at)}</td>
                  <td className="px-3 py-2">
                    {r.case_id ? (
                      <Link to={`/moderation/cases/${r.case_id}`} className="text-indigo-600 hover:underline">Open case →</Link>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingAction && (
        <ActionConfirmModal
          title={pendingAction.label}
          description="This action is recorded in the immutable admin activity log."
          confirmLabel="Apply"
          onCancel={() => setPendingAction(null)}
          onConfirm={runAction}
        />
      )}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options, render }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
              className="rounded-lg border-gray-300 text-sm">
        {options.map(o => <option key={o} value={o}>{render(o)}</option>)}
      </select>
    </div>
  )
}
