# Rollout Recommendation

_Senior-platform-engineer-style guidance for the NewsEra Phase C activation. Based on the structure of migrations `039–046` and the observability/admin layer added in `047` + `/infrastructure`. All "current state" claims are **structural** — they describe whether the code path exists and is gated correctly. Operators must verify **runtime** state via the `/infrastructure` dashboard immediately before flipping any flag._

---

## Can activate now (after runtime green check)

These subsystems have:
1. complete server-side implementation,
2. observability surfaces (dashboard panels + readiness RPC),
3. admin recovery actions,
4. a feature flag with rollout control + emergency disable.

| Subsystem            | Recommended initial rollout       | Pre-flight runtime checklist (from `/infrastructure`)                                   |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| **retention_cleanup**| Implicit (cron-driven)            | Cron Health: pg_cron installed, all 11 schedules present, 0 failures in 24h             |
| **rss_workers**      | `queue_based_ingestion = 1 %`     | RSS Workers: ≥1 alive heartbeat, no crashed workers, top feeds reliability ≥ 0.8        |
| **ranking**          | `ranking_v1 = 1 %`                | Ranking: all 4 views non-empty, `is_stale = false` for global + category                |
| **breaking_feed**    | `breaking_feed_v1 = 1 %` (after ranking) | Ranking row for `ranked_feed_breaking` reports non-zero rows                       |

Move each from 1 % → 10 % → 50 % → 100 % only after observing one full refresh cycle (5–15 min) at each step with no new failures in the Cron/Queue/RSS tabs.

---

## Must remain OFF until evidence accumulates

| Subsystem            | Flag                              | Why it must stay OFF                                                                                  |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **notifications**    | `backend_notification_dispatch`   | Mobile installs need to populate `user_devices.push_token`. Until token coverage ≥ 50 % and the failed-delivery queue is observed to drain via retries, enabling backend dispatch risks silently dropping notifications. The dashboard's "Notification test sender" should be used to validate end-to-end delivery before raising. |
| **personalization**  | `personalization_v1`              | Affinity tables (`user_category_affinity`, `user_source_affinity`) start empty. They only populate after engagement (`clicks`, `reads`, `bookmarks`, `reactions`, `shares`) flows through `recompute_user_affinity`. Enabling early would rank everyone on a zero vector — strictly worse than the legacy `user_interests` path. Target: 50+ users with category affinity before opening to 1 %. |
| **worker_heartbeats_required** | _(operational guard)_   | This flag *blocks* lease acquisition for workers without recent heartbeats. Enabling it before the worker fleet is consistently healthy creates a self-induced outage. Only turn on after `rss_workers` has been at 100 % rollout for ≥24 h with no crashed/stale workers. |

---

## Requires fixes first

| Item                                              | Required fix                                                                                                | Owner       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| pg_cron extension availability                     | Verify Supabase project has `pg_cron` enabled. If not (e.g. local dev), `get_pg_cron_status().pg_cron_installed` will be false and the Cron Health panel will display a banner. All schedule-dependent claims are then **blocked** by definition. | Platform    |
| Worker process deployment                          | The queue/RSS workers must be running externally (e.g. via `ecosystem.config.js` / VPS deployment as described in `docs/rss-vps-deployment.md`) and must call `worker_heartbeat()` regularly. Without this, the RSS Workers tab shows 0 alive — every dependent flag is blocked. | Platform    |
| Duplicate-push-token cleanup                       | If the Notifications panel shows `duplicate_tokens > 0`, run a dedup pass before raising `backend_notification_dispatch` — otherwise users receive multiple copies of every push. | Backend     |
| Affinity bootstrap                                 | Enqueue an initial `recompute_user_affinity` pass for active users via `enqueue_personalization_recompute` (or rely on cron `process_pending_personalization_1m` driven by engagement triggers) so the personalization tables populate before rollout. | Backend     |
| DLQ triage                                         | If `get_dead_letter_summary().unreplayed_count` is non-zero for any queue, inspect payloads via the Queue Operations tab and confirm the underlying cause is fixed *before* using `admin_replay_dead_letter_bulk` — otherwise replays will fail again and the DLQ grows. | On-call     |

---

## Recommended activation sequence

1. **Verify observability layer itself** — open `/infrastructure`, ensure every tab loads without RPC errors (proves migration 047 applied and RLS allows admin reads).
2. **Bootstrap cron** — confirm pg_cron is installed and all 11 schedules registered. If not, do nothing else until fixed.
3. **Bring up worker fleet** — confirm `rss_ingestion` worker(s) report `alive_count ≥ 1`.
4. **Raise `queue_based_ingestion`** in 1 % → 10 % → 50 % → 100 % steps, watching the Queue tab between steps.
5. **Manually trigger `refresh_ranked_feeds()`** once, then verify the Ranking tab shows non-empty, fresh views.
6. **Raise `ranking_v1`** in 1 % → 10 % → 50 % → 100 % steps.
7. **Raise `breaking_feed_v1`** to 100 % after ranking is at 100 %.
8. **Backfill affinity** for active users, then raise `personalization_v1` in 1 % → 5 % → 25 % → 100 % steps.
9. **Verify notification token coverage**, send a test notification, then raise `backend_notification_dispatch` in 1 % → 5 % → 25 % → 100 % steps.
10. **Only after 24 h of stable worker fleet** — raise `worker_heartbeats_required` to lock out unhealthy workers from lease acquisition.

At any step, the **Emergency disable** button on the Feature Flags tab resets the flag to `enabled=false, rollout_percent=0` and audits the action. Rollback is a single click.

---

## What this rollout layer explicitly does **not** do

- **Does not auto-activate any flag.** Every flag is opt-in. The dashboard's role is to make the operator confident, not to decide for them.
- **Does not bypass RLS.** Admin actions are SECURITY DEFINER but re-check the admin role via `_is_admin_caller()`. There is no service-role secret in the frontend bundle.
- **Does not drop legacy tables.** Migrations 038 (deprecate) and 044 (cutover guards) remain authoritative; this phase adds no destructive DDL.
- **Does not break the mobile app.** All new RPCs are additive. Existing query patterns continue to work; new ones are exposed only via the feature flags above.
