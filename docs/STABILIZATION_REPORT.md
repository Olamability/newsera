# Stabilization Report

_Phase F — Controlled Production Rollout & Stabilization. This report records the simulated 7-day stabilization run and explains how the operator dashboard interprets the result. Future production stabilization windows should append to this document._

---

## 1. Simulation summary

The simulation harness `rss-engine/workers/tests/phaseF.simulation.ts` walks every Phase F module through the five required scenarios:

| # | Scenario                          | Result |
| - | --------------------------------- | ------ |
| 1 | 7-day stabilization               | ✅ all 4 stages advanced through the strict-order sequence, all stabilization windows enforced |
| 2 | Canary rollback cascade           | ✅ ranking_v1 rolled back from `limited` → `beta` after two consecutive CRITICAL evaluations |
| 3 | Notification overload             | ✅ 1M fanout chunked at 5 000 per batch; per-user daily ceiling enforced; CRITICAL incidents fired for queue + delivery |
| 4 | Feed collapse prevention          | ✅ source domination flagged at both auditor and user-protection layers; healthy feed scores ≥ 0.85 |
| 5 | Incident escalation chain         | ✅ worker_death_storm → CRITICAL; trafficGuard engaged; rolloutManager paused active stage |

Run command:

```sh
pnpm --filter @newsera/rss-engine test:phaseF
# or
cd rss-engine && npx tsx workers/tests/phaseF.simulation.ts
```

The harness exits non-zero on any assertion failure, so the script is CI-safe.

---

## 2. Stabilization window walkthrough

The strict rollout sequence is enforced by `rolloutManager.beginNextStage()`. Each stage advances through the canary staircase, then enters `STABILIZING`, then transitions to `STABLE` only once the policy says so.

| Stage | Flag                          | Min window | Sim outcome |
| ----: | ----------------------------- | ---------- | ----------- |
| 1 | `queue_based_ingestion`         | 24h | STABLE — no queue saturation, no worker crashes |
| 2 | `ranking_v1`                    | 48h | STABLE — ranking freshness < 30 min throughout |
| 3 | `personalization_v1`            | 72h | STABLE — recompute lag < 30 min throughout |
| 4 | `backend_notification_dispatch` | 72h | STABLE — delivery success ≥ 0.95 throughout |

Total simulated elapsed time: **216h** (= 24 + 48 + 72 + 72), comfortably exceeding the 7-day requirement.

---

## 3. Signal coverage

`stabilizationPolicy` requires all six signals to be present before advancement. The simulation injects all six and proves:

- A **missing** signal blocks advancement (`reason: missing_signal`).
- An **unhealthy** signal (e.g. `queueLatencyMs > 2 000`) blocks advancement even when the window has elapsed (`reason: blocked_by:queue_latency_high`).
- A **healthy** snapshot with the window elapsed transitions to `advancementAllowed: true`.

---

## 4. Queue saturation forecasting

`scalingHistory` records every autoscaler recommendation and every queue pressure sample. In the simulation, ingestion sustained 60 000+ depth across six minutes; the snapshot showed:

- `recurringOverload` spans capture the high-band period.
- `avgQueueGrowthVelocity` reflects the sustained backlog growth.
- `predictOverload()` issues a `warning` severity for `recurring_overload_pattern`.

The operator dashboard surfaces these via the Live Health panel.

---

## 5. Recovery replay safety

`recoveryManager` now suppresses duplicate replays within a 5-minute fingerprint window. The simulation proves:

- A repeated `dlqReplay` with identical parameters is suppressed (count = 0, RPC NOT called).
- Suppressions are visible in `recoveryManager.lineage()` with `suppressions: 1`.
- An operator-supplied `idempotencyKey` can force a duplicate replay.

No duplicate user-visible notifications, no duplicate ranking jobs, no replay storms.

---

## 6. Telemetry integrity

`telemetryValidator` exercised seven check classes against a representative snapshot:

- ✅ `missing_metric` for an absent required metric
- ✅ `stale_metric` for a 20-min-old metric with 5-min freshness
- ✅ `inconsistent_counter` for a monotonic counter that went DOWN
- ✅ `broken_heartbeat_chain` for a 10-min gap with a 2-min tolerance
- ✅ `queue_drift` for a 100/200 reported/sampled discrepancy
- ✅ `dead_worker_reference` for metrics referencing a dead worker
- ✅ `malformed_profiler_window` for an over-capacity bucket and inverted percentiles

`integrityScore` is bounded to [0..1] and decreases per severity weight.

---

## 7. Open items (for production stabilization)

This is a SIMULATED stabilization. Production stabilization must additionally:

1. Wire `scalingHistory` to the autoscaler emit path so every recommendation lands in history without the operator's intervention.
2. Wire `incidentDetector.evaluate()` into the per-minute observability tick.
3. Cron the `userProtector.reap()` call once per day to bound memory growth.
4. Append a new stabilization run entry to this report after each completed rollout stage in production.

---

## 8. Stabilization runs in production

| Date (UTC) | Stage | Begin | Stabilized | Operator | Outcome |
| ---------- | ----- | ----- | ---------- | -------- | ------- |
| _pending first production rollout_ |  |  |  |  |  |
