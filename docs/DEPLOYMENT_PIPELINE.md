# Deployment Pipeline

_Track 2.2 deliverable. Production-grade flows for every shippable component. Strictly operational — no new infrastructure is introduced; this document codifies how the existing pieces are wired together._

## Components and their release units

| Component | Release unit | Mechanism |
| --- | --- | --- |
| Database schema | Numbered SQL migration (`supabase/migrations/NNN_*.sql`) | `supabase db push` (or `psql -f`) in numeric order |
| RSS worker / queue runner / notification runner | Node service | PM2 via `ecosystem.config.js` on the VPS |
| Admin panel | Static SPA | `vite build` → `dist/` → Vercel deploy |
| Mobile app | Expo binary | EAS Build → store submission |
| Cron schedule | Inside the DB (pg_cron) | Materialised by `_cron_*` helpers in migration 046 |

## Universal release invariants

Every release, regardless of component, satisfies:

1. **Rollback-safe**: previous release artefact is retained; rollback target is documented before deploy starts.
2. **Migration ordering validation**: migrations are applied strictly in ascending numeric order; out-of-order numbering fails the deploy.
3. **Deployment freeze support**: the `production_freeze` feature flag is honoured by deployment scripts — the script refuses to deploy when the flag is enabled unless `--force-freeze-override` is passed (audited).
4. **Dry-run support**: every deploy script accepts `--dry-run`, prints the plan, exits 0, mutates nothing.
5. **Verification stage**: post-deploy, a verification script calls `get_launch_readiness()` and fails if `ready === false`.
6. **Health-check stage**: post-deploy, calls `get_production_health_snapshot()` and fails if `classification === 'critical'`.
7. **Post-deploy validation**: `pnpm test:queue` (RSS engine) and a synthetic article ingest are run against staging before promoting to production.
8. **Deployment fingerprinting**: every release is fingerprinted as `sha256(git rev-parse HEAD || migration count || release channel)` and recorded in `deployment_sessions` (when the table exists) and in `admin_audit_log` always.
9. **Replay-safe releases**: re-running a deploy with the same fingerprint is a no-op (idempotent migrations + identical artefact hash).

## Component flows

### A. Database migrations

```
1. Verify branch is clean and tests pass.
2. Confirm next migration number is consecutive (no gaps).
3. Apply to STAGING:
     for f in supabase/migrations/*.sql; do
       psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f "$f"
     done
4. SELECT * FROM get_launch_readiness();  -- staging
5. If ready, repeat on PRODUCTION inside a release-window with
   feature_flags.production_freeze respected.
6. Record fingerprint in deployment_sessions.
```

* Migrations are **additive only**. No destructive `DROP TABLE` / `ALTER TABLE … DROP COLUMN` on populated tables.
* Every new function uses `CREATE OR REPLACE`; every new table uses `CREATE TABLE IF NOT EXISTS`; every new index uses `CREATE INDEX IF NOT EXISTS`.
* Migration scripts MUST end without leaving open transactions.

### B. RSS workers / queue runner / notification runner

```
1. ssh deploy@$VPS
2. cd /srv/newsera && git fetch && git checkout <tag>
3. corepack pnpm install --frozen-lockfile
4. pm2 reload ecosystem.config.js --env production --update-env
5. pm2 logs --lines 200    # smoke
6. Verify get_queue_health() shows no spike in 'failed'
```

* PM2 reload performs a zero-downtime cluster swap.
* Workers heartbeat every 30s into `worker_heartbeats`; if no heartbeat after reload + 2 min, **abort** and `pm2 reload --revert` to the last known-good.

### C. Admin panel

```
1. cd admin-panel && pnpm install --ignore-workspace --frozen-lockfile
2. pnpm run build       # vite -> dist/
3. vercel deploy --prod dist/   (or rsync to static host)
4. Open /infrastructure → verify all 10 Phase G tabs render real data
   (see DASHBOARD_OPERATIONAL_VALIDATION.md)
```

* Build is fully deterministic; the same commit produces the same fingerprint.
* `VITE_*` env is baked into the bundle — confirm the right Supabase URL is used.

### D. Mobile app

See **MOBILE_LAUNCH_APPROVAL.md** for the binary-level checklist. The pipeline:

```
1. eas build --platform all --profile production
2. eas submit --platform ios   --latest
3. eas submit --platform android --latest
4. Monitor get_mobile_release_readiness() for crash spikes in the
   first 24h; if recommendation flips to 'hold' → trigger
   emergency_rollback().
```

### E. Cron jobs

* Cron schedules live in migration 046 + 047. Changing a schedule requires a new migration.
* `get_missing_expected_cron_jobs()` and `get_cron_job_health()` are the operator sanity checks.

## Rollback procedure

| Failure mode | Rollback |
| --- | --- |
| Migration error mid-deploy | Stop. Migrations are written to be safely re-runnable; if a single statement fails, fix in a new migration `NNN+1` (don't edit the failed one in place). |
| Worker crash loop after release | `pm2 reload --revert` to the previous PM2 dump. |
| Admin panel regression | Vercel "Promote previous deployment" (one click). |
| Mobile crash spike | `emergency_rollback('mobile crash spike … ')` — this pauses the rollout flag, and the store submission is rolled back via Expo Channel reassignment. |
| Production-wide instability | `emergency_rollback(reason)` then page on-call per the escalation tree in `MASTER_LAUNCH_COMMAND_CENTER.md`. |

## Health-check matrix

After every deploy, the post-deploy validator runs:

```sql
SELECT get_launch_readiness();           -- must be ready=true
SELECT get_production_health_snapshot(); -- classification != 'critical'
SELECT get_queue_health();               -- failure_rate_1h < 0.05 per queue
SELECT get_rss_feed_health();            -- ≥ 90% healthy
SELECT get_cron_job_health();            -- no jobs in 'failing'
```

Any failure stops promotion and writes an `admin_audit_log` row with action `deploy_blocked`.

## Audit lineage

Every deploy writes:

* a `deployment_sessions` row (when the table exists)
* an `admin_audit_log` row with `action='deploy'`, `entity_type='release'`, the fingerprint in `metadata.fingerprint`, and the operator's reason
* the verification RPC outputs into `metadata.verification`

This produces a single source of truth that the Phase G "Deployments" tab consumes via `list_deployment_sessions()`.
