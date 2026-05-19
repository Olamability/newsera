# Deployment Runbook

This runbook is enforced by `workers/deployment/releaseOrchestrator.ts`. Every release session walks through these stages in strict order; any stage may halt the release without manual intervention.

## Stages

```
PLANNED → PREFLIGHT → MIGRATING → DEPLOYING → VERIFYING → STABILIZED
                                                         ↘ ROLLED_BACK
                                                         ↘ FAILED
```

| Stage | Actions | Halt conditions |
|---|---|---|
| **PLANNED** | record manifest, generate sessionId, compute build fingerprint | duplicate-fingerprint redeploy within 10 min |
| **PREFLIGHT** | run `releaseValidator`: migrations applied, flag-dependency graph acyclic, no SEVERE open incidents, environment diff acceptable | any `blocker` finding |
| **MIGRATING** | host applies declared migrations; orchestrator records | host raises error |
| **DEPLOYING** | rolling restart per worker pool | autoscaler/worker probe failure |
| **VERIFYING** | host pushes `VerificationProbeSnapshot` (health score, queue latency, error spike, notification failure pct, ranking freshness, mobileReady) | health score < 0.85 or `coordinateMobile && !mobileReady` |
| **STABILIZED** | promote rollout, write lineage row, release lock | — |

## Operator workflow

1. **Open a session** (Infrastructure → Deployments tab → "New release") capturing the build fingerprint, declared migrations, flag manifest, initiator, and reason.
2. **Preflight** — review validator findings. Resolve every `blocker` before proceeding.
3. **Migrations** — apply declared migrations via your usual Supabase CLI flow. Re-pull applied migrations and re-run preflight if anything changes.
4. **Deploy** — host rolls workers; orchestrator records the timestamp.
5. **Verification window** — wait at least 10 minutes; the host pushes verification probes every 60 s. If health < 0.85 the orchestrator auto-rolls back.
6. **Stabilize** — promote the session. Lineage now points from the previous stable session → new session.

## Rollback

* Automatic: triggered by orchestrator when verification fails.
* Manual: Infrastructure → Recovery Center → "Emergency rollback". Requires audit reason. Writes to `admin_audit_log`.
* Effect: orchestrator marks session `ROLLED_BACK`, lineage links `rolledBackBySessionId` → previous session. Feature flags must be reverted manually via Flags tab (rollback is metadata-only; it does not toggle flags).

## Replay protection

The same build fingerprint cannot be deployed twice within `replayWindowMs` (default 10 min). A second attempt is recorded but marked `replay_blocked=true` in its event log and rejected at preflight.

## Production freeze

Operators may toggle production freeze via the dashboard. While frozen:
* No new non-dry-run sessions advance past preflight.
* Dry-runs are still allowed for validation purposes.
* Active sessions in MIGRATING/DEPLOYING/VERIFYING are unaffected.

## Blue/green parity

`environmentDiff(source, target)` produces a structured diff comparing flags, migrations, cron jobs, and markers. Run this before any swap:
* `isParity === true` → safe to swap.
* Any non-parity field requires an explicit override; the orchestrator captures the diff in the session event log.

## Acceptance criteria for "deployment success"

* Stage = `STABILIZED`
* `healthScore ≥ 0.85` for at least 10 consecutive minutes
* No new SEVERE incidents introduced
* Mobile compatibility report ok (or `coordinateMobile=false`)
* Compliance audit unchanged or improved
