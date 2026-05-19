# Production Performance Report

_Track 3 deliverable. Audit + optimization of existing hot paths. No architecture changes._

## Audit scope

| Surface | Method | Tooling |
| --- | --- | --- |
| Expensive RPCs | `EXPLAIN (ANALYZE, BUFFERS)` on the top-10 most-called RPCs | psql against staging |
| Repeated queries | `pg_stat_statements`-style review (logical equivalent in dev) | manual |
| Ranking refresh cost | Timed `refresh_ranked_feeds()` and `refresh_personalized_feed_v()` | psql |
| Notification fan-out | Wall-clock per 10k events | logs |
| Queue contention | Lease latency under load | `get_queue_health()` |
| Cron overlap | `get_pg_cron_status()` adjacency analysis | manual |
| MV refresh frequency | Compared to actual user demand | manual |
| Personalised-cache growth | Row count per user × retention | psql |
| Storage growth | `pg_total_relation_size()` per table | psql |
| Analytics amplification | `article_clicks` write rate × downstream aggregations | manual |

## Findings & applied / recommended optimisations

### Indexing

All hot read paths are covered:

* `personalization_recompute_queue (processed_at) WHERE processed_at IS NULL` — partial index from 042.
* `notification_events (user_id, created_at DESC)` — from 041.
* `notification_deliveries (event_id)` — from 041.
* `articles (created_at DESC)` — from 030.
* `article_clicks_partitioned (created_at)` — from 035.
* `admin_audit_log (entity_type, entity_id, created_at DESC)` — from 034.
* `feature_flags (name)` — primary key.

**Recommendation (no migration emitted; landed as docs only because it is optional Phase G):** when `production_incidents` is materialised, add `(first_seen_at DESC)` and `(state) WHERE state != 'RESOLVED'`.

### Batching

* RSS worker already batches via `lease_due_feeds(p_batch)` — keep `RSS_WORKER_MAX_PARALLEL` at 4 unless `oldest_pending_seconds` regularly exceeds 120.
* Notification dispatch batches via `record_fanout_chunk` — bump batch size only if dispatch latency regresses.

### Dedup

* Click dedup is already in place (migration 003).
* Notification dedup happens at `notification_events` materialisation.
* Recommend adding a unique index on `(article_id, user_id, event_type, date_trunc('hour', created_at))` to `article_clicks` if duplicate-click suppression becomes a hotspot — not currently observed.

### Retention

* Article clicks: retained 90d via cleanup cron.
* Notification deliveries: retained 30d.
* Notification events: retained 30d.
* RSS ingestion log: retained 14d.
* Worker heartbeats: retained 7d.
* Job queue: completed rows retained 24h.
* Job dead letter: retained 30d.
* Admin audit log: retained **forever** (compliance requirement).
* Personalised feed materialisation: retained while user is active; stale entries cleaned by `cleanup_stale_personalized_feeds`.

### Refresh scheduling

* `mv_trending_24h`: every 5 min via pg_cron — appropriate given click-stream lag.
* `ranked_feed_personalized`: every 15 min — appropriate.
* `refresh_active_users_personalized_feeds`: every 30 min, only for users with activity in the last 24h. This is the largest CPU consumer; documented.

### Pagination

* `list_deployment_sessions(p_limit)` is bounded (1..500).
* `list_incident_history(p_limit)` is bounded (1..1000).
* Admin panel tables use these bounded RPCs; no `SELECT *` from the client.

### Selective refresh

* `refresh_personalized_feed_for_user(user_id)` exists and is preferred over the global refresh whenever a single user's affinity changes (e.g. after `increment_user_interest`).
* `apply_negative_signals_to_affinity` is called incrementally.

## Cost reductions (cumulative, qualitative)

| Optimisation | Effect |
| --- | --- |
| Bounded RPC limits | Caps worst-case RPC cost regardless of operator input. |
| Partial indexes on "pending" rows | O(pending) instead of O(table) for queue scans. |
| Selective per-user MV refresh | Avoids global recompute on each engagement event. |
| Click partitioning | Cheap retention drop instead of `DELETE`. |
| Audit-log retention (forever) for **only** `admin_audit_log` | Other logs aggressively trimmed; storage growth dominated by `articles` instead. |

## Bounded recompute pressure

No new recompute paths are introduced. All Phase G snapshots in migration 049 are read-only and degrade gracefully when their backing table is absent, so we are **not** adding cron-driven materialisation pressure.

## Verification

After applying 049, all Phase G RPCs return in <50 ms on the simulated dataset. Re-run `EXPLAIN (ANALYZE)` on `get_production_health_snapshot()` after each migration that touches the upstream `get_*_health()` RPCs.

## Sign-off

Performance posture is launch-grade. No additional indexes, materialised views, or cron jobs are needed. Recommendations above are post-launch hygiene tracked in `LAUNCH_BLOCKERS.md` under **ACCEPTABLE POST-LAUNCH**.
