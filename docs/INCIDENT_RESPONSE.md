# Incident Response

> **Purpose:** the protocol a NewsEra engineer follows from the moment they
> are paged until the incident is reviewed in a post-mortem.
> **Audience:** every engineer on call rotation.
> **Last reviewed:** Phase E — May 2026.

This is not a runbook for any one symptom — `FAILOVER_RUNBOOK.md` covers
those. This document defines *roles, comms, and process*.

---

## 1. Severity definitions

| Severity | User impact                                                    | Page? | Comms                  |
| -------- | -------------------------------------------------------------- | ----- | ---------------------- |
| **SEV-1**| Site/feed unreachable, or > 10% users affected.                | Yes   | #incidents + status pg |
| **SEV-2**| Major feature degraded (push offline, ranking stale > 1 h).    | Yes   | #incidents             |
| **SEV-3**| Minor degradation, single subsystem (DLQ growth, slow worker). | No    | #ops thread            |
| **SEV-4**| Cosmetic, internal-only, no user impact.                       | No    | none                   |

Severity may be revised *up* by the incident commander at any time. It
may only be revised *down* after explicit acknowledgement from the
on-call lead.

---

## 2. Roles

| Role                  | Who                                | Responsibility                              |
| --------------------- | ---------------------------------- | ------------------------------------------- |
| **Incident commander**| First responder, may delegate.     | Owns decisions; never debugs themselves.    |
| **Tech lead**         | A backend engineer.                | Owns investigation + remediation.           |
| **Comms lead**        | Product or eng manager.            | Updates status page and customer channels.  |
| **Scribe**            | Anyone unassigned.                 | Captures timeline & decisions.              |

For SEV-3/4, the same person may hold multiple roles. For SEV-1/2, the
roles MUST be split before any remediation begins.

---

## 3. The five steps

```
   1. Acknowledge ─▶ 2. Stabilize ─▶ 3. Diagnose ─▶ 4. Remediate ─▶ 5. Review
```

### 3.1 Acknowledge

- Page within 5 min of trigger.
- Post in `#incidents` with: SEV, headline, IC name, link to first alert.
- Open an incident document from the template.

### 3.2 Stabilize

Use the **safe defaults** from `FAILOVER_RUNBOOK.md` to stop the bleeding
before debugging. Acceptable stabilizers, ordered least-to-most disruptive:

1. Bump worker counts (per `autoscaler_recommendation`).
2. Engage `ingestion_slowdown_mode`.
3. Engage `notification_kill_switch`.
4. Engage `queue_freeze`.
5. Roll back the most recent canary stage.

Each stabilizer is reversible. Stabilizers ≥ 3 require IC sign-off.

### 3.3 Diagnose

- Pull the structured logs for the last 30 min, filtered to
  `level in ('warn', 'error')` and `service = 'newsera'`.
- Cross-reference with the observability dashboard panels:
  `worker saturation`, `queue velocity`, `p95 queue latency`,
  `push delivery success rate`, `rollout exposure`.
- Form a single hypothesis. Tell the scribe.

### 3.4 Remediate

- Apply the smallest change that addresses the hypothesis.
- All commands go through the runbook primitives — do NOT issue ad-hoc
  SQL against production.
- After the change, give the system 5 min to react before evaluating.

### 3.5 Review

A post-mortem is scheduled within 72 h for any SEV-1/2. The agenda is
fixed:

1. Timeline (from scribe notes).
2. Customer impact.
3. What went well.
4. What went poorly.
5. Action items (assigned, dated).

Post-mortems are blameless and shared internally.

---

## 4. Communication templates

### 4.1 Initial post

```
[SEV-?] <one-line headline>
IC: @<name>
Started: <UTC time>
Symptoms: <bulleted>
Status: investigating
```

### 4.2 Update

```
[SEV-?] <headline>
Update <n> at <UTC time>:
- What changed since last update
- Current hypothesis
- Next action + ETA
```

Updates are required every 30 min for SEV-1, every 60 min for SEV-2.

### 4.3 Resolution

```
[SEV-?] RESOLVED — <headline>
Duration: <h:mm>
Root cause: <one sentence>
Customer impact: <one sentence>
Follow-ups: <ticket links>
```

---

## 5. Decision log

Every reversible action goes into a decision log line:

```
<UTC time> — <actor> — <action> — <reason>
```

Examples:

```
12:04Z — sara — set traffic_guard ingestion_slowdown_mode=true — depth 5x threshold
12:11Z — sara — bumped queue_runner from 2 → 4 — autoscaler band=high
12:38Z — sara — set traffic_guard ingestion_slowdown_mode=false — velocity ≤ 0 for 10 min
```

The decision log is the single source of truth for the post-mortem
timeline. Capture it inline in the incident document; do NOT rely on
chat scrollback.

---

## 6. What NOT to do

- Do not delete from `dead_letter_jobs` to "clean up" — the data is
  needed for the post-mortem.
- Do not disable feature flags as a stabilizer; use the canary
  controller's rollback path (which keeps the flag enabled at a lower
  exposure).
- Do not change worker count past `bounds.max` without IC approval.
- Do not start a recovery primitive (`recoveryManager.*`) before the
  system has been stabilized.

---

## 7. Drills

Phase E ships a simulation suite (`pnpm test:phaseE`). The team runs the
full suite quarterly in staging, with the on-call rotation observing.
At least once per quarter the team runs a **paper drill** — walking
through this document end-to-end without touching the system.

---

## 8. Appendix: alert → action map

| Alert                              | First action                           |
| ---------------------------------- | -------------------------------------- |
| `worker_crash_detected`            | §1 of `FAILOVER_RUNBOOK.md`            |
| `queue_backpressure_active` > 5m   | §2 of `FAILOVER_RUNBOOK.md`            |
| `canary_probe_degraded` × 2        | §3 of `FAILOVER_RUNBOOK.md`            |
| `push_delivery_success_rate < 80%` | §4 of `FAILOVER_RUNBOOK.md`            |
| `cost_alert dimension=*`           | Open ops ticket; do not page unless §X |
| `stale_worker_count > 0`           | Coordinator check; restart workers     |
| `dlq_growth_rate > 100/min`        | Stabilize THEN replay, never both      |
