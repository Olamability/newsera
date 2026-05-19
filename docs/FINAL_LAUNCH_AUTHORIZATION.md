# FINAL LAUNCH AUTHORIZATION

**Project:** Newsera
**Authorization date:** active
**Authorization mode:** STAGED ROLLOUT under feature-flag control

**Status:** ✅ **AUTHORIZED — CODE FREEZE IN EFFECT — TRANSITION TO STAGED ROLLOUT APPROVED**

---

## 1. What this document does

This is the authoritative go/no-go record. It states that every gate in the pre-launch program has been cleared, identifies any blockers (none at this time), names the people responsible during the cutover, and lists the conditions under which the launch may be paused or rolled back.

It supersedes any earlier launch document for the purpose of cutover authorization.

---

## 2. Gating evidence

| Gate | Document | Result |
|---|---|---|
| Codebase audit | `docs/FINAL_CODEBASE_AUDIT.md` | ✅ GREEN |
| Database certification (migrations 001–049) | `docs/FINAL_DATABASE_CERTIFICATION.md` | ✅ GREEN |
| Load + resilience validation | `docs/FINAL_LOAD_TEST_REPORT.md` | ✅ GREEN |
| Mobile builds (iOS + Android) | `docs/FINAL_APP_STORE_SUBMISSION_REPORT.md` | ✅ APPROVED |
| Deployment rehearsal (incl. rollback + restore drills) | `docs/DEPLOYMENT_REHEARSAL_REPORT.md` | ✅ PASSED |
| Go-live checklist | `docs/PRODUCTION_GO_LIVE_CHECKLIST.md` | ✅ READY |
| Observability plan | `docs/POST_LAUNCH_OBSERVABILITY_PLAN.md` | ✅ READY |
| First-72h runbook | `docs/FIRST_72_HOURS_RUNBOOK.md` | ✅ READY |
| Known limitations register | `docs/KNOWN_LIMITATIONS_AND_TECH_DEBT.md` | ✅ ACKNOWLEDGED |

---

## 3. Blockers

**None at the time of authorization.**

A blocker is anything from the list in §6 that is RED. Any blocker that surfaces during cutover halts promotion to the next rollout wave.

---

## 4. Operational risks (accepted)

These risks are known and *accepted* (with mitigations) rather than blocked on:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Notification dispatch backlog under viral breaking-news event | Low | Medium | Flag-gated; can flip `backend_notification_dispatch` OFF and drain offline |
| Personalization staleness during a Postgres incident | Medium | Low | Falls back to materialized trending feed (always pre-computed) |
| App-store review delay | Medium | Low | Web (admin panel) is independent; backend serves both web and mobile |
| Single-instance RSS worker (PM2) | Low | Medium | PM2 auto-restart + `max_memory_restart: 500M` + heartbeat |
| Increase in DB cost as personalization scales | Medium | Low | Materialization cadence is feature-flag tunable |

---

## 5. Rollback guidance

**Three tiers — use the lowest one that resolves the incident.**

1. **Tier 1 — Flag flip (seconds):** flip the offending pipeline's feature flag OFF. Legacy path resumes serving. No code change, no data change.
2. **Tier 2 — Code rollback (minutes):** SSH to RSS VPS, `git checkout <PREV_SHA>`, `pm2 reload ecosystem.config.js`. Admin-panel rollback via Vercel previous deployment.
3. **Tier 3 — DB restore (hours, last resort):** restore from the pre-cutover Postgres snapshot taken in pre-flight step P2. Only invoke for data corruption.

Tier 1 is *always* tried first. Per the rehearsal report, Tier 1 covers >95% of foreseen failure modes.

---

## 6. Escalation path

```
On-call engineer
        │  cannot resolve in 10 min
        ▼
Production Reliability Lead  (page)
        │  Sev-2 or worse
        ▼
Release Engineering Lead     (page)
        │  Sev-1
        ▼
Engineering leadership       (call bridge)
        │  customer-impacting >30 min
        ▼
Public status page update + comms lead
```

- **Sev-1** = user-facing service unavailable or data integrity at risk.
- **Sev-2** = degraded performance affecting >10% of requests.
- **Sev-3** = single-feature degradation with workaround.

---

## 7. Staffing during cutover

Minimum on the bridge: **6 roles** (Release Engineering Lead, Production Reliability Lead, Deployment Coordinator, Launch Operations Engineer, QA Validation Lead, DB On-call). See `DEPLOYMENT_REHEARSAL_REPORT.md §1`.

Minimum on-call rotation for the first 72 hours: **2 engineers at all times** (one primary, one shadow), with the Reliability Lead reachable.

---

## 8. Monitoring responsibilities

| Surface | Owner | Cadence |
|---|---|---|
| Admin panel `Infrastructure` dashboard (Phase G panels) | Reliability Lead | continuous during cutover, every 15 min for first 24 h |
| Postgres metrics (Supabase console) | DB on-call | every 15 min for first 24 h |
| PM2 process status | Ops Engineer | every 30 min for first 24 h |
| Mobile crash dashboards (Sentry/EAS) | Mobile lead | every 1 h for first 72 h |
| App-store reviews | Product | every 4 h for first 72 h |

---

## 9. Conditions for promotion between waves

Promotion to the next rollout wave requires **all** of the following to have been GREEN for the dwell time specified in `FINAL_LOAD_TEST_REPORT.md §7`:

- Feed read p95 < 200 ms
- Queue depth < 2k sustained
- Notification backlog < 10k sustained
- Postgres CPU 5-min avg < 60%
- Mobile crash-free sessions ≥ 99.5%
- Dead-letter rate = 0

A single RED metric on any axis pauses promotion and triggers the §6 escalation path.

---

## 10. Code freeze

Effective immediately upon signature of this document, the repository enters **CODE FREEZE**:

- No new feature work merges to `main`.
- Only the following are accepted to `main` during freeze:
  - Sev-1 / Sev-2 hotfixes.
  - Feature-flag flips through admin RPC (no code change).
  - Documentation updates.
- The freeze is held until the 72-hour stabilization window has elapsed GREEN, after which the project transitions to **PRODUCTION MAINTENANCE MODE** (see `FIRST_72_HOURS_RUNBOOK.md §6`).

---

## 11. Authorization

By the evidence above and by the rehearsed cutover sequence, Newsera is **authorized to proceed to staged rollout** under the conditions stated in §9 and §10.

| Signature line | Role |
|---|---|
| _____________________ | Release Engineering Lead |
| _____________________ | Production Reliability Lead |
| _____________________ | Deployment Coordinator |
| _____________________ | Launch Operations Engineer |
| _____________________ | QA Validation Lead |
| _____________________ | Engineering leadership |

**Effective:** upon all signatures above.

**Supersedes:** any earlier launch document for go/no-go purposes.
