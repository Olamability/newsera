import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'

function StatCard({ label, value, color }) {
  const colorMap = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
    green: 'bg-green-50 border-green-200 text-green-700',
  }
  return (
    <div className={`border rounded-2xl p-6 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{label}</p>
      <p className="text-4xl font-bold mt-1">{value ?? '—'}</p>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState({ total: null, pending: null, active: null })
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchStats() {
      const [totalRes, pendingRes, activeRes] = await Promise.all([
        supabase.from('sources').select('id', { count: 'exact', head: true }),
        supabase.from('sources').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('sources').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      ])

      const err = totalRes.error || pendingRes.error || activeRes.error
      if (err) {
        setError(err.message)
        return
      }

      setStats({
        total: totalRes.count,
        pending: pendingRes.count,
        active: activeRes.count,
      })
    }
    fetchStats()
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Dashboard</h1>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <StatCard label="Total Sources" value={stats.total} color="blue" />
        <StatCard label="Pending Sources" value={stats.pending} color="yellow" />
        <StatCard label="Active Sources" value={stats.active} color="green" />
      </div>
    </div>
  )
}
