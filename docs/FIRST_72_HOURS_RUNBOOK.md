# FIRST 72 HOURS RUNBOOK

**Purpose:** hour-by-hour playbook for the launch stabilization window. After T+72h GREEN, the platform transitions to **PRODUCTION MAINTENANCE MODE**.

**Companion docs:** `PRODUCTION_GO_LIVE_CHECKLIST.md`, `POST_LAUNCH_OBSERVABILITY_PLAN.md`, `FINAL_LAUNCH_AUTHORIZATION.md`.

---

## 0. Staffing

| Window | Roles required online |
|---|---|
| T+0 → T+2h | All 6 cutover roles on the bridge |
| T+2h → T+24h | Primary on-call, secondary on-call, Reliability Lead reachable |
| T+24h → T+72h | Primary on-call, secondary on-call |

Reliability Lead remains the decision-maker for any rollout-wave promotion.

---

## 1. Hour 0 — Cutover complete

Source: `PRODUCTION_GO_LIVE_CHECKLIST.md §C–§D`.

- [ ] All checklist items A–D complete.
- [ ] Launch ticket updated with: SHA, snapshot ID, migration max version, flag-flip log.
- [ ] On-call handed the bridge from the cutover team.

**Watch:** dashboard `Infrastructure` page continuously.

---

## 2. Hours 0–2 — Hot watch

**Cadence:** dashboard refresh every 5 min, log tail open in all three PM2 processes.

| Probe | Frequency | Threshold |
|---|---|---|
| Feed read p95 | every 5 min | <200 ms |
| Queue depth | every 5 min | <2k |
| Notification backlog | every 5 min | <10k |
| Postgres CPU | every 5 min | <60% |
| PM2 restarts | continuous | 0 |
| New errors in PM2 logs | continuous | none repeating |

**If any RED → flip the offending flag OFF (Tier 1 rollback) and call Reliability Lead.**

---

## 3. Hours 2–6 — Warm watch

- Dashboard refresh every 15 min.
- Run standing SQL probes from `POST_LAUNCH_OBSERVABILITY_PLAN.md §4.2` once per hour.
- Check mobile crash dashboards once per hour.
- Verify cron freshness — every job should have run at least once in this window.

**Expected end state at T+6h:** all signals GREEN, queue drains promptly, notification dispatch end-to-end p95 < 5 min.

---

## 4. Hours 6–24 — Canary observation (Wave 1)

- Dashboard refresh every 30 min.
- Mobile staged rollout running at 10%.
- Hourly summary posted to the launch channel: counts of articles ingested, notifications dispatched, comments posted, new signups.
- At T+24h, if all `POST_LAUNCH_OBSERVABILITY_PLAN.md §2` signals were GREEN for the whole window → **promote to Wave 2 (25%)**.

**Promotion checklist:**
- [ ] Feed read p95 < 200 ms for full window.
- [ ] Queue depth never exceeded 2k.
- [ ] Notification backlog never exceeded 10k.
- [ ] Postgres CPU 5-min avg never exceeded 60%.
- [ ] Mobile crash-free sessions ≥ 99.5%.
- [ ] No Sev-1 or Sev-2 incidents.
- [ ] No data-integrity alerts.
- [ ] On-call sign-off in launch ticket.

---

## 5. Hours 24–72 — Wave 2 → Wave 3

- Dashboard refresh every 1 h.
- Daily health review at the start of each calendar day (15 min, Reliability Lead chairs).
- At T+72h, if all signals stayed GREEN for the dwell window → **promote to Wave 3 (100%)**.

**Wave 3 promotion is the trigger for transition to MAINTENANCE MODE (§6).**

---

## 6. Transition to Production Maintenance Mode (T+72h GREEN)

Once Wave 3 is reached and stable:

1. **Lift code freeze partial:** Sev-3 fixes and small feature work may resume to a `staging` branch; `main` still gated by full launch checklist for any merge.
2. **Standing observability cadence kicks in** per `POST_LAUNCH_OBSERVABILITY_PLAN.md §7`.
3. **On-call rotation collapses** from "two engineers + reachable lead" to the standing rotation.
4. **Retro scheduled** at T+7d.
5. **Architecture phase remains CLOSED.** Any new architectural work must go through a fresh authorization independent of this launch.

---

## 7. Incident playbook (quick reference)

| Symptom | First action | Second action | Escalate to |
|---|---|---|---|
| Feed p95 RED | Verify trending materialized view fresh; force `refresh_trending()` | Pause non-critical cron (retention, materialization) | Reliability Lead |
| Queue depth RED | Confirm queue runner alive; add second runner instance | Pause `ingestion` queue via flag | Release Lead |
| Notification backlog RED | Confirm dispatcher alive | Flip `backend_notification_dispatch` OFF; drain offline | Reliability Lead |
| Postgres CPU RED | Identify top query (`pg_stat_statements`) | Pause non-critical cron | DB on-call |
| Crash spike on mobile | Halt staged rollout in Play / App Store | Investigate stack traces; hotfix if needed | Mobile lead |
| RLS denial spike | Snapshot recent denied queries | Verify no migration regression on policies | Security + DB on-call |
| RSS worker restart loop | `pm2 stop rss-engine`; legacy path stops | Roll back code (Tier 2); investigate | Ops Engineer |

---

## 8. Communication

| Event | Audience | Channel |
|---|---|---|
| Cutover start | Internal | Launch channel |
| Cutover complete + smoke green | Internal + leadership | Launch channel + email |
| Wave promotion (1→2, 2→3) | Internal | Launch channel |
| Any Sev-1 | Internal + leadership + comms lead | Page + status page update |
| Wave 3 (100%) reached | All | Status page + customer comms |
| Maintenance Mode transition | All | Status page + retro invite |

---

## 9. Daily summary template (post in launch channel at end of each day)

```
Day N summary (UTC)
- Articles ingested:        ____
- Notifications dispatched: ____
- Comments posted:          ____
- New signups:              ____
- Feed read p95 (24h):      ____ ms
- Mobile crash-free (24h):  ____ %
- Postgres CPU peak:        ____ %
- Incidents:                Sev-1: _ / Sev-2: _ / Sev-3: _
- Open follow-ups:          ____
- Rollout wave:             Wave _
- Promotion decision:       ____
```

---

## 10. Exit criteria

The 72-hour window is **complete** when:

- [ ] Wave 3 (100%) reached and stable for the dwell window.
- [ ] No Sev-1 incidents open.
- [ ] All Sev-2 incidents have a documented mitigation or fix.
- [ ] Backup snapshots from days 1–3 verified restorable.
- [ ] Daily summaries archived in the launch ticket.
- [ ] Reliability Lead signs off the transition to Maintenance Mode.
