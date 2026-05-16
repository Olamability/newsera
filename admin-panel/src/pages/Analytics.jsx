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
  const [topCategories, setTopCategories] = useState([])
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

        // B. Top Categories by article volume
        const { data: categoryRows, error: e2 } = await supabase
          .from('articles')
          .select('category_id')
        if (e2) throw e2

        const groupedMap = (categoryRows ?? []).reduce((acc, row) => {
          const key = row.category_id ?? 'uncategorized'
          acc.set(key, (acc.get(key) ?? 0) + 1)
          return acc
        }, new Map())
        const grouped = Object.fromEntries(groupedMap.entries())
        const categoryIds = Object.keys(grouped).filter((id) => id !== 'uncategorized')
        const { data: categories, error: e3 } = categoryIds.length > 0
          ? await supabase.from('categories').select('id, name').in('id', categoryIds)
          : { data: [], error: null }
        if (e3) throw e3
        const categoryNameById = Object.fromEntries((categories ?? []).map((c) => [c.id, c.name]))
        const rankedCategories = Object.entries(grouped)
          .map(([id, count]) => ({
            name: id === 'uncategorized' ? 'Uncategorized' : (categoryNameById[id] ?? 'Unknown category'),
            count,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
        setTopCategories(rankedCategories)

        // C. Top Articles — use pre-aggregated all-time click view then enrich with article titles
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
            .select('id, title')
            .in('id', articleIds)
          if (e5) throw e5

          const countMap = Object.fromEntries(
            (articleCounts ?? []).map((r) => [r.article_id, r.click_count])
          )
          const enrichedArticles = (articleRows ?? [])
            .map((a) => ({
              title: a.title,
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

      {/* Top Categories */}
      <SectionTitle>Top Categories (by article volume)</SectionTitle>
      {topCategories.length === 0 ? (
        <p className="text-sm text-gray-400 mb-8">No category data yet.</p>
      ) : (
        <TableWrapper>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Category</Th>
              <Th>Article Count</Th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {topCategories.map((row, i) => (
              <tr key={row.name} className="hover:bg-gray-50 transition-colors">
                <Td>{i + 1}</Td>
                <Td>{row.name}</Td>
                <Td>{row.count.toLocaleString()}</Td>
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
                <Td>{row.clicks.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrapper>
      )}
    </div>
  )
}
