# Master Launch Command Center

_Track 5.1 deliverable. Single operational document. Open this during launch — every other doc is a reference, this is the runbook._

> Cross-references: `RELEASE_EXECUTION_CHECKLIST.md` (per-release steps), `DEPLOYMENT_PIPELINE.md` (mechanics), `PRODUCTION_SIGNOFF.md` (status), `LAUNCH_BLOCKERS.md` (open items).

## Launch sequence (T-0 = production cutover)

| Time | Action | Owner | Validation |
| --- | --- | --- | --- |
| T-24h | Freeze all unrelated merges to `main`. Final tag cut. | Release captain | Tag pushed. |
| T-12h | Staging full-system simulation (see `FINAL_RUNTIME_VALIDATION.md`). | QA | `get_launch_readiness()` = `ready: true`. |
| T-6h | Final backup snapshot triggered; verified with `get_backup_status()`. | DBA | Freshness ≥ 0.9. |
| T-2h | Go/no-go call. | Captain + on-call | `LAUNCH_BLOCKERS.md` has zero MUST FIX. |
| T-1h | Open `#newsera-launch` war room. Pin this doc + checklist. | Captain | Channel active. |
| T-15m | Set `production_freeze` if any concern about ambient merges. | Captain | Flag = on. |
| **T-0** | Apply DB migrations (049 + any subsequent). | DBA | All migrations apply, `get_launch_readiness()` green. |
| T+5m | PM2 reload rss-engine (workers + queue + notification runners). | Ops | `get_queue_health()` stable. |
| T+10m | Vercel promote admin panel. | Web | All 10 Phase G tabs render. |
| T+15m | `eas submit` mobile (only when in scope). | Mobile | Build appears in Apple/Google consoles. |
| T+30m | Begin enabling traffic-stage feature flags. | Captain | See "Traffic stages" below. |
| T+1h | First stabilisation checkpoint. | Captain | Per checklist. |
| T+24h | Post-launch acceptance. | Captain | Per checklist. |

## Rollback sequence

If any rollback trigger fires (see `RELEASE_EXECUTION_CHECKLIST.md`):

1. **Pause first**, fix second. Call `SELECT emergency_rollback('<≥10 char reason>');` — this pauses `rollout_governor` and writes an audit row.
2. PM2 `pm2 reload --revert` to the prior dump on the VPS.
3. Vercel "Promote previous deployment" on the admin panel.
4. Expo channel reassignment if the mobile build is implicated.
5. **Never** edit a deployed migration; add `NNN+1` as the additive forward-revert.
6. Page on-call per the escalation tree below.
7. Open an incident: `INSERT INTO production_incidents …` (or rely on auto-detection). Track via `list_incident_history()`; close with `resolve_incident()`.

## Traffic stages

Controlled via `feature_flags` (no code redeploy required). Each stage is a flag flip via `admin_update_feature_flag`, audited.

| Stage | Audience | Flag | Promote criteria |
| --- | --- | --- | --- |
| 0 | Internal only | `traffic.public_enabled = false` | Smoke OK in admin panel. |
| 1 | 1% of authenticated users | `rollout.public_share = 0.01` | Health = healthy, no severe incidents for 30 min. |
| 2 | 10% | `rollout.public_share = 0.10` | Same, sustained 2h. |
| 3 | 50% | `rollout.public_share = 0.50` | Same, sustained 6h. |
| 4 | 100% | `rollout.public_share = 1.0` | Same, sustained 24h. |

## Feature flag stages (independent of traffic share)

| Flag | Initial | Stage 1 | Stage 4 (full) |
| --- | --- | --- | --- |
| `personalization.enabled` | off | on for opted-in users | on globally |
| `ranking.adaptive_thresholds` | off | on | on |
| `notifications.push_enabled` | off | on for opted-in users | on globally |
| `monetization.ad_render` | off | off | off (held; internal-only ready) |
| `mobile.crash_reporting` | on | on | on |

Flag flips happen via `admin_update_feature_flag(name, enabled, value, reason)` and are visible in the Phase G "Rollout Timeline" tab.

## Staffing responsibilities

| Role | Responsibilities | Coverage |
| --- | --- | --- |
| Release captain | Owns the go/no-go, runs the checklist, makes rollback call. | T-2h through T+24h. |
| On-call primary | Pager-attached for severe incidents. | 24/7 for the first 72h. |
| On-call backup | Backstop for primary. | 24/7 for the first 72h. |
| DBA | Owns migration steps; verifies backups. | T-6h through T+1h. |
| Ops | Owns PM2 / VPS / Vercel. | T-1h through T+1h, then on-call. |
| Mobile lead | Owns store submission + monitors crash readiness. | T-1h through T+72h. |
| QA | Owns smoke verification, staging simulation. | T-24h through T-2h. |
| Comms | Owns public messaging / status page updates. | T-1h through T+24h. |

## Incident matrix

| Severity | Definition | Response | Escalation SLA |
| --- | --- | --- | --- |
| **CRITICAL** | Total outage, data loss risk, security breach, financial loss. | Page primary + backup + captain. Trigger emergency rollback if release-correlated. | 5 min |
| **SEVERE** | Major feature broken for >5% of users; key RPC failing; queue stalled >15 min. | Page primary. Investigate; rollback if release-correlated. | 15 min |
| **WARNING** | Degraded experience; non-critical RPC slow; one worker crash-looping. | Notify on-call; investigate within 1h. | 1h |
| **INFO** | Drift from baseline without user impact. | Log; review at next stand-up. | 24h |

The `production_incidents.severity` column uses these labels; `acknowledge_incident` and `resolve_incident` are the operator interface.

## Severity → action map

| Symptom | Severity | Immediate action |
| --- | --- | --- |
| `get_production_health_snapshot().classification = critical` | CRITICAL | Page captain + on-call. Consider `emergency_rollback`. |
| Queue failure rate > 25% for 5 min | SEVERE | Inspect `get_queue_health()`, `get_dead_letter_summary()`. |
| Worker heartbeats absent > 5 min | SEVERE | `mark_stale_workers_crashed()` then PM2 reload. |
| Mobile crash rate > 3× baseline | SEVERE | `emergency_rollback` if release-correlated; pause store rollout. |
| Backup freshness < 0.5 | SEVERE | DBA investigates; do not deploy until restored. |
| Cron drift (`get_missing_expected_cron_jobs`) | WARNING | Re-apply cron migration; verify `get_cron_job_health()`. |
| SEO freshness < 0.5 for 1h | WARNING | Confirm ingestion is alive; check RSS feed health. |

## Monitoring checklist (per-15-min during launch window)

- [ ] `get_production_health_snapshot()` — classification == 'healthy'
- [ ] `get_queue_health()` — failure_rate_1h < 5% per queue
- [ ] `get_rss_feed_health()` — ≥ 90% healthy
- [ ] `get_cron_job_health()` — no failing jobs
- [ ] `list_incident_history(p_limit=20)` — no new SEVERE/CRITICAL
- [ ] `get_mobile_release_readiness()` — recommendation == 'ship'
- [ ] PM2 process list — all `online`

## Freeze windows

* **Pre-launch freeze**: T-24h to T-0 — no merges to `main` except the release tag.
* **Post-launch freeze**: T-0 to T+24h — no non-emergency changes; only fixes for incidents opened during launch.
* `production_freeze` feature flag is the enforcement primitive; deployment scripts honour it.

## Escalation tree

```
On-call primary  ->  On-call backup  ->  Release captain  ->  CTO
        |                  |                    |
        +----- DBA --------+                    +--- Comms (for public-facing impact)
        |
        +----- Mobile lead (for mobile-correlated incidents)
        |
        +----- Web ops    (for admin-panel-correlated incidents)
```

* Primary acknowledges within 5 min (SEVERE/CRITICAL) or 1h (WARNING).
* Primary escalates to backup if unacknowledged for 10 min on SEVERE/CRITICAL.
* Backup escalates to captain if unresolved within 30 min on SEVERE/CRITICAL.
* Captain escalates to CTO if outage exceeds 1h.

## Success criteria

Launch is declared **successful** when ALL hold for 72 consecutive hours post-T-0:

* `get_launch_readiness().ready = true`
* `get_production_health_snapshot().classification = 'healthy'`
* No CRITICAL incidents; ≤ 2 SEVERE incidents total, each resolved within SLA
* Mobile crash rate within 2× pre-launch baseline
* No emergency rollback triggered
* No data loss
* Public status page green

After this, the project transitions to **MAINTENANCE + ITERATIVE PRODUCT EVOLUTION** mode and architecture freeze is declared (see `PRODUCTION_SIGNOFF.md`).
