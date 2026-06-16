import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

function SectionTitle({ children }) {
  return <h2 className="text-base sm:text-lg font-semibold text-gray-700 mb-3">{children}</h2>
}

function TableWrapper({ children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 mb-8">
      <table className="min-w-full divide-y divide-gray-200 text-xs sm:text-sm">{children}</table>
    </div>
  )
}

function Th({ children }) {
  return (
    <th className="px-3 sm:px-4 py-2 sm:py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50">
      {children}
    </th>
  )
}

function Td({ children }) {
  return <td className="px-3 sm:px-4 py-2 sm:py-3 text-gray-700 whitespace-nowrap">{children}</td>
}

export default function PublisherTraffic() {
  const [summary, setSummary] = useState([])
  const [totalToday, setTotalToday] = useState(0)
  const [totalThisMonth, setTotalThisMonth] = useState(0)
  const [totalAllTime, setTotalAllTime] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        // Fetch publisher_traffic_summary view
        const { data, error: e1 } = await supabase
          .from('publisher_traffic_summary')
          .select('*')
          .order('clicks_this_month', { ascending: false })
        
        if (e1) throw e1
        setSummary(data ?? [])

        // Calculate totals
        const today = (data ?? []).reduce((sum, row) => sum + (row.clicks_today ?? 0), 0)
        const thisMonth = (data ?? []).reduce((sum, row) => sum + (row.clicks_this_month ?? 0), 0)
        const allTime = (data ?? []).reduce((sum, row) => sum + (row.total_outbound_clicks ?? 0), 0)

        setTotalToday(today)
        setTotalThisMonth(thisMonth)
        setTotalAllTime(allTime)
      } catch (err) {
        setError(err?.message ?? 'Failed to load publisher traffic data')
      }
    }

    load()
  }, [])

  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2">Publisher Traffic Distribution</h1>
      <p className="text-sm text-gray-600 mb-6">Track outbound clicks sent to publisher websites (UTM-tagged traffic)</p>

      {error && (
        <p className="text-xs sm:text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-green-50 border border-green-200 rounded-xl px-6 py-4">
          <p className="text-xs font-medium text-green-600 opacity-80">Today</p>
          <p className="text-3xl font-bold text-green-700 mt-1">{totalToday.toLocaleString()}</p>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-6 py-4">
          <p className="text-xs font-medium text-blue-600 opacity-80">This Month</p>
          <p className="text-3xl font-bold text-blue-700 mt-1">{totalThisMonth.toLocaleString()}</p>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-6 py-4">
          <p className="text-xs font-medium text-purple-600 opacity-80">All Time</p>
          <p className="text-3xl font-bold text-purple-700 mt-1">{totalAllTime.toLocaleString()}</p>
        </div>
      </div>

      {/* Publisher Traffic Table */}
      <SectionTitle>Traffic by Publisher</SectionTitle>
      {summary.length === 0 ? (
        <p className="text-xs sm:text-sm text-gray-400 mb-8">No outbound traffic yet.</p>
      ) : (
        <TableWrapper>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Publisher</Th>
              <Th>Website</Th>
              <Th>Today</Th>
              <Th>This Month</Th>
              <Th>All Time</Th>
              <Th>Unique Devices</Th>
              <Th>Last Click</Th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {summary.map((row, i) => (
              <tr key={row.source_id} className="hover:bg-gray-50 transition-colors">
                <Td>{i + 1}</Td>
                <Td>
                  <span className="font-semibold">{row.source_name ?? 'Unknown'}</span>
                </Td>
                <Td>
                  {row.source_website ? (
                    <a
                      href={row.source_website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-xs"
                    >
                      {new URL(row.source_website).hostname}
                    </a>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>{(row.clicks_today ?? 0).toLocaleString()}</Td>
                <Td className="font-semibold">{(row.clicks_this_month ?? 0).toLocaleString()}</Td>
                <Td>{(row.total_outbound_clicks ?? 0).toLocaleString()}</Td>
                <Td>{(row.unique_devices ?? 0).toLocaleString()}</Td>
                <Td className="text-xs text-gray-500">
                  {row.last_click_at ? new Date(row.last_click_at).toLocaleDateString() : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrapper>
      )}

      {/* UTM Info Box */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-6 mt-8">
        <h3 className="font-semibold text-indigo-900 mb-2">📊 Google Analytics Tracking</h3>
        <p className="text-sm text-indigo-800 mb-3">
          All outbound URLs are tagged with UTM parameters so publishers can track NewsEra traffic in their GA4:
        </p>
        <div className="bg-white rounded-lg p-4 font-mono text-xs text-gray-700 space-y-1">
          <div><span className="text-indigo-600">utm_source</span> = newsera</div>
          <div><span className="text-indigo-600">utm_medium</span> = aggregator</div>
          <div><span className="text-indigo-600">utm_campaign</span> = feed</div>
        </div>
        <p className="text-xs text-indigo-700 mt-3">
          Publishers can see NewsEra traffic in <strong>GA4 → Acquisition → Traffic Acquisition</strong>
        </p>
      </div>
    </div>
  )
}
