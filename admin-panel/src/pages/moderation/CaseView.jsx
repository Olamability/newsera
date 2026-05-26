import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { fetchCase, applyAction } from '../../services/moderation/api'
import { useAuth } from '../../auth/AuthContext'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import ActionConfirmModal from '../../components/moderation/ActionConfirmModal'
import { SEVERITY_COLOR, SEVERITY_LABEL, STATUS_COLOR } from '../../services/moderation/constants'

const ACTION_BUTTONS = [
  { id: 'listing.hide',           label: 'Hide listing',      stepUp: false, tone: 'amber' },
  { id: 'listing.remove',         label: 'Remove listing',    stepUp: true,  tone: 'red'   },
  { id: 'user.warn',              label: 'Warn user',         stepUp: false, tone: 'amber' },
  { id: 'user.suspend.temp',      label: 'Suspend (≤7d)',     stepUp: false, tone: 'red'   },
  { id: 'user.suspend.long',      label: 'Suspend (≤90d)',    stepUp: true,  tone: 'red'   },
  { id: 'user.suspend.permanent', label: 'Suspend permanently', stepUp: true, tone: 'red' },
  { id: 'verification.request',   label: 'Request verification', stepUp: false, tone: 'indigo' },
  { id: 'case.escalate',          label: 'Escalate',          stepUp: false, tone: 'indigo' },
]

const TONE = {
  gray:   'border-gray-300 text-gray-700 hover:bg-gray-50',
  amber:  'border-amber-300 text-amber-800 hover:bg-amber-50',
  red:    'border-red-300 text-red-700 hover:bg-red-50',
  indigo: 'border-indigo-300 text-indigo-700 hover:bg-indigo-50',
}

export default function CaseView() {
  const { id } = useParams()
  const { user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [pending, setPending] = useState(null) // { actionId, label, stepUp }

  function load() {
    setState((s) => ({ ...s, loading: true }))
    fetchCase(id)
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((error) => setState({ loading: false, error, data: null }))
  }
  useEffect(() => { load() }, [id])

  async function runAction({ reasonCode, reasonText }) {
    const c = state.data?.case
    if (!c) return
    // For per-report actions, the caller supplies pending.target directly.
    const target = pending.target ?? (
      pending.actionId.startsWith('listing.') ? { id: c.target_id, type: 'listing' }
      : pending.actionId.startsWith('user.') || pending.actionId === 'verification.request'
        ? { id: c.target_id, type: 'user' }
      : { id: c.id, type: 'case' }
    )

    await applyAction({
      actorId: user?.id,
      actionId: pending.actionId,
      target,
      payload: { reasonCode, reasonText, caseId: c.id },
    })
    setPending(null)
    load()
  }

  if (state.loading) return <Spinner />
  if (state.error)   return <ErrorBanner error={state.error} />
  const data = state.data
  if (!data?.case) return <EmptyState icon="🔍" title="Case not found" />

  const c = data.case
  return (
    <div>
      <div className="mb-4">
        <Link to="/moderation/reports" className="text-sm text-indigo-600 hover:underline">← Back to queue</Link>
      </div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">
            Case {c.id.slice(0, 8)}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {c.target_type}:<span className="font-mono">{c.target_id}</span> · opened {relativeTime(c.opened_at)}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge className={SEVERITY_COLOR[c.severity]}>{SEVERITY_LABEL[c.severity]}</Badge>
          <Badge className={STATUS_COLOR[c.status]}>{c.status}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Section title={`Reports (${data.reports.length})`}>
            {data.reports.length === 0 ? <EmptyState icon="📭" title="No linked reports" /> : (
              <ul className="divide-y divide-gray-100">
                {data.reports.map(r => (
                  <li key={r.id} className="py-2 text-sm flex items-center gap-3">
                    <Badge className={SEVERITY_COLOR[r.severity]}>{SEVERITY_LABEL[r.severity]}</Badge>
                    <span className="font-medium">{r.reason_code}</span>
                    <span className="text-gray-500 truncate flex-1">{r.description || '—'}</span>
                    <span className="text-xs text-gray-500">{relativeTime(r.created_at)}</span>
                    {r.status !== 'dismissed' && r.status !== 'resolved' && (
                      <button
                        onClick={() => setPending({
                          actionId: 'report.dismiss',
                          target: { id: r.id, type: 'report' },
                          label: `Dismiss report ${r.id.slice(0, 8)}`,
                        })}
                        className="px-2 py-0.5 text-xs rounded border border-gray-300 hover:bg-gray-50"
                      >Dismiss</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Fraud signals (${data.signals.length})`}>
            {data.signals.length === 0 ? <EmptyState icon="🛡️" title="No signals on this subject" /> : (
              <ul className="divide-y divide-gray-100">
                {data.signals.slice(0, 20).map(s => (
                  <li key={s.id} className="py-2 text-sm flex items-center gap-3">
                    <Badge className="bg-gray-100 text-gray-700">{s.signal_code}</Badge>
                    <span className="text-gray-500">score {Number(s.score).toFixed(0)} · {s.source}</span>
                    {s.rule_id && <span className="text-xs font-mono text-gray-400">{s.rule_id} v{s.rule_version}</span>}
                    <span className="ml-auto text-xs text-gray-500">{relativeTime(s.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Action history (${data.actions.length})`}>
            {data.actions.length === 0 ? <EmptyState icon="🗒️" title="No actions yet" /> : (
              <ul className="divide-y divide-gray-100">
                {data.actions.map(a => (
                  <li key={a.id} className="py-2 text-sm">
                    <span className="font-medium">{a.action}</span>{' '}
                    <span className="text-gray-500">by {a.actor_kind === 'system' ? `system (${a.rule_id})` : (a.actor_role || 'admin')}</span>
                    {a.reason_code && <span className="ml-2 text-xs text-gray-400">[{a.reason_code}] {a.reason_text}</span>}
                    <span className="ml-2 text-xs text-gray-400">{relativeTime(a.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside className="space-y-3">
          <Section title="Actions">
            <p className="text-xs text-gray-500 mb-3">
              Every action requires a reason and is recorded in the immutable audit log.
              Buttons your role can't use will return a permission error.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {ACTION_BUTTONS.map(b => (
                <button
                  key={b.id}
                  onClick={() => setPending({ actionId: b.id, label: b.label, stepUp: b.stepUp })}
                  className={`px-3 py-2 text-sm rounded-lg border ${TONE[b.tone]}`}
                >{b.label}</button>
              ))}
            </div>
          </Section>
        </aside>
      </div>

      {pending && (
        <ActionConfirmModal
          title={pending.label}
          description="This action is recorded in the immutable admin activity log."
          confirmLabel="Apply"
          stepUp={pending.stepUp}
          onCancel={() => setPending(null)}
          onConfirm={runAction}
        />
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-5">
      <h2 className="font-semibold text-gray-800 mb-3">{title}</h2>
      {children}
    </section>
  )
}
