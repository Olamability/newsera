import { useEffect, useState } from 'react'
import {
  fetchCronStatus, fetchCronJobHealth, fetchMissingCronJobs,
} from '../../services/infrastructure'
import { Panel, StatGrid, Stat, Banner, Badge, Table, Button, formatRelative, formatDateTime } from './UI'

export default function CronHealthPanel() {
  const [status, setStatus] = useState(null)
  const [jobs, setJobs] = useState([])
  const [missing, setMissing] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const [s, j, m] = await Promise.all([
        fetchCronStatus(), fetchCronJobHealth(), fetchMissingCronJobs(),
      ])
      setStatus(Array.isArray(s) ? s[0] : s)
      setJobs(j ?? [])
      setMissing((m ?? []).map(r => r.jobname))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const failingJobs = jobs.filter(j => (j.failures_24h ?? 0) > 0)
  const staleJobs = jobs.filter(j => {
    if (!j.last_run) return false
    return Date.now() - new Date(j.last_run).getTime() > 6 * 3600 * 1000
  })

  return (
    <Panel
      title="Cron health"
      subtitle="pg_cron schedule, recent runs, failure rollups, drift detector"
      action={<Button tone="ghost" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>}
    >
      {error && <Banner tone="bad" title="Failed to load cron health">{error}</Banner>}
      {status && !status.pg_cron_installed && (
        <Banner tone="bad" title="pg_cron is not installed">
          The cron extension is not available on this database. Scheduled jobs (queue reaper, ranking refresh, retention sweeps) will not run. All retention / scheduling claims must be treated as <strong>blocked</strong>.
        </Banner>
      )}
      {status?.pg_cron_installed && missing.length > 0 && (
        <Banner tone="warn" title={`Missing ${missing.length} expected schedule(s)`}>
          {missing.join(', ')}
        </Banner>
      )}
      {failingJobs.length > 0 && (
        <Banner tone="warn" title={`${failingJobs.length} job(s) reported failures in the last 24h`}>
          {failingJobs.map(j => j.jobname).join(', ')}
        </Banner>
      )}
      {staleJobs.length > 0 && (
        <Banner tone="warn" title={`${staleJobs.length} job(s) have stale execution windows (>6h since last run)`}>
          {staleJobs.map(j => j.jobname).join(', ')}
        </Banner>
      )}

      <StatGrid>
        <Stat label="pg_cron installed" value={status?.pg_cron_installed ? 'yes' : 'no'} tone={status?.pg_cron_installed ? 'good' : 'bad'} />
        <Stat label="cron schema" value={status?.cron_schema_present ? 'present' : 'missing'} tone={status?.cron_schema_present ? 'good' : 'bad'} />
        <Stat label="scheduled jobs" value={status?.scheduled_job_count ?? 0} />
        <Stat label="missing expected" value={missing.length} tone={missing.length === 0 ? 'good' : 'warn'} />
        <Stat label="failing 24h" value={failingJobs.length} tone={failingJobs.length === 0 ? 'good' : 'warn'} />
      </StatGrid>

      <div className="mt-6">
        <Table
          rowKey={r => r.jobid}
          columns={[
            { key: 'jobname', header: 'Job', render: r => (
              <div>
                <div className="font-mono text-xs">{r.jobname}</div>
                <div className="text-[11px] text-gray-500">{r.schedule}</div>
              </div>
            )},
            { key: 'is_expected', header: 'Expected', render: r =>
              r.is_expected ? <Badge tone="ok">expected</Badge> : <Badge tone="warn">unexpected</Badge>
            },
            { key: 'active', header: 'Active', render: r =>
              r.active ? <Badge tone="ok">active</Badge> : <Badge tone="off">paused</Badge>
            },
            { key: 'last_status', header: 'Last status', render: r => {
              const s = r.last_status
              if (!s) return <Badge tone="off">never run</Badge>
              if (s === 'succeeded') return <Badge tone="ok">{s}</Badge>
              return <Badge tone="bad">{s}</Badge>
            }},
            { key: 'last_run', header: 'Last run', render: r => (
              <span title={formatDateTime(r.last_run)}>{formatRelative(r.last_run)}</span>
            )},
            { key: 'last_duration_ms', header: 'Duration', render: r =>
              r.last_duration_ms != null ? `${r.last_duration_ms} ms` : '—'
            },
            { key: 'runs_24h', header: 'Runs 24h' },
            { key: 'failures_24h', header: 'Failures 24h', render: r =>
              (r.failures_24h ?? 0) > 0 ? <span className="text-red-700 font-semibold">{r.failures_24h}</span> : r.failures_24h
            },
          ]}
          rows={jobs}
          empty={status?.pg_cron_installed ? 'No cron jobs registered yet.' : 'pg_cron unavailable.'}
        />
      </div>
    </Panel>
  )
}
