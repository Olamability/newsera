import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchReportQueue, fetchVerifications, fetchSuspensions, fetchRiskScores, fetchAuditLog,
} from '../../services/moderation/api'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import { SEVERITY_COLOR, SEVERITY_LABEL, BAND_COLOR } from '../../services/moderation/constants'

function StatCard({ label, value, hint, tone = 'indigo' }) {
  const tones = {
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    red:    'border-red-200 bg-red-50 text-red-800',
    amber:  'border-amber-200 bg-amber-50 text-amber-800',
    green:  'border-green-200 bg-green-50 text-green-800',
    gray:   'border-gray-200 bg-gray-50 text-gray-800',
  }
  return (
    <div className={`border rounded-2xl p-5 ${tones[tone]}`}>
      <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{label}</p>
      <p className="text-3xl font-bold mt-1">{value ?? '—'}</p>
      {hint && <p className="text-xs mt-1 opacity-70">{hint}</p>}
    </div>
  )
}

export default function ModerationOverview() {
  const [state, setState] = useState({ loading: true, error: null })
  const [queue, setQueue] = useState([])
  const [verifs, setVerifs] = useState([])
  const [susp, setSusp] = useState([])
  const [highRisk, setHighRisk] = useState([])
  const [activity, setActivity] = useState([])

  useEffect(() => {
    Promise.all([
      fetchReportQueue({ limit: 100 }),
      fetchVerifications({ status: 'in_review' }),
      fetchSuspensions({ activeOnly: true }),
      fetchRiskScores({ band: 'high' }),
      fetchAuditLog({ limit: 15 }),
    ])
      .then(([q, v, s, h, a]) => {
        setQueue(q); setVerifs(v); setSusp(s); setHighRisk(h); setActivity(a)
        setState({ loading: false, error: null })
      })
      .catch((error) => setState({ loading: false, error }))
  }, [])

  const slaBreached = queue.filter(r => r.sla_hours_remaining === 0).length
  const today = new Date().toISOString().slice(0, 10)
  const suspensionsToday = susp.filter(s => (s.starts_at || '').slice(0, 10) === today).length

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Moderation Overview</h1>
      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <StatCard label="Open reports" value={queue.length} tone="indigo" />
            <StatCard label="SLA breaches" value={slaBreached} tone="red" hint="reports past due" />
            <StatCard label="Suspensions today" value={suspensionsToday} tone="amber" />
            <StatCard label="High-risk users/listings" value={highRisk.length} tone="amber" />
            <StatCard label="Verifications pending" value={verifs.length} tone="indigo" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800">Top of report queue</h2>
                <Link to="/moderation/reports" className="text-sm text-indigo-600 hover:underline">View all →</Link>
              </div>
              {queue.length === 0 ? (
                <EmptyState icon="✅" title="Queue is clear" hint="No open reports right now." />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {queue.slice(0, 6).map(r => (
                    <li key={r.id} className="py-2 flex items-center gap-3 text-sm">
                      <Badge className={SEVERITY_COLOR[r.severity]}>{SEVERITY_LABEL[r.severity]}</Badge>
                      <span className="font-medium text-gray-800 truncate">{r.reason_code}</span>
                      <span className="text-gray-500 truncate">{r.target_type}:{r.target_id}</span>
                      <span className="ml-auto text-xs text-gray-500">{relativeTime(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800">Recent admin activity</h2>
                <Link to="/moderation/audit" className="text-sm text-indigo-600 hover:underline">Audit log →</Link>
              </div>
              {activity.length === 0 ? (
                <EmptyState icon="📭" title="No recent activity" />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {activity.map(a => (
                    <li key={a.id} className="py-2 text-sm">
                      <span className="font-medium">{a.action}</span>{' '}
                      <span className="text-gray-500">on {a.target_type}:{a.target_id}</span>
                      <span className="ml-2 text-xs text-gray-400">{relativeTime(a.occurred_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="bg-white rounded-2xl border border-gray-200 p-5 lg:col-span-2">
              <h2 className="font-semibold text-gray-800 mb-3">High-risk subjects</h2>
              {highRisk.length === 0 ? (
                <EmptyState icon="🛡️" title="No high-risk subjects" hint="Fraud engine has not flagged anything." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs uppercase text-gray-500">
                      <tr><th className="py-2">Type</th><th>Id</th><th>Score</th><th>Band</th><th>Computed</th></tr>
                    </thead>
                    <tbody>
                      {highRisk.slice(0, 10).map(s => (
                        <tr key={`${s.subject_type}:${s.subject_id}`} className="border-t">
                          <td className="py-2">{s.subject_type}</td>
                          <td className="font-mono text-xs">{s.subject_id}</td>
                          <td>{Number(s.score).toFixed(0)}</td>
                          <td><Badge className={BAND_COLOR[s.band]}>{s.band}</Badge></td>
                          <td className="text-gray-500">{relativeTime(s.computed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
