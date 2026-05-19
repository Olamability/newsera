# Mobile Release Certification

Coverage of `workers/mobile/*`. Surfaced in the Infrastructure → **Mobile Release** tab.

## Components

| Module | Role |
|---|---|
| `mobile/apiCompatibilityGuard.ts` | endpoint + field-level breaking-change detection across schema versions, deprecated-endpoint usage, unsupported-version-active checks |
| `mobile/crashCorrelation.ts` | per-fingerprint crash spike detection vs baseline, rollout-to-crash mapping, rollback recommendations |
| `mobile/releaseReadiness.ts` | composite ship / hold / rollback verdict including app-store-submission readiness and mobile config validation |

## Readiness state

| Surface | Default |
|---|---|
| Spike ratio threshold | 3× baseline |
| Baseline window | 24 h |
| Observation window | 60 min |
| Severe crash classification | ≥ 9× baseline |
| App-store gates | privacy manifest, signed binary, ToS check, release notes, screenshots |
| Mobile config required keys | injected by host |

## Known risks

* Crash baselines are sparse on launch day; first 24 h will over-flag. **Mitigation:** the spike threshold is intentionally high (3×) and severity scales linearly.
* API compatibility guard compares against a previous-schema snapshot the host injects; if the snapshot is missing, breaking-change detection silently degrades to "missing-endpoint only".
* Unsupported-version-active findings depend on accurate active-install counts from the analytics backend.

## Mitigations

* Compatibility report distinguishes `info` / `warn` / `severe`; only `severe` can be a launch blocker.
* `evaluateMobileRelease` requires explicit app-store readiness fields; defaulting any of them to true requires explicit override.
* Rollout-to-crash mapping returns `recommendsRollback: true` only when crashes are both ≥ 5 in absolute count AND ≥ 3× baseline; one-off crashes never trigger rollback.

## Rollback strategy

* `releaseReadiness.recommendation = rollback` should be honored by the operator — the orchestrator does not auto-rollback the mobile binary (which lives outside our infra). Operators must initiate via the app-store dashboard.
* Backend may still mark the matching feature flag down via the Flags tab; the next release cycle's `apiCompatibilityGuard` will then flag the affected app version as `unsupported_version_active` so cohort impact is visible.

## Operational checklist

- [ ] API schema snapshot pushed to compatibility guard before each release
- [ ] Crash reports streamed to crash correlation at ≥ 1/min cadence
- [ ] Active install counts refreshed daily
- [ ] App-store manifest validated before submission
- [ ] No supported app versions on deprecated endpoints
- [ ] `recommendation` checked before every store submission

## Signoff

| Role | Name | Status |
|---|---|---|
| Mobile lead |   | ☐ |
| QA lead |   | ☐ |
| Eng director |   | ☐ |
