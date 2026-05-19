# Disaster Recovery

> **Scope:** total loss of a major component — database, ingestion fleet, or
> rendering tier — and the procedures to restore the platform to a
> verified-clean state.
> **Audience:** backend on-call + engineering manager.
> **Last reviewed:** Phase E — May 2026.

This document complements `FAILOVER_RUNBOOK.md`. The runbook handles
*degraded* operation; this document handles *recovery from total
component loss*.

---

## 1. Recovery objectives

| Class                          | RTO    | RPO    | Notes                                          |
| ------------------------------ | ------ | ------ | ---------------------------------------------- |
| Primary database (Supabase)    | 60 min | 5 min  | Managed PITR; vendor-controlled.               |
| Job queue (`job_queue` table)  | 15 min | 0      | Same DB; recovered with the DB.                |
| RSS ingestion fleet            | 15 min | 0      | Stateless workers; redeploy.                   |
| Notification dispatch fleet    | 15 min | 0      | Stateless workers; redeploy.                   |
| Ranked feed (`ranked_feed_*`)  | 60 min | 60 min | Rebuildable via category refresh.              |
| Personalized feed              | 6 h    | 24 h   | Rebuildable from interest graph + global feed. |
| Push delivery vendor outage    | n/a    | 0      | Inbox writes continue; pushes replay later.    |

Numbers chosen to match the deliberately Postgres-only architecture; we
never trade them for new infrastructure.

---

## 2. Phases of a disaster recovery

```
   Detect ─▶ Contain ─▶ Restore data ─▶ Restore service ─▶ Verify ─▶ Resume
```

Each step has a single decision-maker (the on-call lead). Skipping a step
is not allowed.

---

## 3. Detect

Any of:

- Multiple unrelated alerts firing across `queue_velocity`, `worker
  saturation`, and `push_delivery_success_rate`.
- Database health check failing for > 60 s.
- Vendor status page reporting incident.

If unsure → assume a disaster and proceed.

---

## 4. Contain

Goal: stop the system from making the problem worse.

1. **Engage queue freeze** (operator):

   ```ts
   await guard.set('queue_freeze', true, { initiator: 'oncall', reason: 'DR: <incident>' });
   ```

   In-flight jobs continue; no new leases granted. This prevents the
   workers from filling the DLQ during the outage.

2. **Engage notification kill-switch.**

   ```ts
   await guard.set('notification_kill_switch', true, { initiator: 'oncall', reason: 'DR' });
   ```

   No pushes go out while the truth is uncertain — this also stops the
   "notification abuse" path (see Phase E test 6).

3. **Pause all canaries.** The controller does not advance autonomously,
   so this is automatic; do not run `advance()` during an incident.

4. **Snapshot the world** for post-mortem:

   ```bash
   pg_dump --schema=public --table=job_queue --table=dead_letter_jobs > /tmp/dr_<ts>.sql
   ```

---

## 5. Restore data

### 5.1 Database

Supabase PITR is the source of truth. Follow vendor steps to restore to
the last known-good timestamp. Make sure the timestamp is BEFORE the
incident detection window.

After restore:

```sql
-- sanity counts
select count(*) from articles where created_at > now() - interval '24 hours';
select count(*) from job_queue where status = 'queued';
select count(*) from dead_letter_jobs;
```

### 5.2 Queue state

The queue lives in the same database; PITR recovers it. Workers must
re-register on boot — the coordinator's in-memory map is rebuilt by the
worker boot sequence.

If `job_queue` was lost but other tables survived (highly unusual), use
`recoveryManager.queueReplay()` to enqueue source-of-truth jobs from the
upstream watermark tables (`feeds.last_polled_at`).

### 5.3 Ranked feed

Re-rank per category — never globally:

```ts
const cats = await listAllActiveCategoryIds(); // 50–200 entries
for (const chunk of chunked(cats, 50)) {
  await recoveryManager.rankingRebuild(
    { initiator: 'oncall', reason: 'DR-<id>' },
    { categoryIds: chunk, max: 50 },
  );
}
```

The recovery manager refuses an unscoped (global) rebuild — this is by
design (see Phase E "NO global recompute jobs").

### 5.4 Personalized feed

`ranked_feed_personalized_v2` is rebuilt lazily on user activity. Do NOT
force-recompute for all users — the cost is unbounded. Instead:

1. Run the cleanup planner to drop stale slices:

   ```ts
   const summary = await feedCacheManager.summarize();
   const plan = feedCacheManager.plan(summary);
   await feedCacheManager.enqueueCleanup(plan, { reason: 'DR-<id>' });
   ```

2. Let user activity refresh the rest. The next request to a user's
   feed triggers a fresh personalized refresh job.

### 5.5 Notification replay

Once the database and pipeline are clean, replay missed events in a
bounded window:

```ts
await recoveryManager.notificationReplay(
  { initiator: 'oncall', reason: 'DR-<id>' },
  { since: incidentStartedAt, until: incidentResolvedAt, max: 2000, onlyFailed: true },
);
```

Dedup at the `notification_events` layer prevents user-visible spam even
if a replay overlaps an already-delivered event.

---

## 6. Restore service

1. Redeploy workers if they were torn down.
2. Verify the coordinator sees fresh heartbeats:
   `select * from worker_registrations order by last_heartbeat_at desc;`
3. **Release the queue freeze** ONLY after the dashboard shows green
   across `queue_velocity` and `stale_worker_count`.

   ```ts
   await guard.set('queue_freeze', false, { initiator: 'oncall', reason: 'DR resolved' });
   ```

4. **Release the notification kill-switch** ONLY after replay completes
   and `push_delivery_success_rate` returns to baseline.

---

## 7. Verify

Run the Phase E simulation suite against staging:

```bash
pnpm --filter @newsera/rss-engine test:phaseE
```

Then in production:

- DLQ should plateau, then drain.
- `worker saturation` < 0.8.
- `queue velocity` `growthDeltaPerMin` < 0 (i.e., draining).
- `replay volume` returns to 0.
- `rollout exposure` matches the staging that was active before the
  incident.

---

## 8. Resume

Final checklist:

- [ ] All guards cleared.
- [ ] DLQ empty (or matches the pre-incident baseline).
- [ ] Canary stages restored to pre-incident state.
- [ ] Incident timeline drafted with structured log lines.
- [ ] Post-mortem scheduled within 72 hours.

---

## 9. Non-destructive guarantees

The platform is built on three rules that hold even mid-disaster:

1. **No destructive migrations.** Recovery never drops tables; it
   restores them.
2. **No bypass of the queue.** Every replay walks the same dedup and
   fanout paths the live pipeline uses.
3. **No direct table writes from recovery code.** Every primitive in
   `recoveryManager.ts` is an RPC call.

If a proposed recovery step violates one of these, STOP and escalate.
