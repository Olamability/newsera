import { useEffect, useState } from 'react'
import {
  fetchNotificationHealth, fetchRecentFailedDeliveries, sendTestNotification,
} from '../../services/infrastructure'
import { Panel, StatGrid, Stat, Banner, Badge, Table, Button, formatRelative } from './UI'

export default function NotificationHealthPanel() {
  const [health, setHealth] = useState(null)
  const [failures, setFailures] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [testUserId, setTestUserId] = useState('')
  const [testTitle, setTestTitle] = useState('NewsEra test notification')
  const [testBody, setTestBody] = useState('If you can see this in your inbox, the notification pipeline is healthy.')

  async function load() {
    setBusy(true); setError('')
    try {
      const [h, f] = await Promise.all([
        fetchNotificationHealth(),
        fetchRecentFailedDeliveries(50),
      ])
      setHealth(Array.isArray(h) ? h[0] : h)
      setFailures(f ?? [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  async function handleSendTest() {
    if (!testUserId || !/^[0-9a-f-]{36}$/i.test(testUserId)) {
      window.alert('Enter a valid user UUID first.')
      return
    }
    if (!window.confirm(`Send test notification to user ${testUserId}?`)) return
    setBusy(true); setError('')
    try {
      const id = await sendTestNotification(testUserId, testTitle, testBody)
      window.alert(`Test notification event queued: ${id}`)
      await load()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const h = health || {}
  const tokenCoverage = h.total_devices > 0 ? (h.devices_with_token / h.total_devices) : 0
  const tokensOk = h.devices_with_token > 0 && tokenCoverage >= 0.5

  return (
    <>
      <Panel
        title="Notification pipeline validation"
        subtitle="user_devices integrity, dedup, rate limits, delivery retries"
        action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
      >
        {error && <Banner tone="bad" title="Error">{error}</Banner>}
        <Banner tone="warn" title="Do NOT enable backend_notification_dispatch until validations pass">
          The dispatch flag must remain feature-flag gated until token coverage, dedup, and retry logic are verified below.
        </Banner>

        <StatGrid>
          <Stat label="Total devices" value={h.total_devices} />
          <Stat label="With Expo token" value={h.devices_with_token} tone={tokensOk ? 'good' : 'warn'} hint={h.total_devices ? `${Math.round(tokenCoverage * 100)}% coverage` : ''} />
          <Stat label="Missing token" value={h.devices_missing_token} tone={(h.devices_missing_token ?? 0) > 0 ? 'warn' : 'good'} />
          <Stat label="Duplicate tokens" value={h.duplicate_tokens} tone={(h.duplicate_tokens ?? 0) > 0 ? 'warn' : 'good'} hint="dedup risk" />
          <Stat label="Events pending" value={h.events_pending} />
          <Stat label="Events processing" value={h.events_processing} />
          <Stat label="Events failed 24h" value={h.events_failed_24h} tone={(h.events_failed_24h ?? 0) > 0 ? 'bad' : 'good'} />
          <Stat label="Events completed 24h" value={h.events_completed_24h} tone="good" />
          <Stat label="Deliveries pending" value={h.deliveries_pending} />
          <Stat label="Delivered 24h" value={h.deliveries_delivered_24h} tone="good" />
          <Stat label="Failed 24h" value={h.deliveries_failed_24h} tone={(h.deliveries_failed_24h ?? 0) > 0 ? 'bad' : 'good'} />
          <Stat label="Retries pending" value={h.retries_pending} hint="failed & attempts<5" />
          <Stat label="Rate-limited 24h" value={h.rate_limited_users_24h} hint="users hitting cap" />
          <Stat label="Unread total" value={h.unread_total} />
        </StatGrid>
      </Panel>

      <Panel title="Device token validator">
        <div className="text-sm text-gray-700 space-y-2">
          <p>The pipeline only delivers push to rows where <code>user_devices.push_token</code> is non-null. The current state:</p>
          <ul className="list-disc list-inside text-xs text-gray-600">
            <li>Devices with valid token: <strong>{h.devices_with_token ?? 0}</strong></li>
            <li>Devices missing token: <strong>{h.devices_missing_token ?? 0}</strong></li>
            <li>Tokens appearing on more than one device row (dedup risk): <strong>{h.duplicate_tokens ?? 0}</strong></li>
          </ul>
          {(h.duplicate_tokens ?? 0) > 0 && (
            <Banner tone="warn" title="Duplicate push tokens detected">
              Same token registered against multiple device rows. The dispatcher will deliver multiple times unless dedup logic at the worker filters by token. Investigate before raising rollout.
            </Banner>
          )}
        </div>
      </Panel>

      <Panel title="Failed deliveries (last 50)" subtitle="Use to verify retry/backoff logic">
        <Table
          rowKey={r => r.id}
          columns={[
            { key: 'updated_at', header: 'When', render: r => formatRelative(r.updated_at) },
            { key: 'channel', header: 'Channel', render: r => <Badge tone="info">{r.channel}</Badge> },
            { key: 'attempts', header: 'Attempts' },
            { key: 'provider', header: 'Provider' },
            { key: 'error_message', header: 'Error', render: r => (
              <span className="text-xs text-red-700 max-w-md inline-block truncate" title={r.error_message}>{r.error_message}</span>
            )},
            { key: 'user_id', header: 'User', render: r => <span className="font-mono text-[11px]">{r.user_id}</span> },
          ]}
          rows={failures}
          empty="No failed deliveries in recent history. ✓"
        />
      </Panel>

      <Panel title="Notification test sender" subtitle="Goes through canonical enqueue + materialize path; audited.">
        <div className="grid md:grid-cols-2 gap-3">
          <input
            value={testUserId}
            onChange={e => setTestUserId(e.target.value)}
            placeholder="Target user UUID"
            className="text-sm border-gray-300 rounded-lg"
          />
          <input
            value={testTitle}
            onChange={e => setTestTitle(e.target.value)}
            placeholder="Title"
            className="text-sm border-gray-300 rounded-lg"
          />
          <textarea
            value={testBody}
            onChange={e => setTestBody(e.target.value)}
            placeholder="Body"
            className="text-sm border-gray-300 rounded-lg md:col-span-2"
            rows={2}
          />
        </div>
        <div className="mt-3">
          <Button tone="primary" onClick={handleSendTest} disabled={busy}>Send test notification</Button>
        </div>
      </Panel>
    </>
  )
}
