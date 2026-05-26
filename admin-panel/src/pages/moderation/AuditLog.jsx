import { useEffect, useMemo, useState } from 'react'
import { fetchAuditLog, verifyAuditChain } from '../../services/moderation/api'
import { EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'

function toCsv(rows) {
  if (rows.length === 0) return ''
  const cols = ['id', 'occurred_at', 'request_id', 'actor_id', 'actor_role', 'action',
                'target_type', 'target_id', 'reason_code', 'reason_text', 'prev_hash', 'row_hash']
  // RFC 4180: fields containing quote / comma / CR / LF must be quoted; embedded
  // quotes are doubled. We also strip NUL bytes (which Excel mishandles).
  const esc = (v) => {
    if (v == null) return ''
    const raw = typeof v === 'object' ? JSON.stringify(v) : String(v)
    const s = raw.replace(/\u0000/g, '')
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  // CRLF line endings per RFC 4180
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n')
}

export default function AuditLog() {
  const [state, setState] = useState({ loading: true, error: null })
  const [items, setItems] = useState([])
  const [filters, setFilters] = useState({ actor: '', action: '', target: '' })
  const [chain, setChain] = useState(null) // { ok: bool, broken_at }

  useEffect(() => {
    fetchAuditLog({ limit: 500 })
      .then((rows) => { setItems(rows); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }, [])

  const filtered = useMemo(() => items.filter(r =>
    (!filters.actor  || (r.actor_id || '').includes(filters.actor)) &&
    (!filters.action || r.action.includes(filters.action)) &&
    (!filters.target || `${r.target_type}:${r.target_id}`.includes(filters.target))
  ), [items, filters])

  function exportCsv() {
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `admin-audit-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function checkChain() {
    setChain(null)
    try { setChain(await verifyAuditChain()) }
    catch (e) { setChain({ ok: false, error: e.message }) }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Audit Log</h1>
        <div className="flex gap-2">
          <button onClick={checkChain}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">
            Verify hash chain
          </button>
          <button onClick={exportCsv}
                  className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            Export CSV
          </button>
        </div>
      </div>

      {chain && (
        <div className={`mb-4 p-3 rounded-lg border text-sm ${
          chain.ok ? 'border-green-200 bg-green-50 text-green-800'
                   : 'border-red-200 bg-red-50 text-red-700'
        }`}>
          {chain.ok ? '✓ Hash chain intact — no tampering detected.' :
           chain.error ? `Verification error: ${chain.error}`
                       : `⚠ Hash chain broken at row #${chain.broken_at}`}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <input placeholder="Filter by actor id…" value={filters.actor}
               onChange={(e) => setFilters(f => ({ ...f, actor: e.target.value }))}
               className="rounded-lg border-gray-300 text-sm" />
        <input placeholder="Filter by action…" value={filters.action}
               onChange={(e) => setFilters(f => ({ ...f, action: e.target.value }))}
               className="rounded-lg border-gray-300 text-sm" />
        <input placeholder="Filter by target (type:id)…" value={filters.target}
               onChange={(e) => setFilters(f => ({ ...f, target: e.target.value }))}
               className="rounded-lg border-gray-300 text-sm" />
      </div>

      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : filtered.length === 0 ? (
        <EmptyState icon="📜" title="No audit entries"
          hint="If you expect entries, check that your role has 'audit.read'." />
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Row hash</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.id}</td>
                  <td className="px-3 py-2 text-gray-500">{relativeTime(r.occurred_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.actor_role || '—'}{r.actor_id ? ` (${r.actor_id.slice(0,8)})` : ''}</td>
                  <td className="px-3 py-2 font-medium">{r.action}</td>
                  <td className="px-3 py-2 text-gray-600 font-mono text-xs">{r.target_type}:{r.target_id}</td>
                  <td className="px-3 py-2 text-gray-600">{r.reason_code || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400" title={r.row_hash}>
                    {r.row_hash ? r.row_hash.slice(0, 12) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
