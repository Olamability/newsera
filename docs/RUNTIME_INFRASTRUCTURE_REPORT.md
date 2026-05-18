# Runtime Infrastructure Report

_Phase C activation readiness — generated as part of migration 047 + the `/infrastructure` admin dashboard._

This report describes how each subsystem of NewsEra should be verified at runtime before its feature flag is raised. It is the operator-facing summary of what the `/infrastructure` dashboard exposes and what `get_activation_readiness()` returns.

> **All claims in this document are runtime-derived.** Live values come from the helper RPCs shipped in migrations `046_cron_health_helpers.sql` and `047_activation_observability_and_admin_ops.sql`. This file describes the *check*, *source of truth*, and the *pass criteria* — actual pass/fail must be read from the dashboard at the time of activation.

---

## 1. Cron / scheduling

| Check                                       | Source                                               | Pass criteria                                                  |
| ------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `pg_cron` installed                         | `get_pg_cron_status()` (mig. 046)                    | `pg_cron_installed = true`                                     |
| `cron` schema readable                      | `get_pg_cron_status()`                               | `job_table_readable = true`                                    |
| All 11 expected schedules registered        | `get_missing_expected_cron_jobs()`                   | empty result set                                               |
| No job failed in the last 24h               | `get_cron_job_health().failures_24h`                 | every row reports `0`                                          |
| No job has a stale execution window (>6h)   | `get_cron_job_health().last_run`                     | every row ran within its schedule                              |

**Expected schedules** (defined in `044_scaling_indexes_retention_and_realtime_scoping.sql`):
`reap_expired_job_leases_1m`, `mark_stale_workers_crashed_2m`, `refresh_ranked_feeds_5m`, `process_pending_personalization_1m`, `refresh_active_personalized_15m`, `cleanup_job_queue_daily`, `cleanup_job_dead_letter_weekly`, `cleanup_notification_events_daily`, `cleanup_notification_deliveries_d`, `cleanup_worker_heartbeats_daily`, `cleanup_personalized_feeds_daily`.

**Failure modes surfaced by the dashboard**: pg_cron missing, schema drift, repeated failures, stale execution windows. Each renders an explicit warning banner.

---

## 2. Queue orchestration (`job_queue` + `job_dead_letter`)

| Signal                                  | Source                                          | Healthy when                            |
| --------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| Pending depth per queue                 | `get_queue_health().queued_count`               | ≤ 100 sustained                         |
| Oldest pending job age                  | `get_queue_health().oldest_pending_seconds`     | ≤ 600 s (10 min)                        |
| Failed jobs                             | `get_queue_health().failed_count`               | = 0 (or trending to 0 after retries)    |
| Dead-letter queue                       | `get_queue_health().dead_count` + `get_dead_letter_summary()` | unreplayed_count low; replay channel drained |
| Failure rate (last hour)                | `get_queue_health().failure_rate_1h`            | < 10 %                                  |
| Throughput trend                        | `get_queue_health().throughput_1h` / `_24h`     | non-zero when workers active            |
| Avg lease/execution duration            | `get_queue_health().avg_lease_seconds`          | < lease deadline (60 s for most queues) |

**Admin recovery actions** (audited via `admin_audit_log`):
- `admin_replay_dead_letter` / `admin_replay_dead_letter_bulk`
- `admin_retry_failed_jobs`
- `admin_clear_completed_jobs`

The dashboard "Job inspector" tab allows payload drill-down per row.

---

## 3. RSS workers + feed reliability

| Signal                                  | Source                                            | Healthy when                                    |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Live worker heartbeats                  | `get_rss_worker_health().alive_count`             | ≥ 1 for `rss_ingestion`                         |
| Crashed workers                         | `get_rss_worker_health().crashed_count`           | = 0                                             |
| Stale (alive without heartbeat ≥3 min)  | `get_rss_worker_health().stale_count`             | = 0                                             |
| Per-feed reliability                    | `get_rss_feed_health().reliability_score`         | ≥ 0.8 for active feeds                          |
| Failure streak                          | `get_rss_feed_health().failure_streak`            | < 3 for active feeds                            |
| Stale lease (>30 s past `leased_until`) | `get_rss_feed_health().lease_is_stale`            | = `false` for all rows                          |
| Backoff                                 | `get_rss_feed_health().backoff_seconds`           | 0 on healthy feeds                              |

**Concurrency safety guarantees** (already in place):
- *No double lease acquisition* — `lease_due_feeds` uses `FOR UPDATE SKIP LOCKED` and the `idx_job_queue_dedup_active` unique partial index.
- *Concurrent duplicate ingestion blocked* — `ingestion_jobs.feed_id` is `UNIQUE`; `lease_due_feeds` upserts.
- *Stale lease deadlock recovery* — automatic via `reap_expired_job_leases` cron + manual via `admin_force_release_feed_lease`.

**Admin recovery actions** (audited):
- `admin_retry_feed` (force `next_fetch_at = now()`)
- `admin_set_feed_active` (pause/resume)
- `admin_force_release_feed_lease`

---

## 4. Notification pipeline

| Signal                                  | Source                                                   | Healthy when                              |
| --------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| Devices registered                      | `get_notification_pipeline_health().total_devices`       | > 0                                       |
| Devices with valid Expo token           | `.devices_with_token` / `.total_devices` ≥ 50 %          | true                                      |
| Duplicate tokens                        | `.duplicate_tokens`                                      | = 0                                       |
| Event dedup correctness                 | enforced by `idx_notification_events_dedup_pending` and `idx_notifications_user_dedup_unique` | structural — verified by migration |
| Pipeline backlog                        | `.events_pending` / `.deliveries_pending`                | low and trending down                     |
| Failure rate (24h)                      | `.events_failed_24h` / `.deliveries_failed_24h`          | small; retries drain                      |
| Rate limiting working                   | `.rate_limited_users_24h`                                | non-zero is *good* — it proves enforcement |
| Unread count correctness                | `get_notification_unread_count()` matches `.unread_total` | sanity-check via test sender             |

**Validation flow before raising `backend_notification_dispatch`:**
1. Verify token coverage in dashboard (Notifications tab → "Device token validator").
2. Inspect "Failed deliveries" — confirm retries/backoff are visible in attempts column.
3. Use `admin_send_test_notification` against a known admin user UUID; confirm inbox + push arrive and unread count increments.
4. Only then raise the flag percentage (start at 1 %).

---

## 5. Personalization pipeline

| Signal                                  | Source                                                          | Healthy when                                    |
| --------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| Users with category affinity            | `get_personalization_pipeline_health().users_with_category_affinity` | ≥ 50 before partial rollout                |
| Recompute queue depth                   | `.recompute_queue_depth`                                        | < 100 sustained                                 |
| Oldest queued recompute                 | `.oldest_recompute_seconds`                                     | < 3600 s                                        |
| Personalized cache coverage             | `.personalized_cache_users`                                     | growing daily                                   |
| Stale cache users (>24h)                | `.stale_cache_users`                                            | = 0 after a `refresh_active_personalized_15m` cycle |

**Algorithmic guarantees already enforced server-side** (migration 043):
- *Already-read exclusion* via `NOT EXISTS user_read_history`.
- *Source diversity penalty* baked into `ranked_feed_global` scoring.
- *Stale-cache cleanup* via `cleanup_personalized_feeds_daily`.

The dashboard provides an **affinity score inspector** for any user UUID.

---

## 6. Ranking pipeline

| Signal                                  | Source                                              | Healthy when                                       |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `ranked_feed_global` rows               | `get_ranking_pipeline_health()`                     | ≥ 50                                               |
| `ranked_feed_category` rows             | as above                                            | non-zero per active category                       |
| `ranked_feed_personalized` rows         | as above                                            | proportional to active users                       |
| Materialized-view freshness             | `is_stale` flag (>30 min for global/category, >6h for personalized) | `false`                            |
| Breaking velocity                       | `ranked_feed_breaking` row count                    | reasonable per recent click data                   |

Refresh schedules:
- `refresh_ranked_feeds_5m` → global + category.
- `refresh_active_personalized_15m` → personalized cache (active users).
- Breaking feed is a plain view, computed on every read.

---

## 7. Performance bottlenecks observed

| Where                           | Symptom on dashboard                              | Mitigation                                            |
| ------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| pg_cron unavailable             | Cron tab banner; readiness row `retention_cleanup` blocked | Treat retention as blocked; do not enable ranking refresh dependencies |
| Worker fleet at 0 alive         | RSS tab banner; readiness row `rss_workers` blocked | Deploy / restart workers before raising `queue_based_ingestion` |
| DLQ unreplayed > 100            | Queue tab — orange "failing" badge                | Investigate root cause before bulk replay; replay drains queue but does not fix the underlying error |
| Stale leases on multiple feeds  | RSS tab → "stale lease" filter                    | Cron `reap_expired_job_leases_1m` handles automatically; if accumulating, increase its run frequency or force-release manually |
| Notification rate-limit cap hit | Notifications tab `rate_limited_users_24h` > 0    | Expected for high-traffic events; investigate only if all users are blocked |

---

## 8. Safety guarantees enforced by this layer

- **No destructive migrations** — `047_activation_observability_and_admin_ops.sql` is purely additive (functions + grants only; no DROP, no schema rewrites).
- **No client writes to orchestration tables** — every mutation lands through a SECURITY DEFINER RPC that re-checks `_is_admin_caller()` and writes to `admin_audit_log`.
- **No RLS bypass** — RPCs delegate to existing service-role primitives instead of issuing direct UPDATEs on RLS-protected tables.
- **No service-role secrets exposed to frontend** — the admin panel uses the anon key + the admin's JWT; service-role privileges remain server-side via SECURITY DEFINER.
- **All admin actions audited** — `admin_audit_log` rows include `action`, `entity_type`, `entity_id`, `reason`, and a `metadata` JSON snapshot of the change.
