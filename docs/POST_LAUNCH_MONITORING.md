# Post-Launch Monitoring

Continuous observability after public launch. Owners + thresholds + escalation paths.

## Primary watch

The Infrastructure → **Production Health** tab is the single source of truth. Page on:

| Signal | Threshold | Owner | Action |
|---|---|---|---|
| `score < 0.6` | critical | SRE on-call | PagerDuty SEV-1 |
| `0.6 ≤ score < 0.85` | degraded | SRE on-call | PagerDuty SEV-2 |
| `risk = unstable` | predictive | SRE on-call | Slack alert |
| `openSevereIncidents > 0` | hard | SRE on-call | PagerDuty SEV-2+ |
| `trafficGuard.mode != normal` | hard | platform | Slack alert |
| `backupsFresh = false` | warning | data eng | ticket |
| `productionFreeze = true` | informational | release captain | banner only |

## Secondary watch

| Tab | Owner | Cadence |
|---|---|---|
| Incidents | SRE | every shift |
| Rollout Timeline | release captain | every active rollout |
| Feed Quality | content eng | daily |
| Monetization | revenue eng | daily |
| SEO Health | growth | daily |
| Mobile Release | mobile eng | per submission |
| Compliance | security | weekly |
| Recovery Center | data eng | weekly + before any risky change |

## SLOs

| SLO | Target |
|---|---|
| Composite health score (24h avg) | ≥ 0.92 |
| Launch readiness score (rolling 7d) | ≥ 0.90 |
| SEVERE incident MTTR | ≤ 30 min |
| Backup freshness score | ≥ 0.85 |
| Recovery confidence (last sim) | ≥ 0.90 |
| Mobile crash spike count | 0 severe per 24h |
| Compliance findings (severe) | 0 |

## Drills

* **Weekly:** simulate restore via Recovery Center → "Run restore simulation".
* **Bi-weekly:** chaos drill — pause a worker pool and verify command center degrades correctly (cf. Phase G simulation scenario #2).
* **Monthly:** rotate all admin tokens; validate access boundary audit returns 0 stale-token findings.
* **Quarterly:** end-to-end DR exercise — full recovery against a corrupted backup and a clean backup.

## Incident lifecycle

`incidentHistory` enforces the `OPEN → ACKED → RESOLVED` ladder. Operators acknowledge via the Incidents tab (audit reason captured). MTTR is computed automatically from first-seen → resolved.

## Cohort signals

Beta cohort analytics (`workers/operations/betaAnalytics.ts`) feed the launch-day dashboard. Watch:
* `day1Retention` for new cohort
* `crashCorrelation.flaggedAsHotspot`
* `satisfaction.promoterRate - detractorRate`
* `incidentImpact.share` for any open incident

## Escalation matrix

| Severity | Initial owner | Escalation (15 min) | Final escalation |
|---|---|---|---|
| SEV-1 | SRE on-call | platform lead | eng director |
| SEV-2 | SRE on-call | platform lead | — |
| SEV-3 | feature owner | SRE on-call | — |
