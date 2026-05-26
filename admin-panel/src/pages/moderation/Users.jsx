import { useEffect, useState } from 'react'
import { fetchSuspensions, applyAction } from '../../services/moderation/api'
import { useAuth } from '../../auth/AuthContext'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import ActionConfirmModal from '../../components/moderation/ActionConfirmModal'

export default function UsersModeration() {
  const { user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null })
  const [items, setItems] = useState([])
  const [activeOnly, setActiveOnly] = useState(true)
  const [pending, setPending] = useState(null)
  const [filter, setFilter] = useState('')

  function load() {
    setState({ loading: true, error: null })
    fetchSuspensions({ activeOnly })
      .then((rows) => { setItems(rows); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }
  useEffect(load, [activeOnly])

  const filtered = items.filter(s => !filter || (s.user_id || '').includes(filter))

  async function runAction({ reasonCode, reasonText }) {
    await applyAction({
      actorId: user?.id,
      actionId: pending.actionId,
      target: pending.target,
      payload: { reasonCode, reasonText, ...(pending.extra || {}) },
    })
    setPending(null)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Users — Suspensions</h1>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Filter by user id</label>
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
                 className="w-full rounded-lg border-gray-300 text-sm" placeholder="paste user id…" />
        </div>
        <button
          onClick={() => filter && setPending({
            actionId: 'user.suspend.temp',
            target: { id: filter, type: 'user' },
            label: 'Suspend user (≤7 days)',
            extra: { durationDays: 7, scope: 'full' },
          })}
          disabled={!filter}
          className="px-3 py-2 text-sm rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40"
        >Suspend 7d</button>
        <button
          onClick={() => filter && setPending({
            actionId: 'user.suspend.permanent',
            target: { id: filter, type: 'user' },
            label: 'Suspend user PERMANENTLY',
            stepUp: true,
          })}
          disabled={!filter}
          className="px-3 py-2 text-sm rounded-lg border border-red-400 text-red-800 hover:bg-red-100 disabled:opacity-40"
        >Suspend permanently</button>
      </div>

      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : filtered.length === 0 ? (
        <EmptyState icon="👤" title="No suspensions"
          hint={activeOnly ? 'No active suspensions match the filter.' : 'No suspensions in the records.'} />
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Ends</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Appeal</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const active = !s.lifted_at && (!s.ends_at || new Date(s.ends_at) > new Date())
                return (
                  <tr key={s.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{s.user_id}</td>
                    <td className="px-3 py-2">
                      <Badge className="bg-gray-100 text-gray-700">{s.scope}</Badge>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{relativeTime(s.starts_at)}</td>
                    <td className="px-3 py-2 text-gray-500">{s.ends_at ? new Date(s.ends_at).toLocaleString() : 'permanent'}</td>
                    <td className="px-3 py-2">{s.reason_code}</td>
                    <td className="px-3 py-2">
                      <Badge className={s.appeal_status === 'none' ? 'bg-gray-100 text-gray-700' : 'bg-amber-100 text-amber-800'}>
                        {s.appeal_status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {active && (
                        <button
                          onClick={() => setPending({
                            actionId: 'user.unsuspend',
                            target: { id: s.user_id, type: 'user' },
                            label: 'Lift suspension',
                          })}
                          className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                        >Lift</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pending && (
        <ActionConfirmModal
          title={pending.label}
          description="Suspensions and lifts are recorded in the immutable audit log."
          confirmLabel="Apply"
          stepUp={!!pending.stepUp}
          onCancel={() => setPending(null)}
          onConfirm={runAction}
        />
      )}
    </div>
  )
}
