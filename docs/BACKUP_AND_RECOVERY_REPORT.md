# Backup & Recovery Report

Coverage of `workers/resilience/*`. Surfaced in the Infrastructure → **Recovery Center** tab.

## Components

| Module | Role |
|---|---|
| `resilience/backupCoordinator.ts` | per-tier scheduling metadata, freshness scoring, restore-point lineage, corruption markers, restore-simulation tracking |
| `resilience/recoveryVerification.ts` | replay / queue / notification / ranking / personalization / worker-state integrity |

## Tier defaults

| Tier | Interval | Retention | RPO |
|---|---|---|---|
| continuous | 5 min | 24 h | 15 min |
| daily | 24 h | 30 d | 26 h |
| weekly | 7 d | 90 d | 8 d |
| monthly | 30 d | 365 d | 32 d |

## Recovery verification surfaces

| Surface | Pass condition |
|---|---|
| replay | post-replay checksum == expected checksum |
| queues | no lost jobs; pending/inflight delta within tolerance |
| notifications | no duplicate dispatch vs already-delivered ledger |
| ranking_rebuild | average rank delta ≤ tolerance (default 5) AND change rate ≤ 0.5 |
| personalization_cache | failure rate < 5% AND rebuild rate ≥ 95% |
| worker_state | all expected workers recovered; no orphaned leases |

## Confidence scoring

`recoveryVerification.verifyRecovery()` returns `confidenceScore ∈ [0, 1]`:
* All-pass: 1.0
* Any warn: linearly weighted down
* Any fail: multiplied by 0.4 — single fail visibly tanks the score

## Known risks

* `backupCoordinator` is metadata-only. The actual backup is owned by Supabase / pg_basebackup; Phase G **never** orchestrates the dump itself.
* `freshnessScore` averages across all configured tiers — a missing tier (e.g., no monthly recorded yet) drags the score down, which is the intended behaviour.
* Replay checksum comparison assumes the host emits a deterministic checksum; mismatches between checksum algorithms across nodes will produce false-fails.

## Mitigations

* `markCorrupted(id, marker)` is non-destructive: it flags the record but leaves it queryable for forensics.
* Lineage walk (`lineage(snapshotId)`) caps cycle-detection via a visited-set; a malformed chain cannot loop forever.
* Restore simulations are stored as outcome records; the dashboard tab shows the last simulation time and result.

## Rollback strategy

* All modules are pure compute. Disabling them removes the dashboard view but does not affect any production backup activity.
* If a corruption marker turns out to be a false positive, the operator clears it by re-verifying the snapshot (`markVerified`).

## Operational checklist

- [ ] All four tiers represented at least once
- [ ] Daily backups verified within their RPO
- [ ] Continuous backups verified within their RPO
- [ ] Restore simulation executed and passed within the last 7 d
- [ ] Recovery verification has been run against the most recent restore-sim and `confidenceScore ≥ 0.9`
- [ ] No backup carries a `corruptionMarker` older than 24 h

## Signoff

| Role | Name | Status |
|---|---|---|
| Data engineering lead |   | ☐ |
| SRE lead |   | ☐ |
| Compliance lead |   | ☐ |
