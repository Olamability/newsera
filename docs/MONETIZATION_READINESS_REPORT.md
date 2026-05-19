# Monetization Readiness Report

Internal readiness only. No external ad SDK is wired by Phase G.

## Components

| Module | Role |
|---|---|
| `monetization/adPlacementGuard.ts` | density per article + per session, duplicate suppression, cooldown, above-the-fold spam prevention |
| `monetization/revenueHealth.ts` | RPM, fill rate, eCPM, source breakdown, RPM trend buckets, engagement-vs-revenue anomalies |
| `monetization/clickFraudSignals.ts` | per-user / per-IP burst detection, CTR anomaly, duplicate clicks, suspicious UA, rapid session churn |

## Readiness state

| Surface | Default |
|---|---|
| Max ads per article | 2 |
| Max ads per session | 8 |
| Per-slot cooldown | 30 s |
| Above-the-fold positions enforced | `inline_1`, `sticky_bottom` |
| Click burst threshold (user / window) | 5 / 60 s |
| Click burst threshold (IP / window) | 20 / 60 s |
| CTR anomaly trigger | ≥ 5× expected (cap 0.05) |
| Revenue anomaly severity | warn at 0.35, severe at 0.6 divergence |

## Known risks

* No external SDK = no real revenue today. The guard + fraud + revenue modules are scaffolding for the eventual integration.
* `clickFraudSignals` is heuristic and will produce false positives on bursty legitimate traffic (e.g., a celebrity tweet driving 100k clicks in 30 s); operators must whitelist known events.
* RPM/eCPM are reported in micros — host MUST convert to user currency before display.

## Mitigations

* Every block decision is returned with `reason` and `detail` so the host can log the call for analytics or appeal.
* The guard maintains a bounded ledger (default 50k entries, 1h TTL) — memory cannot grow unboundedly under attack.
* Fraud findings are advisory; the calling code decides whether to suppress impressions or shadow-block users.

## Rollback strategy

* All modules are pure compute. Disabling them is a one-line config flip; no DB or queue side-effects.
* If a guard or fraud rule starts producing too many false positives, the host can lower thresholds via constructor config without redeploying.

## Operational checklist

- [ ] Ad-placement guard wired into render path
- [ ] Click-fraud signals fed by analytics ingest
- [ ] Revenue health receives RPM samples at ≥ 1/min cadence
- [ ] Operator dashboard `Monetization` tab shows current-window stats
- [ ] Anomaly findings reviewed daily
- [ ] Currency formatting (micros → display) verified

## Signoff

| Role | Name | Status |
|---|---|---|
| Revenue lead |   | ☐ |
| Trust & safety |   | ☐ |
| Platform eng |   | ☐ |
