import { useEffect, useState } from 'react'
import { fetchRankingHealth } from '../../services/infrastructure'
import { Panel, Banner, Badge, Table, Button, formatRelative } from './UI'

export default function RankingHealthPanel() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true); setError('')
    try {
      setRows(await fetchRankingHealth() ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  const anyStale = rows.some(r => r.is_stale)
  const anyEmpty = rows.some(r => (r.row_count ?? 0) === 0)

  return (
    <Panel
      title="Ranking pipeline validation"
      subtitle="ranked_feed_global / category / personalized / breaking — row counts, freshness"
      action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Error">{error}</Banner>}
      {anyEmpty && (
        <Banner tone="warn" title="One or more ranking surfaces are empty">
          Run <code>refresh_ranked_feeds()</code> (also invoked by the <code>refresh_ranked_feeds_5m</code> cron job) before enabling <code>ranking_v1</code> or <code>breaking_feed_v1</code>.
        </Banner>
      )}
      {anyStale && (
        <Banner tone="warn" title="Stale ranking views detected">
          Some materialized views have not been refreshed recently. Check Cron Health for the relevant scheduled job.
        </Banner>
      )}

      <Table
        rowKey={r => r.view_name}
        columns={[
          { key: 'view_name', header: 'View', render: r => <span className="font-mono text-xs">{r.view_name}</span> },
          { key: 'row_count', header: 'Rows', render: r =>
            (r.row_count ?? 0) === 0
              ? <Badge tone="bad">empty</Badge>
              : r.row_count.toLocaleString()
          },
          { key: 'last_refresh_at', header: 'Latest data', render: r =>
            r.last_refresh_at ? formatRelative(r.last_refresh_at) : <span className="text-gray-400">—</span>
          },
          { key: 'age_seconds', header: 'Age', render: r =>
            r.age_seconds != null ? `${r.age_seconds}s` : '—'
          },
          { key: 'is_stale', header: 'Status', render: r =>
            r.is_stale ? <Badge tone="warn">stale</Badge> : <Badge tone="ok">fresh</Badge>
          },
        ]}
        rows={rows}
        empty="No ranking surfaces reported."
      />

      <div className="mt-4 text-xs text-gray-600 space-y-1">
        <p><strong>Refresh strategy:</strong> <code>refresh_ranked_feeds_5m</code> drives <code>ranked_feed_global</code> + <code>ranked_feed_category</code>. <code>refresh_active_personalized_15m</code> drives <code>ranked_feed_personalized</code> for users active in the last 24h. <code>ranked_feed_breaking</code> is a plain view recomputed on every read.</p>
        <p><strong>Source diversity / freshness decay:</strong> implemented inline in the <code>ranked_feed_global</code> materialized view (12h half-life, reliability-weighted; see migration 043).</p>
        <p><strong>Breaking velocity:</strong> derived from <code>articles_engagement_feed</code> click velocity inside <code>ranked_feed_breaking</code>.</p>
      </div>
    </Panel>
  )
}
