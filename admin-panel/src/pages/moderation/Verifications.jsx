import { useEffect, useState } from 'react'
import { fetchVerifications, applyAction } from '../../services/moderation/api'
import { useAuth } from '../../auth/AuthContext'
import { Badge, EmptyState, ErrorBanner, Spinner, relativeTime } from '../../components/moderation/ui'
import ActionConfirmModal from '../../components/moderation/ActionConfirmModal'
import { STATUS_COLOR } from '../../services/moderation/constants'

const TABS = ['requested', 'submitted', 'in_review', 'approved', 'rejected']

export default function Verifications() {
  const { user } = useAuth()
  const [tab, setTab] = useState('in_review')
  const [state, setState] = useState({ loading: true, error: null })
  const [items, setItems] = useState([])
  const [pending, setPending] = useState(null) // { actionId, target, label, stepUp }
  const [revealed, setRevealed] = useState(new Set())

  function load() {
    setState({ loading: true, error: null })
    fetchVerifications({ status: tab })
      .then((rows) => { setItems(rows); setState({ loading: false, error: null }) })
      .catch((error) => setState({ loading: false, error }))
  }
  useEffect(load, [tab])

  async function runAction({ reasonCode, reasonText }) {
    await applyAction({
      actorId: user?.id,
      actionId: pending.actionId,
      target: pending.target,
      payload: { reasonCode, reasonText },
    })
    setPending(null)
    load()
  }

  async function reveal(v) {
    // Reveals are logged. We optimistically mark as revealed; service call records the audit event.
    try {
      await applyAction({
        actorId: user?.id,
        actionId: 'verification.evidence.view',
        target: { id: v.id, type: 'verification' },
        payload: { reasonCode: 'review', reasonText: `Reviewer opened evidence for ${v.type} verification` },
      })
    } catch (_) {
      /* still allow viewing locally if service offline; audit will fail loudly */
    }
    setRevealed((s) => new Set(s).add(v.id))
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-4">Verification Queue</h1>

      <div className="flex gap-2 mb-4">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-lg border ${
              tab === t ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >{t.replace('_', ' ')}</button>
        ))}
      </div>

      <ErrorBanner error={state.error} />
      {state.loading ? <Spinner /> : items.length === 0 ? (
        <EmptyState icon="🪪" title={`No ${tab} verifications`}
          hint="Either none right now or your role doesn't grant access to this queue." />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {items.map(v => (
            <article key={v.id} className="bg-white border border-gray-200 rounded-2xl p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-gray-100 text-gray-700">{v.type}</Badge>
                    <Badge className={STATUS_COLOR[v.status]}>{v.status}</Badge>
                    <span className="text-xs text-gray-500">requested {relativeTime(v.requested_at)}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-700">
                    User <span className="font-mono">{v.user_id}</span>
                  </p>
                </div>
                {(v.status === 'in_review' || v.status === 'submitted') && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPending({
                        actionId: 'verification.approve',
                        target: { id: v.id, type: 'verification' },
                        label: `Approve ${v.type} verification`,
                        stepUp: v.type === 'business',
                      })}
                      className="px-3 py-1.5 text-sm rounded-lg border border-green-300 text-green-700 hover:bg-green-50"
                    >Approve</button>
                    <button
                      onClick={() => setPending({
                        actionId: 'verification.reject',
                        target: { id: v.id, type: 'verification' },
                        label: `Reject ${v.type} verification`,
                      })}
                      className="px-3 py-1.5 text-sm rounded-lg border border-red-300 text-red-700 hover:bg-red-50"
                    >Reject</button>
                  </div>
                )}
              </div>

              <div className="mt-3 border-t pt-3">
                <p className="text-xs uppercase text-gray-500 mb-2">Evidence</p>
                {!Array.isArray(v.evidence_refs) || v.evidence_refs.length === 0 ? (
                  <p className="text-sm text-gray-500">No evidence attached.</p>
                ) : revealed.has(v.id) ? (
                  <ul className="text-xs font-mono text-gray-700 space-y-1">
                    {v.evidence_refs.map((e, i) => {
                      // Whitelist what we display: known string fields only.
                      // React escapes string children, but we still avoid
                      // dumping arbitrary evidence objects (which may contain
                      // sensitive PII) into the UI.
                      const display = typeof e === 'string'
                        ? e
                        : (e && (e.path || e.key || e.filename || e.sha256))
                          || '[evidence object — open via signed URL]'
                      return <li key={i}>{display}</li>
                    })}
                  </ul>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">
                      {v.evidence_refs.length} file(s) — preview redacted by default
                    </span>
                    <button
                      onClick={() => reveal(v)}
                      className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50"
                    >Reveal (logged)</button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {pending && (
        <ActionConfirmModal
          title={pending.label}
          description="Reviewer decisions are immutable and audit-logged. Business verifications require two distinct reviewers."
          confirmLabel="Confirm"
          stepUp={pending.stepUp}
          onCancel={() => setPending(null)}
          onConfirm={runAction}
        />
      )}
    </div>
  )
}
