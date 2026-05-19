# Failover Runbook

> **Audience:** on-call engineer.
> **Scope:** loss of a single worker, a worker class, or a region.
> **Last reviewed:** Phase E — May 2026.

This runbook is the *first* page an on-call engineer should reach for when a
NewsEra component goes down. It covers detection, decision, and step-by-step
action for the four classes of failure we actually expect at launch.

---

## 0. Triage at a glance

| Symptom                                   | Likely class            | Jump to     |
| ----------------------------------------- | ----------------------- | ----------- |
| `worker_crash_detected` log spike         | Worker process loss     | §1          |
| `queue_backpressure_active` + growing DLQ | Queue overload          | §2          |
| `canary_probe_degraded` repeats           | Bad deploy              | §3          |
| `push_delivery_success_rate` < 80%        | Push pipeline / vendor  | §4          |
| All workers silent on dashboard           | Coordinator partition   | §5          |

Open the **observability dashboard** and confirm the dimension before
acting. Every action below is **reversible** unless explicitly marked
DESTRUCTIVE.

---

## 1. Worker process loss (single worker or class)

### Detection signals

- `worker_crash_detected` log entries from the coordinator.
- `stale_worker_count` > 0 on the dashboard.
- Sudden drop in `jobs_processed` for one queue.

### Action

1. **Confirm the loss.** In the dashboard, filter `worker_id` by the
   crashed id. You should see no heartbeats for ≥ `deadAfterMs` (default
   90s).
2. **Verify automatic reclaim.** Search logs for
   `reclaim_stale_leases_completed worker_id=<id>`. The coordinator fires
   this automatically the moment it declares a worker dead.
   - If absent after 30 s, run the manual reclaim:

     ```bash
     # supabase psql
     select reclaim_expired_leases('<worker_id>');
     ```

3. **Restart the worker.** Use the process manager
   (`pm2 restart <worker>` or the container orchestrator). Do NOT clone
   workers into a different region without coordinator de-registration.
4. **Watch the recovery.** `pickWorker()` should start awarding leases to
   the new instance within one supervise tick (~5s).
5. **Capture a post-mortem snippet.** Save the last 200 log lines from
   the dead worker so the team can correlate.

### Escalate when

- Reclaim returns 0 but the dashboard still shows leased jobs → file
  `infra/queue-stuck-lease` and ping a backend on-call.

---

## 2. Queue overload

### Detection signals

- `queue_backpressure_active` for any queue lasting > 5 min.
- `queue_velocity` growthDeltaPerMin > 0 for > 10 min.
- `autoscaler_recommendation` flips to `high` and stays.

### Action

1. **Acknowledge** the alert; silence the page for 15 min while you
   investigate.
2. **Apply temporary ingestion slowdown** (operator-triggerable):

   ```ts
   await guard.set('ingestion_slowdown_mode', true, {
     initiator: 'oncall',
     reason: 'queue overload incident <id>'
   });
   ```

   This caps ingestion concurrency to 1 and doubles the idle poll
   interval. It does NOT freeze the queue.
3. **Bump worker count** in line with the autoscaler recommendation.
   Recommendations are capped by `bounds.max`; do not exceed them.
4. **If DLQ is growing**, run a *targeted* replay only AFTER the velocity
   curve flattens:

   ```ts
   await recoveryManager.dlqReplay(
     { initiator: 'oncall', reason: 'incident-<id>' },
     { queue: 'ingestion', max: 500 }
   );
   ```

5. **Clear the slowdown** when `queue_velocity.growthDeltaPerMin` ≤ 0 for
   10 min:

   ```ts
   await guard.set('ingestion_slowdown_mode', false, { initiator: 'oncall' });
   ```

### Escalate when

- DLQ grows by > 1k jobs/min despite slowdown → call backend lead.

---

## 3. Bad deploy (canary rollback)

### Detection signals

- `canary_probe_degraded consecutive_degraded ≥ 2`.
- Log entry `canary_rolled_back from_stage=<X> to_stage=<X-1>` — the
  canary controller has *already* rolled back automatically.

### Action

1. **Verify the rollback** in the `feature_flags` table:

   ```sql
   select flag_key, rollout_pct from feature_flags where flag_key = '<flag>';
   ```

   The exposure should match the previous stage (see
   `STAGE_EXPOSURE` in `deployment/canaryController.ts`).
2. **Hold rollback for at least 30 min** to confirm the regression is
   actually the new feature and not coincidental load.
3. **If still degraded after rollback**, escalate to `panic` mode:

   ```ts
   await canary.rollback('<flag>', 'still degraded after auto-rollback', { panic: true });
   ```

   This drops the flag to the `internal` stage (1%).
4. **Open a regression ticket** with the metrics that triggered the
   degraded probe — paste the `canary_probe_degraded` log line verbatim.

### Escalate when

- The flag cannot be applied because `set_feature_flag_rollout` errors →
  open `db/feature-flag-rpc-down` and treat as P1.

---

## 4. Push pipeline degraded

### Detection signals

- `push_delivery_success_rate` < 80% for 10 min.
- Vendor incident notice.

### Action

1. **Engage the kill-switch** to stop sending more failed pushes:

   ```ts
   await guard.set('notification_kill_switch', true, {
     initiator: 'oncall',
     reason: 'push vendor incident'
   });
   ```

2. **Inbox writes continue** (the kill-switch only blocks push fanout, not
   inbox materialization).
3. **Resume** when vendor status is green for 30 min:

   ```ts
   await guard.set('notification_kill_switch', false, { initiator: 'oncall' });
   ```

4. **Replay missed pushes** for the affected window — but ONLY for events
   that have not yet been delivered to the inbox successfully:

   ```ts
   await recoveryManager.notificationReplay(
     { initiator: 'oncall', reason: 'vendor-outage-<id>' },
     { since: <T-vendor-down>, max: 500, onlyFailed: true }
   );
   ```

---

## 5. Coordinator partition

### Detection signals

- Dashboard shows all workers `stale` simultaneously.
- Workers themselves emit `worker_heartbeat_unknown` (their tickets are
  refused).

### Action

1. **Treat as P1.** The coordinator is the only authority for
   lease-balancing; without it, the workers fall back to local lease
   policy but `pickWorker()` becomes stale.
2. **Re-register each worker** via the operator console (or restart
   workers — they re-register on boot).
3. **Reclaim** any leases held by workers whose tickets are no longer
   recognized:

   ```bash
   select reclaim_expired_leases(worker_id) from worker_registrations
   where last_heartbeat_at < now() - interval '5 minutes';
   ```

---

## DESTRUCTIVE actions — require dual-approval

The following are deliberately NOT in the runbook flow. Use only with
the on-call lead's sign-off and an open incident:

- `TRUNCATE job_queue` — **never** acceptable in production.
- Dropping the DLQ — replay first, then archive.
- Disabling RLS on any table — explicitly forbidden by Phase E rules.

---

## Appendix: log line glossary

| Log entry                       | Meaning                                               |
| ------------------------------- | ----------------------------------------------------- |
| `worker_crash_detected`         | Coordinator marked a worker dead (no heartbeat).      |
| `reclaim_stale_leases_completed`| Leases held by a dead worker were released.           |
| `queue_backpressure_active`     | Backpressure controller engaged due to depth/velocity.|
| `canary_probe_degraded`         | One degraded health probe — needs 2 to trigger.       |
| `canary_rolled_back`            | The canary controller dropped a flag to the prior tier|
| `traffic_guard_state_changed`   | An operator-triggered guard control flipped.          |
| `recovery_*`                    | Recovery manager primitives.                          |
