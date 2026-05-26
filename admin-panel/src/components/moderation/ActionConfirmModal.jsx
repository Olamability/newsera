import { useState } from 'react'
import { REASON_CODES } from '../../services/moderation/constants'

/**
 * Required-reason modal used by every destructive moderation action.
 * Never confirm without (reasonCode + free text) → no silent admin actions.
 *
 * Props:
 *   title, description, confirmLabel
 *   stepUp:  when true, require typing the word "CONFIRM" before submit
 *   onCancel(): void
 *   onConfirm({ reasonCode, reasonText }): Promise<void>
 */
export default function ActionConfirmModal({
  title,
  description,
  confirmLabel = 'Confirm',
  stepUp = false,
  onCancel,
  onConfirm,
}) {
  const [reasonCode, setReasonCode] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [stepUpInput, setStepUpInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const canSubmit =
    !!reasonCode &&
    reasonText.trim().length >= 5 &&
    (!stepUp || stepUpInput.trim().toUpperCase() === 'CONFIRM')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      await onConfirm({ reasonCode, reasonText: reasonText.trim() })
    } catch (err) {
      setError(err.message || String(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6"
      >
        <h3 className="text-lg font-bold text-gray-800">{title}</h3>
        {description && <p className="text-sm text-gray-600 mt-1">{description}</p>}

        <label className="block mt-4 text-sm font-medium text-gray-700">Reason</label>
        <select
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="mt-1 w-full rounded-lg border-gray-300 text-sm"
          required
        >
          <option value="">Select a reason…</option>
          {REASON_CODES.map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </select>

        <label className="block mt-3 text-sm font-medium text-gray-700">
          Notes <span className="text-gray-400 text-xs">(min 5 chars — recorded in audit log)</span>
        </label>
        <textarea
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border-gray-300 text-sm"
          required
        />

        {stepUp && (
          <>
            <label className="block mt-3 text-sm font-medium text-red-700">
              Type CONFIRM to proceed (high-impact action)
            </label>
            <input
              value={stepUpInput}
              onChange={(e) => setStepUpInput(e.target.value)}
              className="mt-1 w-full rounded-lg border-red-300 text-sm uppercase"
            />
          </>
        )}

        {error && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || busy}
            className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
