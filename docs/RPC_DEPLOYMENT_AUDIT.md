# RPC Deployment Audit — Phase G operational surface

_Track 1.1 deliverable. Source-of-truth scan: `admin-panel/src/components/infrastructure/PhaseGPanels.jsx` and `admin-panel/src/components/infrastructure/*.jsx`, cross-referenced against every `CREATE OR REPLACE FUNCTION` in `supabase/migrations/`._

## Method

1. Enumerated every `supabase.rpc('…')` call in the admin panel and mobile app sources.
2. Enumerated every `CREATE … FUNCTION` definition in `supabase/migrations/0*.sql`.
3. Computed the symmetric difference, then graded each gap:
   * **MISSING** — no definition anywhere.
   * **PARTIAL** — definition exists but does not match the dashboard contract (wrong shape / wrong args / no admin gate).
   * **PLACEHOLDER** — definition is a stub or returns NULL.
   * **OK** — deployed and contract-correct.
4. Verified each definition for: `SECURITY DEFINER`, search-path hardening, admin gate, audit logging on mutations.

## Findings (pre-049)

| RPC | Status | Caller | Notes |
| --- | --- | --- | --- |
| `get_queue_health` | OK | QueueOperationsPanel | Migration 047 |
| `get_dead_letter_summary` | OK | QueueOperationsPanel | Migration 047 |
| `admin_clear_completed_jobs` | OK | QueueOperationsPanel | Audited, admin-gated |
| `admin_retry_failed_jobs` | OK | QueueOperationsPanel | Audited |
| `admin_replay_dead_letter` / `_bulk` | OK | QueueOperationsPanel | Audited |
| `get_rss_worker_health` | OK | RssWorkerPanel | Migration 047 |
| `get_rss_feed_health` | OK | RssWorkerPanel | Migration 047 |
| `admin_retry_feed` / `admin_set_feed_active` / `admin_force_release_feed_lease` | OK | RssWorkerPanel | Audited |
| `get_notification_pipeline_health` | OK | NotificationHealthPanel | Migration 047 |
| `admin_send_test_notification` | OK | NotificationHealthPanel | Audited |
| `get_personalization_pipeline_health` | OK | PersonalizationHealthPanel | Migration 047 |
| `get_ranking_pipeline_health` | OK | RankingHealthPanel | Migration 047 |
| `get_cron_job_health` / `get_missing_expected_cron_jobs` / `get_pg_cron_status` | OK | CronHealthPanel | Migration 047 |
| `get_activation_readiness` | OK | Infrastructure overview | Migration 047 |
| `get_feature_flag_impact` / `admin_update_feature_flag` / `admin_emergency_disable_feature_flag` | OK | FeatureFlagsPanel | Audited |
| `get_production_health_snapshot` | **MISSING** | PhaseGPanels → ProductionHealthPanel | Dashboard rendered placeholder "RPC not yet wired." |
| `list_deployment_sessions` | **MISSING** | PhaseGPanels → DeploymentsPanel | Empty state |
| `list_incident_history` | **MISSING** | PhaseGPanels → IncidentsPanel | Empty state |
| `acknowledge_incident` | **MISSING** | PhaseGPanels → IncidentsPanel | Mutation button silently 404'd |
| `resolve_incident` | **MISSING** | PhaseGPanels → IncidentsPanel | Mutation button silently 404'd |
| `get_rollout_timeline` | **MISSING** | PhaseGPanels → RolloutTimelinePanel | Empty state |
| `get_feed_quality_snapshot` | **MISSING** | PhaseGPanels → FeedQualityPanel | Empty state |
| `get_monetization_snapshot` | **MISSING** | PhaseGPanels → MonetizationPanel | Empty state |
| `get_seo_health_snapshot` | **MISSING** | PhaseGPanels → SeoHealthPanel | Empty state |
| `get_mobile_release_readiness` | **MISSING** | PhaseGPanels → MobileReleasePanel | Empty state |
| `get_compliance_audit` | **MISSING** | PhaseGPanels → CompliancePanel | Empty state |
| `get_recovery_center_snapshot` | **MISSING** | PhaseGPanels → RecoveryCenterPanel | Empty state |
| `emergency_rollback` | **MISSING** | PhaseGPanels → RecoveryCenterPanel | Mutation button silently 404'd |
| `simulate_restore` | **MISSING** | PhaseGPanels → RecoveryCenterPanel | Mutation button silently 404'd |

### Additional contract gaps demanded by the directive but not yet wired anywhere

| RPC | Purpose | Status |
| --- | --- | --- |
| `get_backup_status` | Compact backup health for command center | MISSING |
| `get_launch_readiness` | Aggregated launch-decision payload | MISSING |
| `get_system_health_score` | Headline score for ops dashboards | MISSING |
| `get_security_compliance_summary` | Compact compliance summary | MISSING |

## Security review of existing RPCs

* `_is_admin_caller` and `_log_admin_action` are correctly defined in 047.
* All existing admin-gated RPCs `SET search_path = public, pg_catalog`.
* No RLS-bypass surface is exposed to the client (only RPCs).
* No mutating RPC short-circuits the audit step.

## Resolution

Migration **`049_phase_g_rpc_wiring.sql`** lands every MISSING entry above. All new RPCs:

* are `SECURITY DEFINER` with `SET search_path = public, pg_catalog`
* are gated by `_is_admin_caller()` and audit every mutation via `_log_admin_action()`
* use `_phaseg_relation_exists()` to detect optional Phase G tables and degrade gracefully when absent
* return structured `jsonb` (or typed `RETURNS TABLE`) shapes matching the dashboard's expectations
* are additive only — no DDL on existing tables, no destructive drops
* are idempotent (`CREATE OR REPLACE` everywhere, `IF NOT EXISTS` not needed because no DDL)

Re-running this audit after applying 049 shows zero MISSING entries and zero PARTIAL entries. See `DASHBOARD_OPERATIONAL_VALIDATION.md` for the end-to-end verification.
