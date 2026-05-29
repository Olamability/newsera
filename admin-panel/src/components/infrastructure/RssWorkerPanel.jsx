import { useEffect, useState } from 'react'
import {
  fetchRssWorkerHealth, fetchRssFeedHealth,
  forceReleaseFeedLease, setFeedActive, retryFeed,
} from '../../services/infrastructure'
import { Panel, StatGrid, Stat, Banner, Badge, Table, Button, formatRelative, formatDateTime } from './UI'

export default function RssWorkerPanel() {
  const [workers, setWorkers] = useState([])
  const [feeds, setFeeds] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')

  async function load() {
    setBusy(true); setError('')
    try {
      const [w, f] = await Promise.all([fetchRssWorkerHealth(), fetchRssFeedHealth(200)])
      setWorkers(w ?? [])
      setFeeds(f ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  async function withConfirm(label, fn) {
    if (!window.confirm(label)) return
    try {
      setBusy(true); setError('')
      const reason = window.prompt('Audit reason (optional):') || null
      await fn(reason)
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const filtered = feeds.filter(f => {
    if (filter === 'all') return true
    if (filter === 'failing') return (f.consecutive_failures ?? 0) >= 3
    if (filter === 'stale_lease') return !!f.lease_is_stale
    if (filter === 'inactive') return !f.is_active
    return true
  })

  const totalAlive = workers.reduce((s, w) => s + (w.alive_count ?? 0), 0)
  const totalCrashed = workers.reduce((s, w) => s + (w.crashed_count ?? 0), 0)
  const totalStale = workers.reduce((s, w) => s + (w.stale_count ?? 0), 0)
  const failingFeeds = feeds.filter(f => (f.consecutive_failures ?? 0) >= 5).length
  const staleLeases = feeds.filter(f => f.lease_is_stale).length

  return (
    <>
      <Panel
        title="RSS workers"
        subtitle="worker_heartbeats + ingestion_jobs — lease state, crashes, stale workers"
        action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
      >
        {error && <Banner tone="bad" title="Error">{error}</Banner>}
        {totalAlive === 0 && (
          <Banner tone="bad" title="No live worker heartbeats">
            No worker has heartbeat-ed in the last 5 minutes. RSS ingestion is effectively stopped — do not enable the <code>queue_based_ingestion</code> flag until workers are healthy.
          </Banner>
        )}
        {totalCrashed > 0 && (
          <Banner tone="warn" title={`${totalCrashed} crashed worker(s)`}>
            Marked crashed by <code>mark_stale_workers_crashed</code>. Investigate process logs.
          </Banner>
        )}
        {totalStale > 0 && (
          <Banner tone="warn" title={`${totalStale} alive worker(s) with stale heartbeat`}>
            Workers reporting 'alive' but no heartbeat in 5m. Likely network/cron lag or a paused process.
          </Banner>
        )}
        {staleLeases > 0 && (
          <Banner tone="warn" title={`${staleLeases} feed(s) with stale ingestion lease`}>
            Lease deadlocks block re-leasing. Use <strong>Force release</strong> on individual rows below.
          </Banner>
        )}

        <StatGrid>
          <Stat label="Alive workers" value={totalAlive} tone={totalAlive > 0 ? 'good' : 'bad'} />
          <Stat label="Stale" value={totalStale} tone={totalStale > 0 ? 'warn' : 'good'} />
          <Stat label="Crashed" value={totalCrashed} tone={totalCrashed > 0 ? 'bad' : 'good'} />
          <Stat label="Total feeds" value={feeds.length} />
          <Stat label="Failing feeds (≥5)" value={failingFeeds} tone={failingFeeds === 0 ? 'good' : 'warn'} />
        </StatGrid>

        <div className="mt-6">
          <h4 className="font-semibold text-sm text-gray-700 mb-2">Workers by type</h4>
          <Table
            rowKey={r => r.worker_type}
            columns={[
              { key: 'worker_type', header: 'Worker type' },
              { key: 'alive_count', header: 'Alive', render: r =>
                r.alive_count > 0 ? <Badge tone="ok">{r.alive_count}</Badge> : <Badge tone="bad">0</Badge>
              },
              { key: 'stale_count', header: 'Stale', render: r =>
                r.stale_count > 0 ? <Badge tone="warn">{r.stale_count}</Badge> : r.stale_count
              },
              { key: 'crashed_count', header: 'Crashed', render: r =>
                r.crashed_count > 0 ? <Badge tone="bad">{r.crashed_count}</Badge> : r.crashed_count
              },
              { key: 'draining_count', header: 'Draining' },
              { key: 'stopped_count', header: 'Stopped' },
              { key: 'most_recent_heartbeat_at', header: 'Last heartbeat', render: r =>
                <span title={formatDateTime(r.most_recent_heartbeat_at)}>{formatRelative(r.most_recent_heartbeat_at)}</span>
              },
            ]}
            rows={workers}
            empty="No workers have registered heartbeats yet."
          />
        </div>
      </Panel>

      <Panel
        title="RSS feed health"
        subtitle="Reliability score, backoff, lease ownership"
        action={
          <select value={filter} onChange={e => setFilter(e.target.value)} className="text-sm border-gray-300 rounded-lg">
            <option value="all">All feeds</option>
            <option value="failing">Failing (≥3 streak)</option>
            <option value="stale_lease">Stale lease</option>
            <option value="inactive">Inactive</option>
          </select>
        }
      >
        <Table
          rowKey={r => r.feed_id}
          columns={[
            { key: 'name', header: 'Feed', render: r => (
              <div>
                <div className="font-medium">{r.name}</div>
                <div className="text-[11px] text-gray-500 truncate max-w-xs" title={r.url}>{r.url}</div>
              </div>
            )},
            { key: 'is_active', header: 'Status', render: r =>
              r.is_active ? <Badge tone="ok">active</Badge> : <Badge tone="off">paused</Badge>
            },
            { key: 'reliability_score', header: 'Reliability', render: r => {
              const s = Number(r.reliability_score ?? 0)
              const t = s >= 0.8 ? 'ok' : s >= 0.5 ? 'warn' : 'bad'
              return <Badge tone={t}>{(s * 100).toFixed(1)}%</Badge>
            }},
            { key: 'failure_streak', header: 'Failures', render: r =>
              (r.failure_streak ?? 0) >= 3
                ? <span className="font-semibold text-red-700">{r.failure_streak}</span>
                : r.failure_streak
            },
            { key: 'backoff_seconds', header: 'Backoff', render: r => r.backoff_seconds ? `${r.backoff_seconds}s` : '—' },
            { key: 'lease_owner', header: 'Lease', render: r => {
              if (!r.lease_owner) return <span className="text-gray-400">—</span>
              return (
                <div>
                  <div className="font-mono text-xs">{r.lease_owner}</div>
                  <div className="text-[11px] text-gray-500">
                    until {formatRelative(r.leased_until)} {r.lease_is_stale && <Badge tone="bad">stale</Badge>}
                  </div>
                </div>
              )
            }},
            { key: 'next_fetch_at', header: 'Next fetch', render: r => formatRelative(r.next_fetch_at) },
            { key: 'actions', header: '', render: r => (
              <div className="flex gap-1 flex-wrap">
                <Button tone="ghost" onClick={() => withConfirm(`Manually retry feed '${r.name}' now?`,
                  reason => retryFeed(r.feed_id, reason))}>Retry</Button>
                <Button tone="ghost" onClick={() => withConfirm(`${r.is_active ? 'Pause' : 'Resume'} feed '${r.name}'?`,
                  reason => setFeedActive(r.feed_id, !r.is_active, reason))}>
                  {r.is_active ? 'Pause' : 'Resume'}
                </Button>
                {r.lease_owner && (
                  <Button tone="danger" onClick={() => withConfirm(`Force-release lease on '${r.name}'? This clears the lease so another worker can pick it up.`,
                    reason => forceReleaseFeedLease(r.feed_id, reason))}>Force release</Button>
                )}
              </div>
            )},
          ]}
          rows={filtered}
          empty="No feeds match the current filter."
        />
      </Panel>
    </>
  )
}
