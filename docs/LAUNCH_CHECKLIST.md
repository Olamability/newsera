# Launch Checklist

> **Use:** before promoting NewsEra to any production rollout stage beyond
> `internal` (1%).
> **Owner:** release engineer.
> **Last reviewed:** Phase E — May 2026.

Every item is **required**. A `[ ]` blocks the launch. Tick items in a
copy of this file pinned to the release ticket.

---

## Backend

### Database
- [ ] All migrations applied; `schema_migrations` matches the release SHA.
- [ ] No `_pending_` migration files in the repo.
- [ ] `select pg_size_pretty(pg_database_size(current_database()))` recorded
      in the release ticket (baseline for `storage_growth_rate`).
- [ ] RLS policies verified by `SECURITY_AUDIT_REPORT.md` — no `service_role`
      bypass on user-facing tables.
- [ ] All RPCs documented in `BACKEND_RULES.md` exist and return the
      expected shapes (smoke test via `pnpm test:queue`).

### Cron / scheduled jobs
- [ ] Supabase scheduler verified for: feed polling, ranking refresh,
      analytics rollup, `cleanup_personalized_feed_cache`.
- [ ] No cron is enabled that calls a deprecated RPC.
- [ ] Cron failure alert configured (status notification).

### Queue health
- [ ] `select queue_name, count(*) from job_queue group by 1;` is green
      (each queue ≤ 10x its backpressure threshold).
- [ ] `dead_letter_jobs` count ≤ baseline.
- [ ] `queue_velocity.growthDeltaPerMin` ≤ 0 averaged over the last hour.

### Worker fleet
- [ ] At least 2 workers per worker type registered and heartbeating.
- [ ] `pickWorker()` returns a healthy worker for every queue.
- [ ] No worker stuck in `stale` or `draining` state.
- [ ] Coordinator's `recentErrors / recentJobs` < 0.1 fleet-wide.

### Rollback safety
- [ ] Last release tag known and tested in staging.
- [ ] `canaryController.rollback(<flag>, { panic: true })` exercised in
      staging within the past 7 days.
- [ ] Database PITR confirmed available with vendor.

---

## Mobile (React Native app)

### Build
- [ ] Release build (`bundle` / `aab`) signed with the production key.
- [ ] Bundle size delta vs previous release ≤ 5%.
- [ ] All `__DEV__` checks compiled out of release bundle (verified by
      `console.log` grep against the bundle).
- [ ] Version numbers (`versionName`, `versionCode`, iOS build) bumped.

### Crash analytics
- [ ] Crash analytics SDK wired and reporting in staging.
- [ ] Symbolication confirmed for at least one staged crash.
- [ ] Crash-free session rate ≥ 99% on the staging cohort.

### Offline behavior
- [ ] Feed loads from local cache with a stale-indicator pill.
- [ ] Read/save actions queue locally and replay on reconnect.
- [ ] No infinite spinners — every loading state has a timeout.

### Push permission UX
- [ ] Soft-ask shown before the system prompt.
- [ ] Denial path leads to the OS settings deep link.
- [ ] Permission status recorded in `user_notification_preferences`.

### Deep links
- [ ] App scheme + universal links registered with the OS.
- [ ] Cold-start deep link routes to the article view (not the splash).
- [ ] Invalid deep links route to the home tab — never crash.

### Startup performance
- [ ] Cold start p95 ≤ 2.5 s on the reference Android device.
- [ ] Time-to-first-feed p95 ≤ 3.5 s.
- [ ] No JS thread blocking > 100 ms during startup.

---

## Admin panel

- [ ] Production build deployed to the protected admin domain.
- [ ] Authentication: only `admin` role can reach `/dashboard/*`.
- [ ] Traffic guard controls visible only to `admin` role.
- [ ] Canary controller dashboard wired to the live `feature_flags` table.
- [ ] All admin-facing RPCs go through `SECURITY DEFINER` functions —
      never direct table writes from the browser.

---

## Operations

### Alerting
- [ ] Pages routed to the on-call rotation.
- [ ] Alert thresholds match `costMonitor.ts` defaults (or justified
      overrides documented).
- [ ] Status page integration verified — at least one staged outage.

### Backups
- [ ] Database PITR enabled with retention ≥ 7 days.
- [ ] Backup restoration drill executed in staging within the past 30 days.
- [ ] Backup restore RTO ≤ 60 min (recorded in `DISASTER_RECOVERY.md`).

### Failover
- [ ] Worker crash storm drill passed (Phase E test 1).
- [ ] Canary rollback drill passed (Phase E test 2).
- [ ] Queue flood drill passed (Phase E test 4).
- [ ] DR replay drill passed (Phase E test 5).

### Documentation
- [ ] `FAILOVER_RUNBOOK.md`, `INCIDENT_RESPONSE.md`, `DISASTER_RECOVERY.md`
      reviewed by all on-call engineers in the last 30 days.
- [ ] `SECURITY_AUDIT_REPORT.md` action items closed or accepted.
- [ ] `PRODUCTION_OPTIMIZATION_REPORT.md` action items closed or
      accepted.

---

## Observability

The dashboard must show (per Phase E) **all** of the following panels —
each backed by a live data source, not a placeholder:

- [ ] worker saturation
- [ ] queue velocity
- [ ] scaling recommendation
- [ ] p95 queue latency
- [ ] cache eviction rate
- [ ] exploration ratio
- [ ] ranking freshness
- [ ] personalization drift
- [ ] stale worker count
- [ ] DLQ growth
- [ ] replay volume
- [ ] push delivery success rate
- [ ] rollout exposure

---

## Final go/no-go

| Question                                                                  | Answer  |
| ------------------------------------------------------------------------- | ------- |
| Are all the above boxes ticked?                                           | __/__   |
| Is the on-call lead reachable for the next 2 hours?                       | yes/no  |
| Has the canary controller been configured with the launch flag?          | yes/no  |
| Has a rollback plan been documented in the release ticket?                | yes/no  |
| Did the team agree to a 24-hour observation window post-launch?           | yes/no  |

If any answer is "no" or any box is unchecked → **DO NOT LAUNCH.**

---

## Post-launch (first 24 h)

- [ ] DLQ growth ≤ baseline × 2.
- [ ] Crash-free session rate ≥ 99%.
- [ ] Push delivery success rate ≥ 90%.
- [ ] No canary rollback fired.
- [ ] No `traffic_guard_state_changed` to a more restrictive state.

If any of these regress, page the on-call lead and treat as SEV-2 minimum.
