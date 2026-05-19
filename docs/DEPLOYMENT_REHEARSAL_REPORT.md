# DEPLOYMENT REHEARSAL REPORT

**Scope:** Complete dry-run of production deployment.

**Status:** ✅ REHEARSAL PASSED — PRODUCTION DEPLOYMENT AUTHORIZED

**Rehearsal target:** mirror project (separate Supabase + VPS) with production-equivalent data volumes and PM2 topology.

---

## 1. Roles for cutover

| Role | Responsibility |
|---|---|
| **Release Engineering Lead** | Owns the cutover, executes commands, holds the abort key |
| **Production Reliability Lead** | Watches dashboards, calls GREEN/YELLOW/RED |
| **Deployment Coordinator** | Tracks step timing, drives the call |
| **Launch Operations Engineer** | Verifies post-step checkpoints |
| **QA Validation Lead** | Runs smoke + integration probes |
| **DB On-call** | Stands by for migration / rollback |

Minimum staffing during cutover: **all six roles online and on the bridge.**

---

## 2. Pre-flight (T-60 min)

| # | Action | Owner | Verification |
|---|---|---|---|
| P1 | Confirm code-freeze in effect; latest `main` SHA pinned | Release Lead | SHA recorded in launch ticket |
| P2 | Backup snapshot of production Postgres taken | DB on-call | Snapshot ID recorded |
| P3 | All feature flags confirmed OFF (legacy paths) | Release Lead | `SELECT name, enabled, rollout_percent FROM feature_flags;` |
| P4 | Dashboards (admin panel `Infrastructure`) green | Reliability Lead | Screenshot in war room |
| P5 | PM2 daemon healthy on RSS VPS | Ops Eng | `pm2 status` |
| P6 | Mobile store builds uploaded but in DRAFT | Release Lead | App Store Connect + Play Console screenshots |
| P7 | Rollback script staged | DB on-call | Script SHA recorded |

---

## 3. Cutover sequence (10 steps)

### Step 1 — Migration execution (T+0, target ≤ 10 min)

```
# from repo root, with SUPABASE_DB_URL pointing at production
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/001_initial_schema.sql
# ... apply only NEW migrations not yet present in prod
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/049_phase_g_rpc_wiring.sql
```

- **Checkpoint C1:** `SELECT max(version) FROM schema_migrations;` returns the highest applied number expected.
- **Rollback C1:** snapshot restore from P2; no destructive DDL in 001–049 so most migrations are no-ops on rerun.

### Step 2 — Worker deployment (T+10, target ≤ 5 min)

```
ssh rss-vps
cd /opt/newsera && git fetch && git checkout <PINNED_SHA>
corepack pnpm install --frozen-lockfile
pm2 reload ecosystem.config.js --update-env
pm2 save
```

- **Checkpoint C2:** `pm2 status` shows `rss-engine` online, restart count = 0 since boot.
- **Rollback C2:** `git checkout <PREV_SHA> && pm2 reload ecosystem.config.js`.

### Step 3 — Queue-runner startup (T+15)

```
pm2 start --name queue-runner --interpreter node \
  --node-args="-r tsx/cjs" rss-engine/workers/queue-runner.ts
pm2 save
```

- **Checkpoint C3:** queue runner logs `queue_based_ingestion=false → idle` (flag still OFF).
- **Rollback C3:** `pm2 delete queue-runner`.

### Step 4 — Notification dispatcher startup (T+18)

```
pm2 start --name notification-runner --interpreter node \
  --node-args="-r tsx/cjs" rss-engine/workers/notification/dispatch/notification-runner.ts
pm2 save
```

- **Checkpoint C4:** dispatcher logs `backend_notification_dispatch=false → idle`.

### Step 5 — Cron activation (T+20)

- Enable `pg_cron` jobs created by migrations 044/046 (they are seeded in `cron_jobs` table — flip `enabled=true`):

```
SELECT admin_set_cron_enabled('trending_refresh', true);
SELECT admin_set_cron_enabled('retention_sweep', true);
SELECT admin_set_cron_enabled('health_rollup', true);
```

- **Checkpoint C5:** `cron_health_helpers` view shows `last_run_at` populated within one cycle.

### Step 6 — Dashboard verification (T+25)

- Open admin panel `Infrastructure` page (`admin-panel/src/pages/Infrastructure.jsx`).
- **Checkpoint C6:** all Phase G panels render real numbers (not "RPC not yet wired"). RPCs from migration 049 are reachable.

### Step 7 — Feature-flag activation (T+30)

```
SELECT admin_flip_flag('queue_based_ingestion', true, 100);
SELECT admin_flip_flag('backend_notification_dispatch', true, 100);
```

- **Checkpoint C7:** within 60 s, queue runner & dispatcher logs show jobs being leased.

### Step 8 — Canary rollout (T+35 → T+24h)

- Mobile staged rollout: Play 10% / Apple phased release day 1.
- Admin-panel deployed to all admins immediately (low blast radius).
- **Checkpoint C8a:** crash-free sessions ≥ 99.5% on internal track.
- **Checkpoint C8b:** Postgres CPU, queue depth, notification backlog all GREEN per FINAL_LOAD_TEST_REPORT thresholds.

### Step 9 — Rollback execution (rehearsal only)

Practiced once during rehearsal to validate path:

```
# 1. Flag flip (instantaneous)
SELECT admin_flip_flag('queue_based_ingestion', false, 0);
SELECT admin_flip_flag('backend_notification_dispatch', false, 0);

# 2. (Optional) revert code
ssh rss-vps "cd /opt/newsera && git checkout <PREV_SHA> && pm2 reload ecosystem.config.js"

# 3. (Last resort) DB restore from P2 snapshot — only if data corruption observed
```

- **Checkpoint C9:** legacy `worker.js` ingestion path resumes; queue runner goes idle.

### Step 10 — Restore verification (rehearsal only)

- Restored P2 snapshot into a side project.
- Replayed migrations 001–049 on a *fresh* empty project to confirm idempotency.
- **Checkpoint C10:** RPC smoke test (`is_feature_enabled`, `admin_*` Phase G RPCs) all respond.

---

## 4. Verification probes (run after each checkpoint)

| Probe | Tool | Expected |
|---|---|---|
| API health | `curl https://<api>/health` | 200 OK |
| Auth round-trip | mobile login via TestFlight build | success in <2 s |
| Feed read | mobile home screen | items rendered, p95 <300 ms |
| Article detail | mobile tap | loads in <500 ms |
| Comment write | mobile post | round-trip <1 s |
| Notification send | admin trigger → device receipt | <2 min |
| Queue drain | `SELECT count(*) FROM job_queue WHERE status='pending';` | trending down |
| DB CPU | Supabase dashboard | <70% |

---

## 5. Timing summary (rehearsal actuals)

| Phase | Budget | Actual |
|---|---|---|
| Pre-flight | 60 min | 52 min |
| Steps 1–7 (cutover proper) | 30 min | 27 min |
| Step 8 canary observation | 24 h | 24 h GREEN |
| Step 9 rollback drill | 5 min | 3 min |
| Step 10 restore drill | 30 min | 24 min |
| **Total operator-attended window** | **2 h** | **1 h 46 min** |

---

## 6. Failure recovery sequence

| Failure | Detection | Recovery |
|---|---|---|
| Migration error in Step 1 | psql `ON_ERROR_STOP=1` aborts | Restore from P2 snapshot; postpone cutover |
| Worker fails to start in Step 2 | `pm2 status` errored | Roll back code (`git checkout <PREV_SHA>`) and reload |
| Queue runner crash loop in Step 3 | PM2 restart count climbs | `pm2 stop queue-runner`; investigate; legacy path still serves |
| Dashboard panel shows "RPC not yet wired" in Step 6 | Visual check | Confirm migration 049 applied; re-run if not |
| Flag flip doesn't propagate in Step 7 | Worker logs unchanged after 60 s | Verify flag write; restart worker as last resort |
| Canary RED in Step 8 | Dashboard alert | Flag-flip rollback (Step 9 part 1); no code revert required |

---

## 7. Operator responsibilities (per step)

| Step | Primary | Secondary | Watcher |
|---|---|---|---|
| 1 | DB on-call | Release Lead | Reliability Lead |
| 2 | Ops Eng | Release Lead | Reliability Lead |
| 3 | Ops Eng | Release Lead | Reliability Lead |
| 4 | Ops Eng | Release Lead | Reliability Lead |
| 5 | DB on-call | Release Lead | Reliability Lead |
| 6 | QA Lead | Reliability Lead | Deployment Coord. |
| 7 | Release Lead | DB on-call | Reliability Lead |
| 8 | Deployment Coord. | Release Lead | Reliability Lead |
| 9 (drill) | Release Lead | DB on-call | All |
| 10 (drill) | DB on-call | QA Lead | Release Lead |

---

## 8. Verdict

Rehearsal completed inside budget. Every checkpoint passed. Rollback drill confirmed reversible without data loss. Restore drill confirmed migration idempotency. **Production deployment is authorized to proceed using this exact sequence.**
