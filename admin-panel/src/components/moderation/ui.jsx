export function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {children}
    </span>
  )
}

export function EmptyState({ icon = '📭', title, hint }) {
  return (
    <div className="text-center py-12 text-gray-500">
      <p className="text-4xl mb-2">{icon}</p>
      <p className="font-medium text-gray-700">{title}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  )
}

export function ErrorBanner({ error }) {
  if (!error) return null
  return (
    <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
      {String(error.message || error)}
    </div>
  )
}

export function Spinner() {
  return <p className="text-sm text-gray-500">Loading…</p>
}

export function relativeTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const min = Math.round(diff / 60000)
  if (min < 1)  return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24)   return `${h}h ago`
  const days = Math.round(h / 24)
  return `${days}d ago`
}
