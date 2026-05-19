# Production Rollout Guide

_Phase F — Controlled Production Rollout & Stabilization. This guide is the canonical operator runbook for taking NewsEra from "production-capable" to "live-production operated platform". It assumes Phase A–E are complete and that the Phase F modules in `rss-engine/workers/` are deployed and observable._

---

## 1. Principles

All rollout work in Phase F MUST be:

1. **Additive** — never replace existing primitives, only wrap them.
2. **Rollback-safe** — every transition has a reverse path through the same module.
3. **Flag-gated** — every user-visible behaviour change is bound to a `feature_flags` row.
4. **Observable** — every transition emits a structured `rollout_*` / `incident_*` / `recovery_*` log line.
5. **Operationally reversible** — `trafficGuard` controls can stop ANY subsystem within one heartbeat without a redeploy.

If a change in front of you doesn't satisfy all five, STOP — it does not belong in Phase F.

---

## 2. Rollout sequence (locked)

The `rolloutManager` enforces this order. Out-of-order activation is rejected at the API surface.

| Stage | Flag | Stabilization window |
| ----: | ---- | -------------------- |
| 1 | `queue_based_ingestion`         | 24h |
| 2 | `ranking_v1`                    | 48h |
| 3 | `personalization_v1`            | 72h |
| 4 | `backend_notification_dispatch` | 72h |

Each flag walks the canary staircase before stabilization:

```
internal (1%) → beta (5%) → limited (25%) → broad (50%) → global (100%)
```

Promotion between canary stages is MANUAL via `rolloutManager.promote()`. Rollback is automatic when `canaryHealthEvaluator` returns CRITICAL for two consecutive probes.

---

## 3. Stage-by-stage procedure

For every stage:

1. **Pre-flight** — confirm the previous stage's `RolloutStageState.status === 'STABLE'`. The dashboard "Rollout Control Panel" must show zero blockers.
2. **Begin** — `rolloutManager.beginNextStage({ initiator, reason })`. This advances the canary to `internal` (or whatever `initialCanaryStage` is configured to).
3. **Promote** — `rolloutManager.promote()` once per canary stage. Pause for at least one full refresh cycle (5–15 min) between promotions and re-check `canaryHealthEvaluator`.
4. **Reach 100%** — when promotion reaches `global`, call `rolloutManager.markStabilizing()`. The stabilization timer starts.
5. **Stabilize** — let the feature run for the required window with all six signals healthy:
   - queue latency p95
   - worker crash count
   - DB latency p95
   - notification delivery success
   - personalization freshness
   - error spike ratio
6. **Advance** — once `stabilizationPolicy.evaluate(...).advancementAllowed === true`, call `rolloutManager.markStable()`.
7. **Audit** — verify `rolloutManager.snapshot().history` shows the full transition trail.

If at any point ANY signal trips a threshold, the operator must:

- **Pause** the active stage: `rolloutManager.pause({ reason })`.
- **Investigate** via the Incident Center.
- **Resume** only after the originating incident is closed.

---

## 4. Stabilization signals & thresholds

Defaults from `stabilizationPolicy.DEFAULT_THRESHOLDS`. Tune per environment if needed.

| Signal | Threshold | Notes |
| ------ | --------- | ----- |
| `queueLatencyMs`              | ≤ 2 000   | Aggregated p95 across queues |
| `queueDepthPeak`              | ≤ 50 000  | Highest depth observed in window |
| `workerCrashCount`            | ≤ 3       | Per rolling window |
| `dbLatencyMs`                 | ≤ 300     | DB p95 |
| `notificationDeliverySuccess` | ≥ 0.95    | Fraction of delivered messages |
| `personalizationFreshnessMs`  | ≤ 30 min  | Cache age |

The policy is **conservative**: a missing signal is treated as a blocker. The host must wire every signal before stabilization will pass.

---

## 5. Operator Command Center surfaces

The Command Center is composed from data already produced by Phase E/F modules. The admin dashboard reads each section by calling the snapshot method of the corresponding module.

### Rollout Control Panel
- `rolloutManager.snapshot()` → `currentFlag`, `currentStatus`, `blockers`, full audit history.
- Operator actions: `beginNextStage`, `promote`, `pause`, `resume`, `rollback`.

### Live Health
- `scalingHistory.snapshot()` → queue saturation trends, recurring overload spans, average growth velocity.
- `trafficGuard.state()` → current emergency controls.
- `performanceProfiler.snapshot('queue_latency' | 'db_latency' | ...)` → p50/p95/p99.
- `canaryHealthEvaluator(...)` → live composite health score per active flag.

### Incident Center
- `incidentDetector.snapshot()` → open incidents grouped by severity, with subsystem + recommended action.
- Operator actions: `acknowledge`, `close`.
- Severity → guard mapping:
  - WARNING: surface in dashboard, no auto-action.
  - SEVERE: recommend `trafficGuard.set('emergency_throttle', true)`.
  - CRITICAL: rolloutManager automatically pauses the active stage; operator must confirm guard engagement.

### Beta Cohort Panel
- `betaTrafficController.policy()` → current mode, cohorts, regions, traffic %.
- `betaTrafficController.cohortSummary()` → admitted vs denied per cohort.

### Feed Quality Panel
- `auditFeedQuality(sampleFeed)` → quality score, source/category diversity, collapse warnings.

---

## 6. Rollback decision matrix

| Condition | Action |
| --------- | ------ |
| `canaryHealthEvaluator.classification === 'CRITICAL'` twice in a row | `canaryController` auto-rolls back one canary stage |
| `incidentDetector` emits any CRITICAL | `rolloutManager.pause()` immediately, evaluate severity |
| `notification_delivery_collapse` CRITICAL | `trafficGuard.set('notification_kill_switch', true)` |
| `queue_explosion` CRITICAL | `trafficGuard.set('emergency_throttle', true, { throttleFactor: 0.1 })` |
| Any rollback during stage N | Stage N+1 cannot begin until N is re-stabilised |
| `launchLockdown.passed === false` at any pre-launch run | Block the launch; remediate before proceeding |

Panic rollback (`rolloutManager.rollback({ panic: true })`) drops the canary all the way to `internal`. Use only when the platform must be quarantined for an incident.

---

## 7. Replay safety

`recoveryManager` now enforces replay fingerprinting:

- Every primitive (`dlqReplay`, `notificationReplay`, `rankingRebuild`, `workerStateRestore`) auto-computes a fingerprint from `(primitive, normalised params, time bucket)`.
- A second call with the same fingerprint inside the `idempotencyWindowMs` (default 5 min) is suppressed and logged as `*_suppressed_duplicate`.
- Operators may pass `ctx.idempotencyKey` to force a duplicate replay (e.g., incident-specific replays).
- `recoveryManager.lineage()` exposes the replay history for the Recovery Panel.

Concretely:
- No duplicate user-visible notifications.
- No duplicate ranking jobs (queue-level dedup + manager-level fingerprint).
- No replay storms triggered by repeated operator clicks during an incident.

---

## 8. Final pre-launch checklist

Run all four before opening the platform to beta or public traffic:

1. ✅ All four rollout flags status = `STABLE` in `rolloutManager.snapshot()`.
2. ✅ `incidentDetector.snapshot().worstSeverity === null`.
3. ✅ `validateTelemetry(...).integrityScore >= 0.9` and zero critical findings.
4. ✅ `runLaunchLockdown(...).passed === true` and `launchSecurityScore >= 0.9`.
5. ✅ `FINAL_MOBILE_RELEASE_REPORT.md` checklist is signed off by the mobile owner.

---

## 9. What is OUT OF SCOPE for Phase F

The following are NOT permitted:

- Introducing Redis / Kafka / Kubernetes.
- Building a new recommendation system.
- Modifying the queue substrate.
- Bypassing feature flags.
- Direct database mutation paths.

Anything matching the above MUST be deferred to a future architecture phase.
