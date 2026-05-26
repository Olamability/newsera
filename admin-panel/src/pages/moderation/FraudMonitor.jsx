import { useEffect, useState } from 'react'
import { fetchFraudSignals, fetchRiskScores } from '../../services/moderation/api'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import { BAND_COLOR } from '../../services/moderation/constants'

export default function FraudMonitor() {
  const [state, setState] = useState({ loading: true, error: null })
  const [signals, setSignals] = useState([])
  const [scores, setScores]   = useState([])

  function load() {
    setState({ loading: true, error: null })
    Promise.all([fetchFraudSignals({ limit: 200 }), fetchRiskScores({ limit: 200 })])
      .then(([sig, sc]) => { setSignals(sig); setScores(sc); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }
  useEffect(load, [])

  // Group signals by rule_id for the "rule triggers" panel
  const byRule = signals.reduce((acc, s) => {
    if (!s.rule_id) return acc
    if (!acc[s.rule_id]) acc[s.rule_id] = { count: 0, last: s.occurred_at, last_score: Number(s.score) }
    acc[s.rule_id].count++
    if (s.occurred_at > acc[s.rule_id].last) acc[s.rule_id].last = s.occurred_at
    return acc
  }, {})
  const ruleRows = Object.entries(byRule).sort((a, b) => b[1].count - a[1].count)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Fraud Monitor</h1>
        <button onClick={load} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">
          Refresh
        </button>
      </div>

      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="bg-white border border-gray-200 rounded-2xl p-5 lg:col-span-2">
            <h2 className="font-semibold text-gray-800 mb-3">Live signal stream</h2>
            {signals.length === 0 ? (
              <EmptyState icon="🛡️" title="No signals" hint="Fraud engine hasn't emitted anything yet." />
            ) : (
              <ul className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
                {signals.slice(0, 100).map(s => (
                  <li key={s.id} className="py-2 text-sm flex items-center gap-3">
                    <span className="text-xs text-gray-400 w-14">{relativeTime(s.occurred_at)}</span>
                    <Badge className="bg-gray-100 text-gray-700">{s.signal_code}</Badge>
                    <span className="text-gray-500 truncate">
                      {s.subject_type}:<span className="font-mono">{s.subject_id}</span>
                    </span>
                    <span className="ml-auto text-xs text-gray-500">score {Number(s.score).toFixed(0)} · {s.source}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-white border border-gray-200 rounded-2xl p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Rule triggers</h2>
            {ruleRows.length === 0 ? (
              <EmptyState icon="📜" title="No rule triggers yet" />
            ) : (
              <ul className="divide-y divide-gray-100">
                {ruleRows.map(([rule, info]) => (
                  <li key={rule} className="py-2 text-sm flex items-center justify-between">
                    <span className="font-mono text-xs">{rule}</span>
                    <span className="text-gray-500">{info.count} · {relativeTime(info.last)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-white border border-gray-200 rounded-2xl p-5 lg:col-span-3">
            <h2 className="font-semibold text-gray-800 mb-3">Risk scores</h2>
            {scores.length === 0 ? (
              <EmptyState icon="📊" title="No risk scores computed" />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500">
                    <tr><th className="py-2">Subject</th><th>Score</th><th>Band</th><th>Model</th><th>Computed</th></tr>
                  </thead>
                  <tbody>
                    {scores.map(s => (
                      <tr key={`${s.subject_type}:${s.subject_id}`} className="border-t">
                        <td className="py-2">
                          <span className="text-gray-700">{s.subject_type}:</span>
                          <span className="font-mono text-xs ml-1">{s.subject_id}</span>
                        </td>
                        <td>{Number(s.score).toFixed(0)}</td>
                        <td><Badge className={BAND_COLOR[s.band]}>{s.band}</Badge></td>
                        <td className="text-gray-500">{s.model_version}</td>
                        <td className="text-gray-500">{relativeTime(s.computed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
