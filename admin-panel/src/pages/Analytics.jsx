import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

function SectionTitle({ children }) {
  return <h2 className="text-lg font-semibold text-gray-700 mb-3">{children}</h2>
}

function TableWrapper({ children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 mb-8">
      <table className="min-w-full divide-y divide-gray-200 text-sm">{children}</table>
    </div>
  )
}

function Th({ children }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50">
      {children}
    </th>
  )
}

function Td({ children }) {
  return <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{children}</td>
}

export default function Analytics() {
  const [todayClicks, setTodayClicks] = useState(null)
  const [topSources, setTopSources] = useState([])
  const [topArticles, setTopArticles] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        // A. Total clicks today
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const { count, error: e1 } = await supabase
          .from('article_clicks')
          .select('id', { count: 'exact', head: true })
          .gte('clicked_at', startOfDay.toISOString())
        if (e1) throw e1
        setTodayClicks(count)

        // B. Top Sources — use pre-aggregated view, then enrich with source names
        const { data: sourceCounts, error: e2 } = await supabase
          .from('source_click_counts')
          .select('source_id, click_count')
          .order('click_count', { ascending: false })
          .limit(20)
        if (e2) throw e2

        const sourceIds = (sourceCounts ?? []).map((r) => r.source_id)
        if (sourceIds.length > 0) {
          const { data: sourceRows, error: e3 } = await supabase
            .from('sources')
            .select('id, name')
            .in('id', sourceIds)
          if (e3) throw e3

          const nameMap = Object.fromEntries((sourceRows ?? []).map((s) => [s.id, s.name]))
          const enriched = (sourceCounts ?? []).map((r) => ({
            name: nameMap[r.source_id] ?? 'Unknown',
            clicks: r.click_count,
          }))
          setTopSources(enriched)
        }

        // C. Top Articles — use pre-aggregated all-time view, then enrich with article + source data
        const { data: articleCounts, error: e4 } = await supabase
          .from('article_click_counts_alltime')
          .select('article_id, click_count')
          .order('click_count', { ascending: false })
          .limit(20)
        if (e4) throw e4

        const articleIds = (articleCounts ?? []).map((r) => r.article_id)
        if (articleIds.length > 0) {
          const { data: articleRows, error: e5 } = await supabase
            .from('articles')
            .select('id, title, sources ( name )')
            .in('id', articleIds)
          if (e5) throw e5

          const countMap = Object.fromEntries(
            (articleCounts ?? []).map((r) => [r.article_id, r.click_count])
          )
          const enrichedArticles = (articleRows ?? [])
            .map((a) => ({
              title: a.title,
              source: a.sources?.name ?? 'Unknown',
              clicks: countMap[a.id] ?? 0,
            }))
            .sort((a, b) => b.clicks - a.clicks)
          setTopArticles(enrichedArticles)
        }
      } catch (err) {
        setError(err?.message ?? 'Failed to load analytics')
      }
    }

    load()
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Analytics</h1>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {/* Total clicks today */}
      <div className="mb-8">
        <div className="inline-block bg-indigo-50 border border-indigo-200 rounded-2xl px-8 py-6">
          <p className="text-sm font-medium text-indigo-600 opacity-80">Total Clicks Today</p>
          <p className="text-4xl font-bold text-indigo-700 mt-1">{todayClicks ?? '—'}</p>
        </div>
      </div>

      {/* Top Sources */}
      <SectionTitle>Top Sources (by clicks)</SectionTitle>
      {topSources.length === 0 ? (
        <p className="text-sm text-gray-400 mb-8">No click data yet.</p>
      ) : (
        <TableWrapper>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Source Name</Th>
              <Th>Total Clicks</Th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {topSources.map((row, i) => (
              <tr key={row.name} className="hover:bg-gray-50 transition-colors">
                <Td>{i + 1}</Td>
                <Td>{row.name}</Td>
                <Td>{row.clicks.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrapper>
      )}

      {/* Top Articles */}
      <SectionTitle>Top Articles (by clicks)</SectionTitle>
      {topArticles.length === 0 ? (
        <p className="text-sm text-gray-400 mb-8">No click data yet.</p>
      ) : (
        <TableWrapper>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Article Title</Th>
              <Th>Source</Th>
              <Th>Clicks</Th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {topArticles.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50 transition-colors">
                <Td>{i + 1}</Td>
                <Td>
                  <span className="block max-w-xs truncate" title={row.title}>
                    {row.title}
                  </span>
                </Td>
                <Td>{row.source}</Td>
                <Td>{row.clicks.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrapper>
      )}
    </div>
  )
}
