// Small shared primitives used across infrastructure panels.

import {
  formatDateTime as sharedFormatDateTime,
  formatRelative as sharedFormatRelative,
} from '../../lib/dateUtils'

export function Panel({ title, subtitle, action, children }) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

export function StatGrid({ children }) {
  return <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">{children}</div>
}

const TONES = {
  neutral: 'bg-gray-50 border-gray-200 text-gray-700',
  good:    'bg-green-50 border-green-200 text-green-700',
  warn:    'bg-yellow-50 border-yellow-200 text-yellow-800',
  bad:     'bg-red-50 border-red-200 text-red-700',
  info:    'bg-blue-50 border-blue-200 text-blue-700',
}

export function Stat({ label, value, tone = 'neutral', hint }) {
  return (
    <div className={`border rounded-xl px-3 py-2 ${TONES[tone] ?? TONES.neutral}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-xl font-bold mt-0.5">{value ?? '—'}</p>
      {hint && <p className="text-[11px] opacity-70 mt-0.5">{hint}</p>}
    </div>
  )
}

export function Banner({ tone = 'info', title, children }) {
  return (
    <div className={`border rounded-xl px-4 py-3 mb-4 text-sm ${TONES[tone] ?? TONES.info}`}>
      {title && <p className="font-semibold mb-0.5">{title}</p>}
      {children && <div className="opacity-90">{children}</div>}
    </div>
  )
}

const BADGES = {
  ok:   'bg-green-100 text-green-800',
  warn: 'bg-yellow-100 text-yellow-800',
  bad:  'bg-red-100 text-red-800',
  off:  'bg-gray-100 text-gray-700',
  info: 'bg-blue-100 text-blue-800',
}

export function Badge({ tone = 'info', children }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${BADGES[tone] ?? BADGES.info}`}>
      {children}
    </span>
  )
}

export function Button({ children, onClick, disabled, tone = 'primary', size = 'sm', type = 'button' }) {
  const tones = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    danger:  'bg-red-600 text-white hover:bg-red-700',
    ghost:   'bg-gray-100 text-gray-700 hover:bg-gray-200',
  }
  const sizes = {
    sm: 'px-3 py-1 text-xs',
    md: 'px-4 py-2 text-sm',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tones[tone]} ${sizes[size]}`}
    >
      {children}
    </button>
  )
}

export function Table({ columns, rows, empty = 'No data', rowKey }) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-gray-500 italic">{empty}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            {columns.map(c => (
              <th key={c.key} className="px-3 py-2 font-semibold">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r) : i} className="hover:bg-gray-50">
              {columns.map(c => (
                <td key={c.key} className="px-3 py-2 align-top">
                  {c.render ? c.render(r) : r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function formatDateTime(s) {
  return sharedFormatDateTime(s)
}

export function formatRelative(s) {
  return sharedFormatRelative(s)
}
