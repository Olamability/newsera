# Launch Blockers

_Track 5.3 deliverable. Authoritative, categorised list. Re-evaluate before every go/no-go call._

## MUST FIX BEFORE LAUNCH

| # | Item | Category | Status |
| --- | --- | --- | --- |
| MF-1 | Apply migration `049_phase_g_rpc_wiring.sql` to production. | RPC wiring | **PR included** |
| MF-2 | At least one user in `auth.users` has `raw_app_meta_data.role = 'admin'`. Required by `_is_admin_caller()` and surfaced as a SEVERE finding by `get_compliance_audit()`. | Compliance | Operator step |
| MF-3 | Production `SUPABASE_SERVICE_ROLE_KEY` is set on the VPS (rss-engine, queue runner, notification runner) and **not** present in any client bundle. | Credentials | Operator step (verified via build grep) |
| MF-4 | `production_freeze` feature flag exists and defaults to **off**. | Deployment | Operator step |
| MF-5 | Latest backup `freshness >= 0.7` per `get_backup_status()` at T-2h. | Backups | Operator step |
| MF-6 | On-call rotation confirmed (primary + backup) for the launch window. | Staffing | Operator step |

## SHOULD FIX

| # | Item | Category | Owner | Notes |
| --- | --- | --- | --- | --- |
| SF-1 | Materialise the optional Phase G tables (`production_incidents`, `deployment_sessions`, `mobile_crash_events`, `ad_impressions`, `backup_history`, `restore_simulations`) and add the indexes recommended in `PRODUCTION_PERFORMANCE_REPORT.md`. | Persistence | DBA | Phase G RPCs degrade gracefully without these; populating them unlocks full dashboard fidelity. |
| SF-2 | Add a startup assertion in `rss-engine` that refuses to boot if `SUPABASE_SERVICE_ROLE_KEY` is unset or equals the anon key. | Hardening | Backend | Defence-in-depth. |
| SF-3 | Add a startup assertion in `mobile-app` that errors when `EXPO_PUBLIC_RELEASE_CHANNEL` does not match the build flavour. | Hardening | Mobile | |
| SF-4 | Wire a CI lint that fails the build if any `VITE_*` or `EXPO_PUBLIC_*` variable name contains `SERVICE_ROLE` or `SECRET`. | CI | DevOps | |
| SF-5 | Document the actual `RSS_WORKER_*` and `QUEUE_RUNNER_*` defaults in operator runbooks. | Docs | DevOps | |
| SF-6 | Regenerate `.env.example` from a grep over `process.env.*` in the rss-engine. | Docs | DevOps | |
| SF-7 | Schedule the first `simulate_restore` drill within 30 days of launch. | Recovery | DBA | |

## ACCEPTABLE POST-LAUNCH

| # | Item | Category | Notes |
| --- | --- | --- | --- |
| AP-1 | Monetization is **disabled** at launch via `monetization.ad_render` flag. Decision to enable is post-launch (T+30d earliest). | Monetization | Per `PRODUCTION_SIGNOFF.md`. |
| AP-2 | When `personalization_recompute_queue` regularly exceeds 50k pending, add an operator alert; consider bumping cleanup cadence. | Performance | Current size is well below threshold. |
| AP-3 | When the optional Phase G tables are materialised, add `idx_production_incidents_first_seen_at` and `(state) WHERE state != 'RESOLVED'`. | Performance | Listed in `PRODUCTION_PERFORMANCE_REPORT.md`. |
| AP-4 | Localise mobile store metadata beyond English. | Mobile | Single-language launch acceptable. |
| AP-5 | Add a generic "duplicate click suppression" unique index to `article_clicks` if duplicates become a hotspot. | Performance | Not currently observed. |
| AP-6 | Backfill `deployment_sessions` from `admin_audit_log` rows with `action = 'deploy'` once the table exists. | Persistence | Audit lineage is preserved either way. |

## Operational risks accepted

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Store review delay (Apple / Google) | Medium | Low (web + mobile decoupled) | Web launch independent of mobile. |
| RSS source outage at launch | Low | Low | Multiple sources per category; saturation surfaced via `get_feed_quality_snapshot()`. |
| Notification rate-limit hit during launch announcement | Low | Low | Per-user rate limiter active; over-cap requests dropped not retried. |
| Cron drift introduced by pg_cron version skew | Low | Medium | `get_missing_expected_cron_jobs()` surfaces drift immediately. |
| Operator typo on `emergency_rollback` reason | Low | Low | Reason length validation enforced server-side (≥10 chars). |

## Categorised totals

* MUST FIX: 6
* SHOULD FIX: 7
* ACCEPTABLE POST-LAUNCH: 6
* Risks accepted: 5

## Re-evaluation

Re-open this document at every go/no-go checkpoint. Items move only via:

* MUST FIX → closed (with evidence) → removed.
* SHOULD FIX → closed → removed, or → ACCEPTABLE POST-LAUNCH with sign-off from the release captain.
* ACCEPTABLE POST-LAUNCH → tracked in the regular product backlog.
