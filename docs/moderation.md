# Admin Moderation & Fraud Prevention System

This document describes the audit-safe moderation and fraud prevention
subsystem added to Newsera. It is organized to match the implementation
sections in PR / plan.

## Components

| Layer                | Where                                  | Responsibility |
| -------------------- | -------------------------------------- | -------------- |
| Data layer           | `supabase/migrations/055_…sql`         | Schema, RLS, append-only audit log with hash chain |
| Moderation service   | `services/moderation`                  | All mutations on moderation state. Atomic business write + `admin_activity_log` row in one transaction. |
| Fraud engine         | `services/fraud`                       | Declarative rules engine + risk scoring; emits `fraud_signals` and `risk_scores`; produces auto-action proposals that must still be applied via the moderation service. |
| Admin panel (UI)     | `admin-panel/src/pages/moderation/*`   | Queues, case view, verifications, fraud monitor, analytics, audit log. Reads via Supabase + RLS; writes via the moderation service. |

The admin panel never writes to base tables directly. Every mutation goes
through the moderation service so the audit log is guaranteed to share the
business transaction.

## Tables (migration 055)

| Table                      | Purpose                                   | Mutability |
| -------------------------- | ----------------------------------------- | ---------- |
| `reports`                  | User-submitted reports                    | normal     |
| `moderation_cases`         | Groups reports + signals for a target     | normal     |
| `moderation_actions`       | Every action taken on a case/target       | **insert-only** |
| `admin_activity_log`       | Hash-chained admin activity ledger        | **insert-only** |
| `user_suspensions`         | Active and historical suspensions         | normal (lifted_at / lifted_by used to "lift") |
| `verifications`            | Identity / business / address / phone     | normal     |
| `fraud_rules`              | Declarative rule definitions              | normal     |
| `fraud_signals`            | Emitted signals (rule or model)           | insert-only at API layer |
| `risk_scores`              | Rolling per-subject aggregate             | upserted   |
| `admin_roles`              | Role catalog                              | catalog    |
| `role_permissions`         | Permissions per role                      | catalog    |
| `admin_role_assignments`   | User → role grants                        | normal     |
| `moderation_metrics_daily` | Daily analytic snapshots                  | append-only by convention |

### Hash chain

`admin_activity_log` rows carry `prev_hash` (previous row hash) and
`row_hash = sha256(prev_hash || canonical_row_payload)`. The trigger
`admin_activity_log_hash_chain` enforces this on insert and rejects
UPDATE/DELETE. The Postgres function `verify_admin_activity_chain()`
re-derives hashes and returns the first row id whose hash doesn't match,
or no rows when intact.

The Audit Log page exposes a "Verify hash chain" button that calls this
function via `/v1/audit/verify`.

## RBAC

Roles (least privilege, permissions stored in DB):

- `viewer` — read queues + analytics
- `moderator` — triage, hide listing, warn, temp suspend (≤7d), dismiss
- `senior_moderator` — remove listing, suspend (≤90d), decide appeals
- `verification_reviewer` — verifications + evidence access
- `ts_lead` — permanent suspensions, rule changes
- `admin` — role management, audit export, settings
- `system` — automated actor (fraud engine)

Permissions are checked in three places:

1. **API gateway / `applyAction`** — early reject with 403 + audited.
2. **Moderation service handlers** — same check before the DB transaction.
3. **Supabase RLS** — defense-in-depth on read paths via
   `admin_has_permission(uid, permission)`.

## Report lifecycle

```
intake → triaged → in_review → resolved | dismissed
                              ↘ appealed → resolved
```

Severity is computed in `services/moderation/src/triage.js` from the reason
code, optionally bumped by the existing risk score on the target. SLA due is
derived from severity. Both are pure functions and unit-tested.

## Fraud rules DSL

Rules in `fraud_rules.definition`:

```json
{
  "subject": "user",
  "subjectPath": "event.userId",
  "when": { "all": [
    { "path": "event.kind", "op": "eq", "value": "signup" },
    { "path": "context.signupsLast24hForIp", "op": "gte", "value": 5 }
  ]},
  "signal": { "code": "ip_signup_velocity", "score": 60 }
}
```

Supported ops: `eq, neq, gt, gte, lt, lte, in, contains, regex, exists`.
Combinators: `all`, `any`, `not`.

`mode` controls enforcement:

- `shadow` — log signals only; no automated action.
- `enforce` — auto-actions for `high` (≥70) and `critical` (≥90) bands.
- `disabled` — rule is skipped entirely.

Auto-actions never bypass the moderation service. The engine emits an
action descriptor; the caller forwards it to `applyAction` so the audit log
+ separation-of-duties checks still apply.

## Verifications

State machine:
`requested → submitted → in_review → approved | rejected | more_info_required`

Constraints (enforced by trigger `verifications_check_separation`):

- A reviewer cannot decide their own verification.
- Approving a `business` verification requires two distinct reviewer ids.

Evidence is referenced by storage object keys + sha256; the UI redacts
previews by default and the Reveal button calls
`POST /v1/actions/verification.evidence.view` so reveals are themselves
audited.

## Running locally

```bash
# DB
psql "$DATABASE_URL" -f supabase/migrations/055_moderation_and_fraud_system.sql

# Moderation service
cd services/moderation && npm install && DATABASE_URL=… npm start
# → :8081

# Admin panel
cd admin-panel
echo "VITE_MODERATION_API_URL=http://localhost:8081" >> .env
npm run dev
```

## Tests

- `services/moderation`: `node --test test/handlers.test.js`
- `services/fraud`:      `node --test test/rules.test.js`

Both cover pure logic (severity, SLA, action catalog, permission gate, rule
DSL evaluator, scoring bands, automated-action selection).

## Rollout order

1. Apply migration 055 in lower environment first; sanity-check RLS.
2. Deploy moderation service; grant a small group of admins the
   `moderator` role.
3. Ship admin-panel UI; start using Reports / Case view manually.
4. Turn on fraud engine in **shadow mode** (default). Review precision
   for ≥1 week.
5. Promote individual rules to `enforce` as they hit precision targets.
6. Add `metrics_daily` snapshotter job once volumes warrant.
