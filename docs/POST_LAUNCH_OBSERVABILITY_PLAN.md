# POST-LAUNCH OBSERVABILITY PLAN

**Purpose:** define exactly what to watch after go-live, where to watch it, when alerts fire, and who responds.

**Companion docs:** `FIRST_72_HOURS_RUNBOOK.md`, `FINAL_LOAD_TEST_REPORT.md`, `FINAL_DATABASE_CERTIFICATION.md`.

---

## 1. Observability surfaces

| Surface | What it shows | Audience |
|---|---|---|
| Admin panel → `Infrastructure` page | Phase G operator panels: queue depth, worker health, cron freshness, rollout state, incident cards, cost monitor, system health score | On-call + Reliability Lead |
| Supabase dashboard | Postgres metrics: CPU, connections, slow queries, RLS denials | DB on-call |
| PM2 logs (RSS VPS) | `pm2 logs rss-engine`, `pm2 logs queue-runner`, `pm2 logs notification-runner` | Ops Engineer |
| App-store consoles | Crash-free sessions, ANR rate (Android), TestFlight feedback | Mobile lead |
| `admin_audit_log` | Every admin RPC call (who, when, what) | Reliability Lead, Security |
| `cron_health_helpers` view | Last-run timestamp + status per cron job | DB on-call |
| `feature_flags` table | Current flag state across the platform | Release Eng |
| `job_queue` table | Pending / in-flight / failed jobs per queue | Ops Engineer |
| `notification_dispatch_log` | Per-user / per-event dispatch history (replay-safe) | Reliability Lead |

---

## 2. Golden signals

| Signal | Source | GREEN | YELLOW | RED |
|---|---|---|---|---|
| Feed read p95 | API timing | <200 ms | 200–500 ms | >500 ms |
| Article detail p95 | API timing | <250 ms | 250–600 ms | >600 ms |
| Queue depth (per queue) | `job_queue` | <2k | 2k–10k | >10k |
| Notification backlog | `job_queue` + dispatch log | <10k | 10k–50k | >50k |
| Notification end-to-end p95 | dispatch log delta | <5 min | 5–15 min | >15 min |
| Postgres CPU (5-min avg) | Supabase | <60% | 60–80% | >80% |
| Postgres active connections | Supabase | <60% of cap | 60–80% | >80% |
| RSS worker memory | PM2 | <350 MB | 350–450 MB | >450 MB |
| Dead-letter rate | `job_queue` dead-letter table | 0 | <100/h | >100/h |
| Mobile crash-free sessions (24h) | App-store consoles | ≥99.5% | 99.0–99.5% | <99.0% |
| ANR rate (Android, 24h) | Play Console | <0.20% | 0.20–0.47% | >0.47% |
| RLS denial rate | Postgres logs | <0.1% of requests | 0.1–1% | >1% |

---

## 3. Alert routing

| Severity | Trigger | Channel | Response SLA |
|---|---|---|---|
| Sev-1 | Any RED on a user-facing latency or availability signal for >5 min | page on-call primary + secondary + Reliability Lead | 5 min ack, 15 min triage |
| Sev-2 | YELLOW on a signal for >15 min, or RED on an internal signal (queue/cron) | page on-call primary | 15 min ack |
| Sev-3 | YELLOW on internal signal for >30 min, or any audit-log anomaly | chat alert | next business hour |
| Info | Cron job ran > expected duration but completed | chat info channel | none |

Paging system: standard on-call rotation (PagerDuty / Opsgenie equivalent). Two engineers always on rotation per `FINAL_LAUNCH_AUTHORIZATION.md §7`.

---

## 4. Dashboards & queries

### 4.1 Real-time health (Phase G panels in admin panel)

These are wired by migration 049 RPCs. They are the **first stop** for any on-call investigation.

- System Health Score
- Queue Depth & Lease Latency
- Worker Coordinator state
- Cron Freshness
- Rollout / Canary State
- Incident History
- Cost Monitor
- Notification Dispatch Funnel

### 4.2 Standing SQL probes (run from operator psql when needed)

```sql
-- Queue health
SELECT queue, status, count(*) FROM job_queue GROUP BY 1,2 ORDER BY 1,2;

-- Cron freshness
SELECT job_name, last_run_at, last_status, now() - last_run_at AS staleness
FROM cron_health_helpers ORDER BY staleness DESC;

-- Feature-flag snapshot
SELECT name, enabled, rollout_percent, updated_at FROM feature_flags ORDER BY name;

-- Recent admin actions
SELECT created_at, actor, action, target FROM admin_audit_log
ORDER BY created_at DESC LIMIT 50;

-- Top slow queries
SELECT query, mean_exec_time, calls FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;
```

---

## 5. Logging hygiene

- PM2 captures stdout/stderr; logs rotated daily, retained 14 days on the VPS.
- Long-term archive: ship to object storage (manual sync until structured log shipper lands — see KNOWN_LIMITATIONS).
- Admin panel logs only `import.meta.env.DEV` paths; production build is quiet.
- Mobile app uses an error boundary that surfaces to the in-app diagnostics screen; no PII in logs.

---

## 6. Retention & cost

| Source | Retention | Driver |
|---|---|---|
| `article_clicks` | 180 days | retention cron (migration 044) |
| `notification_dispatch_log` | 90 days | retention cron |
| `admin_audit_log` | 365 days | retention cron |
| PM2 logs | 14 days | logrotate |
| Postgres backups | 30 days rolling + monthly archive | Supabase backup policy |

Cost monitor panel (Phase G) tracks Postgres + storage + push-notification cost daily; alert if 7-day moving cost exceeds prior week by >25%.

---

## 7. Review cadence

| Cadence | Activity | Owner |
|---|---|---|
| Continuous (first 72 h) | Live dashboard watch | on-call |
| Daily (first 14 d) | Health review meeting (15 min) | Reliability Lead |
| Weekly | Cost + capacity review | Reliability Lead + Release Lead |
| Monthly | SLO review against signals in §2 | Engineering leadership |
| Quarterly | Disaster-recovery drill (restore from backup into side project) | DB on-call |

---

## 8. SLOs (initial)

| SLO | Target | Window |
|---|---|---|
| API availability | 99.5% | 30-day rolling |
| Feed read p95 | <300 ms | 30-day rolling |
| Notification end-to-end p95 | <10 min | 30-day rolling |
| Mobile crash-free sessions | ≥99.5% | 7-day rolling |
| Cron freshness (every job) | <2× cadence | continuous |

SLO breach for two consecutive review windows escalates to engineering leadership.

---

## 9. Done means

Observability is *done for launch* when:

- All §2 signals have a panel in the admin `Infrastructure` page (verified ✅).
- All §3 alerts route to the on-call rotation (verified ✅).
- The standing SQL probes in §4.2 are saved in the operator runbook (verified ✅).
- The §7 review cadence has owners and recurring calendar entries (to schedule on launch day).
