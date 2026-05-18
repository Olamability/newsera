# Activation Matrix

_The structural readiness matrix for NewsEra subsystem cutover. Live values are emitted by `get_activation_readiness()`; this document captures the static contract — which dependency must be green for each subsystem, and what "rollout safe" means._

| Subsystem            | Ready when                                                                                                          | Blocked by                                                                                                | Rollout safe when                                                                              | Feature flag                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| **rss_workers**      | ≥1 alive `worker_heartbeats` row in last 3 min **and** ≥1 active feed in `rss_feed_sources`                         | `no_live_worker_heartbeats` / `no_active_rss_feeds`                                                       | No feed has `consecutive_failures ≥ 5`                                                          | `queue_based_ingestion`               |
| **notifications**    | ≥1 device with a non-null `push_token`                                                                              | `no_registered_devices` / `no_devices_with_push_token`                                                    | Token coverage ≥ 50 % of registered devices, no duplicate tokens, retry pipeline drains failures | `backend_notification_dispatch`       |
| **personalization**  | ≥1 user has rows in `user_category_affinity`                                                                        | `no_user_affinity_data_yet`                                                                               | ≥ 50 users have category affinity (statistically meaningful rollout sample)                     | `personalization_v1`                  |
| **ranking**          | `ranked_feed_global` non-empty                                                                                       | `ranked_feed_global_empty_refresh_needed`                                                                 | ≥ 50 rows in `ranked_feed_global` and view freshness < 30 min                                  | `ranking_v1`                          |
| **breaking_feed**    | Inherits ranking readiness — `ranked_feed_global` non-empty                                                          | `depends_on_ranking_subsystem`                                                                            | Same as ranking                                                                                | `breaking_feed_v1`                    |
| **retention_cleanup**| `pg_cron` installed **and** zero missing expected cron jobs                                                          | `pg_cron_not_installed` / `missing_cron_jobs:N`                                                           | All retention jobs registered **and** DLQ unreplayed backlog < 100                              | _(implicit — no flag)_                |

## Composite flag: `worker_heartbeats_required`

Not a subsystem but an operational guard. Should only be set **after** `rss_workers` is rollout-safe (otherwise it blocks lease acquisition for an unhealthy fleet and creates a self-induced outage).

## How to read this matrix

- `ready` is binary — the subsystem is structurally capable of being turned on.
- `rollout_safe` is the recommended pre-condition for moving past 1 % rollout. A subsystem can be `ready=true, rollout_safe=false` — that means a 1 % canary is acceptable but full rollout is not yet warranted.
- Always check the dashboard's Overview tab for the current live values; static documentation is a guide, not a substitute.

## Mapping to flags

| Flag                              | Subsystem(s) gated         | Default state | Recommended progression                                       |
| --------------------------------- | -------------------------- | ------------- | ------------------------------------------------------------- |
| `queue_based_ingestion`           | rss_workers                | OFF           | 0 → 1 → 10 → 50 → 100 % as worker fleet proves stable          |
| `backend_notification_dispatch`   | notifications              | OFF           | 0 → 1 → 5 → 25 → 100 % gated on token coverage + retry health |
| `personalization_v1`              | personalization            | OFF           | 0 → 1 → 5 → 25 → 100 % gated on affinity coverage              |
| `ranking_v1`                      | ranking                    | OFF           | 0 → 1 → 10 → 50 → 100 % once MVs are populated & refreshed     |
| `breaking_feed_v1`                | breaking_feed (⊆ ranking)  | OFF           | Only after `ranking_v1` is at 100 %                            |
| `worker_heartbeats_required`      | operational guard          | OFF           | Only after rss_workers is rollout_safe                         |
