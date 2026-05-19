# Compliance & Retention Report

Coverage of `workers/security/*`. Surfaced in the Infrastructure → **Compliance** tab.

## Components

| Module | Role |
|---|---|
| `security/dataRetentionPolicy.ts` | per-table retention rules + violation severity (PII level weighted) |
| `security/accessBoundaryAudit.ts` | unsafe admin exposure, expired rollout permissions, stale tokens, orphaned privileged users |
| `security/complianceAudit.ts` | PII logging, debug endpoints exposed, queue poisoning vectors, replay-abuse opportunities, missing audit lineage, env mismatch — composes the above into `finalComplianceScore`, `launchBlockers[]`, `criticalFindings[]` |

## Readiness state

| Surface | Default |
|---|---|
| Admin audit log retention | 365 d |
| Notification log retention | 90 d |
| Analytics events retention | 180 d |
| Session token retention | 30 d (PII) |
| PII scratch retention | 7 d (PII) |
| Dead-letter retention | 60 d |
| Stale token threshold | 90 d unused |
| Orphaned-user threshold | 60 d no login |
| Dangerous roles (admin exposure) | `anon`, `public` |

## Detected categories

| Code | Surfaced by | Default severity |
|---|---|---|
| `pii_logging` | regex scan over prod log samples | severe |
| `debug_endpoint_exposed` | route allowlist scan | severe |
| `verbose_log_in_prod` | log level scan | warn |
| `excessive_notification_exposure` | no-opt-in topics > 100k audience | warn |
| `queue_poisoning_vector` | accepted job types not declared in source | severe |
| `replay_abuse_opportunity` | declared job types with no acceptor | info |
| `missing_audit_lineage` | mutation RPCs without audit log writes | severe |
| `env_mismatch` | expected env keys missing | warn |
| `unsafe_admin_exposure` (boundary) | admin RPCs reachable from anon | severe |
| `expired_rollout_permission` | grants past their `expiresAt` | warn |
| `stale_token` (admin scope) | admin tokens unused 90d+ | severe |
| `orphaned_privileged_user` | deactivated or inactive 60d+ | warn |

## Known risks

* Log sampler is best-effort; small samples may miss PII bursts. **Mitigation:** complement with infra-level redaction (out of scope for Phase G).
* `mutationAuditCoverage` requires every mutation RPC to be declared by the host — incomplete declarations under-report `missing_audit_lineage`.
* `replay_abuse_opportunity` is informational only; verify intent before declaring it a non-issue.

## Mitigations

* `finalComplianceScore` drops 0.15 per severe finding and 0.04 per warning; a single severe finding pushes the score below 0.85 (degraded).
* Boundary findings fold into compliance output so a single audit run produces one consolidated list.
* All retention rules default to additive — Phase G never deletes rows; it only flags violations for the data-engineering team.

## Rollback strategy

* All modules are pure compute. No DB writes.
* If a check produces false positives, the offending rule can be removed from the host-supplied input without redeploying.

## Operational checklist

- [ ] Production log sampler feeding `complianceAudit`
- [ ] Mutation RPC list updated whenever a new RPC ships
- [ ] Retention rules reviewed quarterly with legal
- [ ] Boundary audit re-run after every admin role change
- [ ] Compliance score ≥ 0.9 for 30 days straight before public launch

## Signoff

| Role | Name | Status |
|---|---|---|
| Compliance lead |   | ☐ |
| Security lead |   | ☐ |
| Eng director |   | ☐ |
