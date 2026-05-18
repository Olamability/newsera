# Infrastructure foundation (migrations 039–045)

This directory adds the **schema-first foundation** for the platform's queue,
worker, notification, personalization, ranking, and scaling subsystems. All
migrations are additive, idempotent, and gated behind feature flags so the
legacy paths continue to operate unchanged until each new pipeline is enabled.

## Migration map

| File | Purpose |
| --- | --- |
| `039_queue_and_job_orchestration_foundation.sql` | Canonical `job_queue` + `job_dead_letter` tables; lease-based `enqueue_job` / `lease_jobs` / `complete_job` / `fail_job` / `heartbeat_job` / `reap_expired_job_leases` / `replay_dead_letter` RPCs. Supports `ingestion`, `notification`, `ranking`, `analytics` queues with exponential backoff and idempotent dedup. |
| `040_rss_worker_health_and_feed_reliability.sql` | Extends `rss_feed_sources` and `ingestion_jobs` with health/lease columns. Adds `worker_heartbeats` table + `worker_heartbeat` / `mark_stale_workers_crashed` RPCs. Provides `record_feed_ingestion_outcome` (EMA reliability + exponential backoff) and `lease_due_feeds` / `release_ingestion_job` for distributed RSS workers. |
| `041_notification_dispatch_pipeline.sql` | Extends canonical `notifications` with `type` / `priority` / `channel` / `payload` / `event_id` / `dedup_key`. Adds `notification_events`, `notification_deliveries`, `notification_rate_limits`. RPCs: `enqueue_notification_event`, `materialize_notification_event` (broadcast/category/specific-user fanout), `record_notification_delivery`, `check_notification_rate_limit`, `get_notification_unread_count`. |
| `042_personalization_scoring_materialization.sql` | `user_category_affinity` and `user_source_affinity` tables. `recompute_user_affinity` applies decay-weighted signals (clicks/reads/bookmarks/reactions/shares; half-life 14d) with safe text/uuid cast for legacy `article_clicks.user_id`. Backed by `personalization_recompute_queue` and `process_pending_personalization`. |
| `043_ranking_pipeline_materialized_feeds.sql` | `ranked_feed_global` and `ranked_feed_category` materialized views (engagement × source reliability × freshness decay × diversity). `ranked_feed_breaking` view (recent + click velocity). `ranked_feed_personalized` per-user cache. `refresh_ranked_feeds` / `refresh_personalized_feed_for_user` / `refresh_active_users_personalized_feeds`. |
| `044_scaling_indexes_retention_and_realtime_scoping.sql` | Additional pagination/feed indexes. Retention RPCs (`cleanup_job_queue`, `cleanup_job_dead_letter`, `cleanup_notification_events`, `cleanup_notification_deliveries`, `cleanup_worker_heartbeats`, `cleanup_stale_personalized_feeds`). pg_cron schedules for refresh + cleanup + lease reaping. Adds `notifications` to the realtime publication; does **not** add queue/delivery tables to avoid over-broadcasting. |
| `045_cutover_flags_and_rollback_guards.sql` | `feature_flags` table with deterministic per-user bucketing via `is_feature_enabled_for_user`. Seeds the canonical flags `queue_based_ingestion`, `backend_notification_dispatch`, `personalization_v1`, `ranking_v1`, `breaking_feed_v1`, `worker_heartbeats_required` — all **default OFF** for safe staged cutover. |

## Cutover sequence (per subsystem)

1. **Apply migrations** — all 7 are additive and safe to run in production.
2. **Backfill / warm caches** — call refresh RPCs once manually to populate.
3. **Enable shadow mode** — point workers at new RPCs without flipping flags.
4. **Flip flag with rollout %** — `UPDATE feature_flags SET enabled=true, rollout_percent=10 WHERE name='...';`
5. **Validate parity** — compare ranked feed output, delivery success rates, latency.
6. **Ramp to 100 %**.
7. **Retire legacy path** in a follow-up migration after stable burn-in.

## Rollback

For each subsystem, set the corresponding `feature_flags.enabled = false`. All
legacy code paths remain intact, and no destructive changes are made to existing
tables. Materialized views and worker tables can be dropped via reverse
migrations if necessary; the canonical schema (articles, sources, categories,
notifications, user_devices, user_interests, user_preferences) is untouched.

## pg_cron schedule (installed by 044)

| Job | Cadence |
| --- | --- |
| `reap_expired_job_leases_1m` | every 1 min |
| `mark_stale_workers_crashed_2m` | every 2 min |
| `refresh_ranked_feeds_5m` | every 5 min |
| `process_pending_personalization_1m` | every 1 min |
| `refresh_active_personalized_15m` | every 15 min |
| `cleanup_job_queue_daily` | daily 03:15 |
| `cleanup_job_dead_letter_weekly` | weekly Sun 03:30 |
| `cleanup_notification_events_daily` | daily 03:45 |
| `cleanup_notification_deliveries_d` | daily 03:50 |
| `cleanup_worker_heartbeats_daily` | daily 03:55 |
| `cleanup_personalized_feeds_daily` | daily 04:05 |
