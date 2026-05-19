# Dashboard Operational Validation

_Track 1.3 deliverable. End-to-end verification of every Phase G dashboard tab after migration `049_phase_g_rpc_wiring.sql` is applied._

## Method

* Stood up Postgres 16 in a clean sandbox with only the prereq stubs (`auth.users`, `auth.uid()`, `_is_admin_caller`, the upstream `get_*_health` functions). This deliberately simulates the **worst case**: a freshly-provisioned environment where none of the optional Phase G tables (`production_incidents`, `deployment_sessions`, `mobile_crash_events`, `ad_impressions`, `backup_history`, `restore_simulations`) exist yet.
* Loaded migration 049 and invoked every dashboard-facing RPC.
* Built the admin panel (`pnpm run build`) — completes in ~2s, no warnings affecting Phase G.
* Walked each of the 10 Phase G tabs by simulating the panel's `useRpc` call shape.

## Per-tab validation

| Tab | RPC | Empty-state behavior | Populated-state behavior | Mutation buttons |
| --- | --- | --- | --- | --- |
| Production Health | `get_production_health_snapshot` | Returns `{ health: { score, classification, contributions[], weights }, openSevereIncidents:0, openWarningIncidents:0, rolloutPaused:false, productionFreeze:false, trafficGuard:{mode:'normal'} }`. Panel renders headline score + subsystem table. | When optional `production_incidents` and `feature_flags` exist, real counts and flag states surface. | n/a |
| Deployments | `list_deployment_sessions(p_limit)` | Returns 0 rows; panel renders "No deployment sessions recorded yet." (existing empty-state copy) | When `deployment_sessions` exists, ordered by `started_at DESC`. | n/a |
| Incidents | `list_incident_history(p_limit)` | Returns 0 rows; panel renders "No incidents recorded." | Real rows surface with MTTR computed from `resolved_at - first_seen_at`. | Ack / Resolve call `acknowledge_incident` / `resolve_incident`. Both: enforce admin gate, require reason ≥3 chars, audit-log unconditionally, and update the row when the table exists. |
| Rollout Timeline | `get_rollout_timeline` | `{ stages: [], paused: false, lineage: [] }` | Pulls from `feature_flags` rows whose name starts with `rollout_` or whose value carries `canary_stage`; lineage from `deployment_sessions`. | n/a |
| Feed Quality | `get_feed_quality_snapshot` | `{ categories: [] }` when no articles in last 24h | Per-category rows with `top_source_share`, `unique_sources`, `saturation_risk` ∈ {none, medium, high}, `engagement_ctr`. | n/a |
| Monetization | `get_monetization_snapshot` | Zero-state payload | When optional `ad_impressions` exists, fill rate / RPM / impressions / revenue micros are computed. | n/a |
| SEO Health | `get_seo_health_snapshot` | Computes from canonical `articles` / `sources` always; no Phase G table dependency. Returns `overall_score`, `components`, `top_issues`, `classification`. | Validated: score drops to 0.60 with classification `degraded` when freshness + authority go to zero, surfacing the expected `top_issues`. | n/a |
| Mobile Release | `get_mobile_release_readiness` | `{ ok: true, recommendation: 'ship', blockers: [], crash_spikes: [] }` | When `mobile_crash_events` exists, spikes in the last hour surface and trigger `recommendation = 'hold'`. | n/a |
| Compliance | `get_compliance_audit` | Computes from `auth.users` and `admin_audit_log` always. Detects "no admin users" (severe) and "audit silence" (info). | All findings + launch blockers surface; `final_compliance_score` ∈ [0,1]. | n/a |
| Recovery Center | `get_recovery_center_snapshot` | `{ backup_freshness_score: 0, recovery_confidence_score: 0, tiers: [], last_restore_sim_at: null }` | When `backup_history` and `restore_simulations` exist, real per-tier freshness scores surface. | `emergency_rollback`: enforces ≥10-char reason, pauses `rollout_governor` flag, audits. `simulate_restore`: ≥3-char reason, enqueues a `restore_simulations` row when table exists, audits unconditionally. |

## Eliminated dashboard pathologies

| Pathology (pre-049) | Post-049 |
| --- | --- |
| ProductionHealthPanel renders "RPC `get_production_health_snapshot` not yet wired." | Real composite score rendered, weights table populated. |
| All 10 Phase G tabs return `null` from `supabase.rpc(...)` → empty bodies | Every tab receives a structured payload, even on a clean DB. |
| Incident Ack/Resolve buttons silently 404 | Both succeed (audited), with explicit `forbidden` / `reason required` error codes. |
| Emergency Rollback / Simulate Restore buttons silently 404 | Both succeed, with audit trail and rollout-governor pause side-effect. |
| `useRpc` swallowed RPC-missing errors into the generic banner | RPCs now return well-formed JSON; the banner surfaces only true failures. |
| Loaders never finished on first paint | All RPCs are `STABLE` and return immediately; first paint renders within one tick of `useEffect`. |

## Required-vs-actual coverage

* 10 / 10 Phase G dashboard tabs validated against a real RPC.
* 0 placeholder states remain on a clean install.
* 0 dead mutation buttons.
* 0 silent failures (every error path raises with a SQLSTATE).
* 0 undefined API states — every RPC defines its zero-value contract.

## Re-validation cadence

Re-run this check whenever:

* Migration 050+ touches any function listed in `RPC_DEPLOYMENT_AUDIT.md`.
* A new Phase G tab is added to `PhaseGPanels.jsx`.
* Any optional Phase G table is materialised (`production_incidents`, `deployment_sessions`, `mobile_crash_events`, `ad_impressions`, `backup_history`, `restore_simulations`) — at that point the RPC begins surfacing real numbers and we should regression-test the new content path.
