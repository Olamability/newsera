# Release Execution Checklist

_Track 2.2 deliverable. Operator-facing checklist. Print and sign each release._

> Use one copy of this checklist per release. Initial each item. Do not skip steps.

## T-24h — preparation

- [ ] Release tag cut from `main`; CHANGELOG updated.
- [ ] All open `MUST FIX BEFORE LAUNCH` items in `LAUNCH_BLOCKERS.md` are closed.
- [ ] `get_launch_readiness()` returns `ready: true` against staging.
- [ ] On-call rotation confirmed (primary + backup).
- [ ] Communication channel (`#newsera-launch`) is staffed.
- [ ] Rollback artefact (previous tag + PM2 dump + Vercel previous deploy ID) is recorded.
- [ ] `production_freeze` flag is **off**, or override approval is recorded.

## T-1h — pre-deploy

- [ ] Re-run staging smoke: `pnpm test:queue`, synthetic article ingest, mobile build smoke.
- [ ] Verify backups: `get_backup_status()` → `freshness >= 0.7`, `confidence >= 0.85`.
- [ ] Verify no open SEVERE / CRITICAL incidents (`get_production_health_snapshot()`).
- [ ] Announce go/no-go decision in `#newsera-launch`.

## T-0 — deploy execution

In order, with a 2-minute observation gap between each step.

- [ ] **Database**: apply pending migrations in numeric order.
- [ ] **Verify**: `get_launch_readiness()` against production.
- [ ] **RSS workers / queue / notification runner**: `pm2 reload ecosystem.config.js --env production`.
- [ ] **Smoke**: `get_queue_health()` and `get_rss_feed_health()` show no regression.
- [ ] **Admin panel**: `vercel deploy --prod`.
- [ ] **Smoke**: open `/infrastructure` and walk the 10 Phase G tabs (see `DASHBOARD_OPERATIONAL_VALIDATION.md`).
- [ ] **Mobile**: `eas submit` (only when mobile is in the release).

## T+15m — first observability checkpoint

- [ ] `get_production_health_snapshot()` classification is `healthy`.
- [ ] No new SEVERE incident.
- [ ] Queue failure rate < 5%.
- [ ] Worker heartbeats ≤ 60s old across all workers.

## T+1h — stabilisation checkpoint

- [ ] No regression on engagement CTR (per `get_feed_quality_snapshot()`).
- [ ] Mobile crash rate within 2× baseline.
- [ ] SEO snapshot freshness >= 0.6.

## T+24h — post-launch acceptance

- [ ] No emergency rollback triggered.
- [ ] Compliance audit unchanged (`get_compliance_audit()` final score not down by >0.05).
- [ ] Release fingerprint recorded in `deployment_sessions` and `admin_audit_log`.
- [ ] Retrospective scheduled.

## Rollback trigger criteria (any one triggers an immediate rollback)

- `get_production_health_snapshot()` classification flips to `critical`.
- Queue failure rate > 25% for 5 consecutive minutes.
- Mobile crash spike > 3× baseline for 5 minutes.
- Severe incident opened that maps to the release.
- Operator judgement.

## Rollback procedure

- [ ] Call `emergency_rollback(reason)` (≥10-char reason). This pauses the rollout governor flag and writes an audit row.
- [ ] PM2 `pm2 reload --revert` on the VPS.
- [ ] Vercel "Promote previous deployment."
- [ ] If a migration is the cause, write a new "revert" migration `NNN+1` that restores the prior shape **additively** (never edit the original). Apply, verify with `get_launch_readiness()`, then close the incident with `resolve_incident()`.

## Signatures

| Role | Name | Signed |
| --- | --- | --- |
| Release captain | ____________ | ____________ |
| On-call primary | ____________ | ____________ |
| Reviewer | ____________ | ____________ |
