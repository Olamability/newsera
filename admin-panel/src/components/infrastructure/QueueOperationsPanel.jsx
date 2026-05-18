import { useEffect, useState } from 'react'
import {
  fetchQueueHealth, fetchDeadLetterSummary, fetchDeadLetterRows, fetchRecentJobs,
  replayDeadLetter, replayDeadLetterBulk, retryFailedJobs, clearCompletedJobs,
} from '../../services/infrastructure'
import { Panel, StatGrid, Stat, Banner, Badge, Table, Button, formatRelative, formatDateTime } from './UI'

function PayloadModal({ row, onClose }) {
  if (!row) return null
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-3xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-2">Job payload</h3>
        <p className="text-xs text-gray-500 mb-3 font-mono break-all">{row.id}</p>
        <pre className="bg-gray-900 text-green-200 text-xs p-4 rounded-lg overflow-auto">
{JSON.stringify(row.payload ?? row, null, 2)}
        </pre>
        {row.last_error && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-red-700 mb-1">Last error</p>
            <pre className="bg-red-50 border border-red-200 text-red-800 text-xs p-3 rounded-lg whitespace-pre-wrap">{row.last_error}</pre>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button tone="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}

export default function QueueOperationsPanel() {
  const [health, setHealth] = useState([])
  const [dlqSummary, setDlqSummary] = useState([])
  const [selectedQueue, setSelectedQueue] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [jobs, setJobs] = useState([])
  const [dlq, setDlq] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState(null)

  async function load() {
    setBusy(true); setError('')
    try {
      const [h, d, j, dl] = await Promise.all([
        fetchQueueHealth(),
        fetchDeadLetterSummary(),
        fetchRecentJobs({ queue: selectedQueue || undefined, status: statusFilter || undefined, limit: 25 }),
        fetchDeadLetterRows({ queue: selectedQueue || undefined, limit: 25 }),
      ])
      setHealth(h ?? [])
      setDlqSummary(d ?? [])
      setJobs(j ?? [])
      setDlq(dl ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [selectedQueue, statusFilter])

  async function withConfirm(label, fn) {
    if (!window.confirm(label)) return
    try {
      setBusy(true); setError('')
      const reason = window.prompt('Audit reason (optional):') || null
      const result = await fn(reason)
      window.alert(`Done. Result: ${JSON.stringify(result)}`)
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Panel
        title="Queue operations"
        subtitle="job_queue + job_dead_letter — pending / leased / failed / completed, throughput, latency"
        action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
      >
        {error && <Banner tone="bad" title="Error">{error}</Banner>}

        <div className="space-y-4">
          {health.map(q => {
            const failing = (q.dead_count ?? 0) + (q.failed_count ?? 0)
            const tone = failing > 0 ? 'warn' : 'good'
            return (
              <div key={q.queue_name} className="border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-800 capitalize">{q.queue_name}</h3>
                    <Badge tone={tone}>{failing > 0 ? `${failing} failing` : 'healthy'}</Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button tone="ghost" onClick={() => withConfirm(`Replay up to 50 unreplayed DLQ jobs in '${q.queue_name}'?`,
                      r => replayDeadLetterBulk(q.queue_name, 50, r))}>Replay DLQ (50)</Button>
                    <Button tone="ghost" onClick={() => withConfirm(`Retry up to 100 failed jobs in '${q.queue_name}'?`,
                      r => retryFailedJobs(q.queue_name, 100, r))}>Retry failed (100)</Button>
                    <Button tone="ghost" onClick={() => withConfirm(`Delete completed jobs older than 24h in '${q.queue_name}'?`,
                      r => clearCompletedJobs(q.queue_name, 24, r))}>Clear completed</Button>
                  </div>
                </div>
                <StatGrid>
                  <Stat label="Pending" value={q.queued_count} tone={q.queued_count > 100 ? 'warn' : 'neutral'} />
                  <Stat label="Leased" value={q.leased_count} />
                  <Stat label="Running" value={q.running_count} />
                  <Stat label="Success" value={q.success_count} tone="good" />
                  <Stat label="Failed" value={q.failed_count} tone={q.failed_count > 0 ? 'warn' : 'good'} />
                  <Stat label="Dead-letter" value={q.dead_count} tone={q.dead_count > 0 ? 'bad' : 'good'} />
                  <Stat label="Retries" value={q.retry_count} />
                  <Stat label="Oldest pending" value={q.oldest_pending_seconds ? `${q.oldest_pending_seconds}s` : '—'} tone={q.oldest_pending_seconds > 600 ? 'warn' : 'neutral'} />
                  <Stat label="Avg latency" value={q.avg_lease_seconds ? `${q.avg_lease_seconds}s` : '—'} />
                  <Stat label="Throughput 1h" value={q.throughput_1h} />
                  <Stat label="Throughput 24h" value={q.throughput_24h} />
                  <Stat label="Failure rate 1h" value={`${Math.round((q.failure_rate_1h ?? 0) * 1000) / 10}%`} tone={(q.failure_rate_1h ?? 0) > 0.1 ? 'bad' : 'good'} />
                </StatGrid>
              </div>
            )
          })}
        </div>
      </Panel>

      <Panel title="Dead-letter summary" subtitle="Per-queue DLQ depth and oldest failure">
        <Table
          rowKey={r => r.queue_name}
          columns={[
            { key: 'queue_name', header: 'Queue' },
            { key: 'total_count', header: 'Total' },
            { key: 'unreplayed_count', header: 'Unreplayed', render: r =>
              r.unreplayed_count > 0 ? <span className="font-semibold text-red-700">{r.unreplayed_count}</span> : r.unreplayed_count
            },
            { key: 'replayed_count', header: 'Replayed' },
            { key: 'oldest_failed_at', header: 'Oldest', render: r => formatRelative(r.oldest_failed_at) },
            { key: 'most_recent_failed_at', header: 'Most recent', render: r => formatRelative(r.most_recent_failed_at) },
          ]}
          rows={dlqSummary}
          empty="No dead-letter entries."
        />
      </Panel>

      <Panel
        title="Job inspector"
        subtitle="Recent jobs & dead-letter entries with payload drill-down"
        action={
          <div className="flex gap-2">
            <select value={selectedQueue} onChange={e => setSelectedQueue(e.target.value)} className="text-sm border-gray-300 rounded-lg">
              <option value="">All queues</option>
              <option value="ingestion">ingestion</option>
              <option value="notification">notification</option>
              <option value="ranking">ranking</option>
              <option value="analytics">analytics</option>
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="text-sm border-gray-300 rounded-lg">
              <option value="">All statuses</option>
              <option value="queued">queued</option>
              <option value="leased">leased</option>
              <option value="running">running</option>
              <option value="success">success</option>
              <option value="failed">failed</option>
              <option value="dead">dead</option>
            </select>
          </div>
        }
      >
        <h4 className="font-semibold text-sm text-gray-700 mb-2">Recent jobs</h4>
        <Table
          rowKey={r => r.id}
          columns={[
            { key: 'queue_name', header: 'Queue' },
            { key: 'job_type', header: 'Type', render: r => <span className="font-mono text-xs">{r.job_type}</span> },
            { key: 'status', header: 'Status', render: r => {
              const t = r.status === 'success' ? 'ok'
                : r.status === 'dead' || r.status === 'failed' ? 'bad'
                : r.status === 'leased' || r.status === 'running' ? 'info' : 'warn'
              return <Badge tone={t}>{r.status}</Badge>
            }},
            { key: 'attempts', header: 'Attempts', render: r => `${r.attempts}/${r.max_attempts}` },
            { key: 'leased_by', header: 'Leased by', render: r => r.leased_by || '—' },
            { key: 'created_at', header: 'Created', render: r => formatRelative(r.created_at) },
            { key: 'actions', header: '', render: r => <Button tone="ghost" onClick={() => setInspect(r)}>Inspect</Button> },
          ]}
          rows={jobs}
          empty="No matching jobs."
        />

        <h4 className="font-semibold text-sm text-gray-700 mt-6 mb-2">Dead-letter queue</h4>
        <Table
          rowKey={r => r.id}
          columns={[
            { key: 'queue_name', header: 'Queue' },
            { key: 'job_type', header: 'Type', render: r => <span className="font-mono text-xs">{r.job_type}</span> },
            { key: 'attempts', header: 'Attempts' },
            { key: 'failed_at', header: 'Failed', render: r => (
              <span title={formatDateTime(r.failed_at)}>{formatRelative(r.failed_at)}</span>
            )},
            { key: 'replayed_at', header: 'Replayed', render: r =>
              r.replayed_at ? <Badge tone="ok">replayed</Badge> : <Badge tone="warn">pending</Badge>
            },
            { key: 'actions', header: '', render: r => (
              <div className="flex gap-2">
                <Button tone="ghost" onClick={() => setInspect(r)}>Inspect</Button>
                <Button
                  tone="primary"
                  disabled={!!r.replayed_at}
                  onClick={() => withConfirm(`Replay dead-letter ${r.id}?`, reason => replayDeadLetter(r.id, reason))}
                >Replay</Button>
              </div>
            )},
          ]}
          rows={dlq}
          empty="No dead-letter entries."
        />
      </Panel>

      <PayloadModal row={inspect} onClose={() => setInspect(null)} />
    </>
  )
}
