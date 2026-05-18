import { useEffect, useState } from 'react'
import { fetchPersonalizationHealth, fetchUserAffinity } from '../../services/infrastructure'
import { Panel, StatGrid, Stat, Banner, Table, Button, formatRelative } from './UI'

export default function PersonalizationHealthPanel() {
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [userId, setUserId] = useState('')
  const [affinity, setAffinity] = useState(null)

  async function load() {
    setBusy(true); setError('')
    try {
      const h = await fetchPersonalizationHealth()
      setHealth(Array.isArray(h) ? h[0] : h)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  async function inspect() {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      window.alert('Enter a valid user UUID first.')
      return
    }
    setBusy(true); setError(''); setAffinity(null)
    try {
      setAffinity(await fetchUserAffinity(userId))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const h = health || {}
  const queueWarn = (h.recompute_queue_depth ?? 0) > 100
  const staleWarn = (h.stale_cache_users ?? 0) > 0

  return (
    <>
      <Panel
        title="Personalization pipeline validation"
        subtitle="user_category_affinity, user_source_affinity, recompute queue, personalized cache"
        action={<Button tone="ghost" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</Button>}
      >
        {error && <Banner tone="bad" title="Error">{error}</Banner>}
        {(h.users_with_category_affinity ?? 0) === 0 && (
          <Banner tone="warn" title="No category affinity data yet">
            Personalization v1 cannot rank usefully until <code>recompute_user_affinity</code> has been run against real engagement data. Keep <code>personalization_v1</code> OFF until coverage grows.
          </Banner>
        )}
        {queueWarn && (
          <Banner tone="warn" title={`Recompute queue depth: ${h.recompute_queue_depth}`}>
            The <code>personalization_recompute_queue</code> is backing up. Investigate <code>process_pending_personalization</code> cron / worker before raising rollout.
          </Banner>
        )}
        {staleWarn && (
          <Banner tone="warn" title={`${h.stale_cache_users} user(s) with stale personalized cache (&gt;24h)`}>
            <code>refresh_active_personalized_15m</code> cron may be running too infrequently or skipping these users. Verify status in the Cron Health panel.
          </Banner>
        )}

        <StatGrid>
          <Stat label="Users w/ category affinity" value={h.users_with_category_affinity} tone={(h.users_with_category_affinity ?? 0) > 0 ? 'good' : 'warn'} />
          <Stat label="Users w/ source affinity" value={h.users_with_source_affinity} />
          <Stat label="Category affinity rows" value={h.total_category_affinities} />
          <Stat label="Source affinity rows" value={h.total_source_affinities} />
          <Stat label="Recompute queue depth" value={h.recompute_queue_depth} tone={queueWarn ? 'warn' : 'good'} />
          <Stat label="Oldest queued (s)" value={h.oldest_recompute_seconds} tone={(h.oldest_recompute_seconds ?? 0) > 3600 ? 'warn' : 'good'} />
          <Stat label="Personalized cache users" value={h.personalized_cache_users} />
          <Stat label="Personalized cache rows" value={h.personalized_cache_rows} />
          <Stat label="Stale cache users" value={h.stale_cache_users} tone={staleWarn ? 'warn' : 'good'} />
          <Stat label="Last global recompute" value={formatRelative(h.last_global_recompute_at)} />
        </StatGrid>

        <div className="mt-4 text-xs text-gray-600 space-y-1">
          <p><strong>Diversity / already-read exclusion:</strong> enforced inside <code>refresh_personalized_feed_for_user</code> (see migration 043) via <code>NOT EXISTS user_read_history</code> and source-diversity weighting in <code>ranked_feed_global</code>. These are evaluated server-side at every refresh.</p>
          <p><strong>Stale cache cleanup:</strong> handled by the <code>cleanup_personalized_feeds_daily</code> cron job. Verify status in the Cron Health panel.</p>
        </div>
      </Panel>

      <Panel title="Affinity score inspector" subtitle="Per-user personalization breakdown for debugging">
        <div className="flex gap-2 mb-3">
          <input
            value={userId}
            onChange={e => setUserId(e.target.value)}
            placeholder="User UUID"
            className="text-sm border-gray-300 rounded-lg flex-1"
          />
          <Button tone="primary" onClick={inspect} disabled={busy}>Inspect</Button>
        </div>
        {affinity && (
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">Top categories</h4>
              <Table
                rowKey={r => r.category_id}
                columns={[
                  { key: 'category_id', header: 'Category', render: r => <span className="font-mono text-[11px]">{r.category_id}</span> },
                  { key: 'score', header: 'Score', render: r => Number(r.score).toFixed(3) },
                  { key: 'raw_signal_count', header: 'Signals' },
                  { key: 'last_interaction_at', header: 'Last', render: r => formatRelative(r.last_interaction_at) },
                ]}
                rows={affinity.categories}
                empty="No category affinity for this user."
              />
            </div>
            <div>
              <h4 className="font-semibold text-sm mb-2">Top sources</h4>
              <Table
                rowKey={r => r.source_id}
                columns={[
                  { key: 'source_id', header: 'Source', render: r => <span className="font-mono text-[11px]">{r.source_id}</span> },
                  { key: 'score', header: 'Score', render: r => Number(r.score).toFixed(3) },
                  { key: 'raw_signal_count', header: 'Signals' },
                  { key: 'last_interaction_at', header: 'Last', render: r => formatRelative(r.last_interaction_at) },
                ]}
                rows={affinity.sources}
                empty="No source affinity for this user."
              />
            </div>
          </div>
        )}
      </Panel>
    </>
  )
}
