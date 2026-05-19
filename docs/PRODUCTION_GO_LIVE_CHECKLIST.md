# PRODUCTION GO-LIVE CHECKLIST

**Use this checklist during the cutover bridge call.** Tick each item live. Halt on any unchecked blocker item.

Source documents: `DEPLOYMENT_REHEARSAL_REPORT.md`, `FINAL_LOAD_TEST_REPORT.md`, `FINAL_DATABASE_CERTIFICATION.md`.

---

## A. T-24 hours

- [ ] Code freeze announced and acknowledged by all contributors.
- [ ] `main` SHA pinned in the launch ticket.
- [ ] Production Postgres backup verified (snapshot ID recorded).
- [ ] Mobile builds uploaded to App Store Connect + Play Console (DRAFT).
- [ ] All six cutover roles confirmed available on bridge.
- [ ] War-room / bridge channel created; on-call rotation locked.
- [ ] Status page and comms templates pre-staged.
- [ ] Rollback script SHA recorded in launch ticket.

## B. T-60 minutes (pre-flight)

- [ ] P1: pinned SHA confirmed.
- [ ] P2: fresh Postgres snapshot taken (timestamp recorded).
- [ ] P3: all new feature flags confirmed OFF in `feature_flags` table.
- [ ] P4: admin panel `Infrastructure` dashboard GREEN.
- [ ] P5: `pm2 status` on RSS VPS shows healthy `rss-engine`.
- [ ] P6: store builds in DRAFT (not yet released).
- [ ] P7: rollback script staged on operator workstation.
- [ ] Comms standing by (eng leadership + comms lead).

## C. Cutover (T+0 → T+30 min)

### Step 1 — Migrations
- [ ] New migration files applied in order, `ON_ERROR_STOP=1`.
- [ ] **C1:** `SELECT max(version) FROM schema_migrations;` = 049.

### Step 2 — Worker deploy
- [ ] `git checkout <PINNED_SHA>` on RSS VPS.
- [ ] `corepack pnpm install --frozen-lockfile` succeeds.
- [ ] `pm2 reload ecosystem.config.js --update-env` succeeds.
- [ ] **C2:** `pm2 status` — `rss-engine` online, no restarts.

### Step 3 — Queue runner
- [ ] `pm2 start queue-runner ...` succeeds.
- [ ] **C3:** logs show `queue_based_ingestion=false → idle`.

### Step 4 — Notification dispatcher
- [ ] `pm2 start notification-runner ...` succeeds.
- [ ] **C4:** logs show `backend_notification_dispatch=false → idle`.

### Step 5 — Cron activation
- [ ] `admin_set_cron_enabled('trending_refresh', true)` returns ok.
- [ ] `admin_set_cron_enabled('retention_sweep', true)` returns ok.
- [ ] `admin_set_cron_enabled('health_rollup', true)` returns ok.
- [ ] **C5:** `cron_health_helpers` view shows `last_run_at` populated.

### Step 6 — Dashboard verification
- [ ] Admin panel `Infrastructure` page loads.
- [ ] **C6:** every Phase G panel renders real data (no "RPC not yet wired").

### Step 7 — Feature-flag activation
- [ ] `admin_flip_flag('queue_based_ingestion', true, 100)` returns ok.
- [ ] `admin_flip_flag('backend_notification_dispatch', true, 100)` returns ok.
- [ ] **C7:** queue runner + dispatcher logs show jobs being leased within 60 s.

## D. Post-cutover smoke (T+30 → T+60 min)

- [ ] API `/health` returns 200.
- [ ] Mobile login (TestFlight build) succeeds in <2 s.
- [ ] Mobile home feed renders; p95 <300 ms.
- [ ] Article detail loads <500 ms.
- [ ] Comment posted from mobile, visible to second client.
- [ ] Admin-triggered notification arrives on test device <2 min.
- [ ] `SELECT count(*) FROM job_queue WHERE status='pending';` trending down.
- [ ] Postgres CPU <70%.

## E. Canary observation (T+1h → T+24h)

- [ ] Feed read p95 < 200 ms sustained.
- [ ] Queue depth < 2k sustained.
- [ ] Notification backlog < 10k sustained.
- [ ] Postgres CPU 5-min avg < 60%.
- [ ] Mobile crash-free sessions ≥ 99.5%.
- [ ] Dead-letter rate = 0.
- [ ] No Sev-1 / Sev-2 incidents.

## F. Mobile staged rollout

- [ ] Play staged 10% started.
- [ ] App Store phased release day 1 started.
- [ ] Crash dashboards monitored every 1 h for first 24 h.

## G. Promotion gates (after each dwell window)

- [ ] All §E conditions GREEN for the specified dwell time → promote to next wave.
- [ ] Any single RED metric → **HALT** promotion; trigger §6 escalation in `FINAL_LAUNCH_AUTHORIZATION.md`.

## H. Communications

- [ ] Internal launch announcement posted at T+30 min if §D smoke is green.
- [ ] Public status page updated at each wave promotion.
- [ ] Customer support briefed with FAQ + escalation contact.

## I. Rollback triggers (any one halts and may invoke Tier 1 rollback)

- [ ] Feed read p95 > 500 ms for >10 min.
- [ ] Queue depth > 10k for >10 min.
- [ ] Notification backlog > 50k for >10 min.
- [ ] Postgres CPU > 80% for >5 min.
- [ ] Mobile crash-free sessions < 99.0%.
- [ ] Any data-integrity alert (FK violation, RLS leak, audit gap).

## J. Close-out

- [ ] All cutover steps signed off by Release Lead.
- [ ] Launch ticket updated with timings, SHA, snapshot ID, flag-flip log.
- [ ] First-72h watch handed off to on-call (see `FIRST_72_HOURS_RUNBOOK.md`).
- [ ] Post-launch retro scheduled for T+7d.
