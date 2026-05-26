import { useEffect, useState } from 'react'
import { fetchMetricsDaily, fetchReportQueue, fetchRiskScores } from '../../services/moderation/api'
import { ErrorBanner, Spinner, EmptyState } from '../../components/moderation/ui'

/**
 * Lightweight inline SVG charts to avoid adding a chart dependency.
 * Designed for low data volumes (daily snapshots ≤ 365 points).
 */
function LineChart({ data, accessor, label, color = '#4f46e5' }) {
  if (!data || data.length === 0) return <EmptyState icon="📊" title={`No ${label} data`} />
  const w = 600, h = 160, pad = 30
  const ys = data.map(accessor)
  const max = Math.max(1, ...ys)
  const step = (w - pad * 2) / Math.max(1, data.length - 1)
  const points = ys.map((y, i) => [pad + i * step, h - pad - (y / max) * (h - pad * 2)])
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  return (
    <div>
      <p className="text-sm text-gray-600 mb-1">{label} <span className="text-xs text-gray-400">(max {max})</span></p>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40">
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e5e7eb" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" />
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2" fill={color} />
        ))}
      </svg>
    </div>
  )
}

export default function Analytics() {
  const [state, setState] = useState({ loading: true, error: null })
  const [metrics, setMetrics] = useState([])
  const [queue, setQueue]     = useState([])
  const [risk, setRisk]       = useState([])

  useEffect(() => {
    Promise.all([
      fetchMetricsDaily({ days: 30 }),
      fetchReportQueue({ limit: 500 }),
      fetchRiskScores({ limit: 500 }),
    ])
      .then(([m, q, r]) => { setMetrics(m); setQueue(q); setRisk(r); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }, [])

  // SLA compliance: fraction of open queue items that are NOT breached
  const slaCompliance = queue.length === 0 ? null
    : Math.round((queue.filter(r => r.sla_hours_remaining > 0).length / queue.length) * 100)

  const bandCounts = risk.reduce((acc, s) => { acc[s.band] = (acc[s.band] || 0) + 1; return acc }, {})

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Moderation Analytics</h1>
      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="SLA compliance (queue)" value={slaCompliance == null ? '—' : `${slaCompliance}%`} />
            <Tile label="Reports opened (30d)" value={sum(metrics, 'reports_opened')} />
            <Tile label="Reports resolved (30d)" value={sum(metrics, 'reports_resolved')} />
            <Tile label="Suspensions issued (30d)" value={sum(metrics, 'suspensions_issued')} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card title="Reports opened vs resolved">
              <LineChart data={metrics} accessor={(d) => d.reports_opened} label="Opened" color="#4f46e5" />
              <LineChart data={metrics} accessor={(d) => d.reports_resolved} label="Resolved" color="#10b981" />
            </Card>
            <Card title="Verification approvals (daily)">
              <LineChart data={metrics} accessor={(d) => d.verifications_approved} label="Approved" color="#10b981" />
              <LineChart data={metrics} accessor={(d) => d.verifications_rejected} label="Rejected" color="#ef4444" />
            </Card>
            <Card title="Fraud signals (daily)">
              <LineChart data={metrics} accessor={(d) => d.signals_emitted} label="Signals emitted" color="#f59e0b" />
            </Card>
            <Card title="Risk distribution (current)">
              <ul className="text-sm space-y-1">
                {['critical', 'high', 'medium', 'low'].map(b => (
                  <li key={b} className="flex justify-between">
                    <span className="capitalize">{b}</span>
                    <span className="font-medium">{bandCounts[b] || 0}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({ label, value }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5">
      <p className="text-xs uppercase text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-gray-800 mt-1">{value}</p>
    </div>
  )
}
function Card({ title, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-5">
      <h2 className="font-semibold text-gray-800 mb-3">{title}</h2>
      {children}
    </section>
  )
}
function sum(rows, key) { return rows.reduce((a, r) => a + Number(r[key] || 0), 0) }
