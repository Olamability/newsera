# Final Security Lockdown Report

_Phase F — Pre-launch security hardening pass. This report records the launch-readiness verdict produced by `rss-engine/workers/security/launchLockdown.ts` and documents the manual checks complementing it._

---

## 1. Scope

The launch lockdown audit covers eight categories required by the Phase F spec:

1. **Exposed service-role keys** — secrets accidentally surfaced through client-visible env prefixes (`VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`).
2. **Insecure env vars** — `http://` URLs in production, weak-entropy secret values.
3. **Unsafe admin RPC exposure** — admin RPCs reachable without a service-role bearer.
4. **Open debug endpoints** — `/debug`, `/__inspect`, `/pprof`, `/dev`, etc.
5. **Test routes** — `/test`, `/staging`, `/qa`, `/internal` in the production build.
6. **Verbose production logs** — `log_level=debug` in a production deployment.
7. **Replay vulnerabilities** — recovery primitives missing an idempotency key (i.e., not gated by `recoveryManager`'s fingerprinting).
8. **Queue poisoning vectors** — queues whose consumers do not validate payload shape.

---

## 2. How to run

```ts
import { runLaunchLockdown } from 'rss-engine/workers/security/launchLockdown';

const result = runLaunchLockdown({
  env: process.env,
  isProduction: process.env.NODE_ENV === 'production',
  publicRoutes: collectExpressRoutes(app),
  unauthenticatedAdminRpcs: enumerateAnonAdminRpcs(),
  logLevel: currentLogLevel(),
  replayPrimitives: [
    { name: 'dlq_replay', hasIdempotencyKey: true },
    { name: 'notification_replay', hasIdempotencyKey: true },
    { name: 'ranking_rebuild', hasIdempotencyKey: true },
    { name: 'worker_state_restore', hasIdempotencyKey: true },
  ],
  queues: [
    { name: 'ingestion',    validatesPayload: true },
    { name: 'ranking',      validatesPayload: true },
    { name: 'notification', validatesPayload: true },
    { name: 'analytics',    validatesPayload: true },
  ],
});

if (!result.passed) {
  throw new Error(`launch_blocked: ${result.summary}`);
}
```

The audit is **pure compute** — it takes a snapshot of the deployment as input rather than reading process.env on its own. This keeps the audit deterministic and testable.

---

## 3. Scoring

`launchSecurityScore ∈ [0, 1]` starts at 1.0 and decreases per finding:

| Severity  | Penalty |
| --------- | ------- |
| critical  | 0.20    |
| warning   | 0.08    |
| info      | 0.02    |

A run with **zero critical findings** passes (`result.passed === true`). A single critical finding blocks the launch by default.

---

## 4. Simulated outcomes

The `phaseF.simulation.ts` suite includes two snapshot runs:

### Bad deployment (every category breached)
- `VITE_SUPABASE_SERVICE_ROLE_KEY` leaked under a client-visible prefix → critical
- `SUPABASE_URL=http://example.com` in production → warning
- `ADMIN_PASSWORD=12345` → critical (weak secret)
- `admin_purge_user` reachable without auth → critical
- `/debug/stats` exposed → critical
- `/test/seed` exposed → warning
- `log_level=debug` in production → warning
- `legacy_replay` missing idempotency → critical
- `analytics` queue not validating payload → warning

Result: `passed=false`, multiple critical findings. **Launch is blocked.**

### Clean deployment (mirroring the intended production posture)
- All env vars HTTPS, no `VITE_*_SERVICE_ROLE`.
- No unauthenticated admin RPCs.
- Only `/api/*` routes public.
- `log_level=info`.
- All replay primitives have `hasIdempotencyKey: true` (matches `recoveryManager` defaults).
- All queues `validatesPayload: true`.

Result: `passed=true`, `launchSecurityScore=1.0`. **Launch may proceed.**

---

## 5. Manual security checks (complementary)

The automated audit does NOT replace the manual checklist below. Operators must complete these before any public traffic:

- [ ] Rotate all secrets that have appeared in any branch, log, or screenshot.
- [ ] Confirm Supabase Row-Level Security policies are present on every table (see `docs/RELATIONAL_INTEGRITY_ANALYSIS.md`).
- [ ] Confirm `SECURITY DEFINER` RPCs (recovery, admin) require `service_role` or session-bound admin claims.
- [ ] Confirm push notification credentials are scoped to the production environment only.
- [ ] Confirm Sentry / log aggregation does not capture full request bodies.
- [ ] Confirm `make-admin.js` is not present in the production runtime image.
- [ ] Run `npm audit --omit=dev` and address any HIGH/CRITICAL advisories.

---

## 6. Sign-off

| Item | Owner | Status |
| ---- | ----- | ------ |
| Launch lockdown audit `launchSecurityScore >= 0.9` | Platform | _pending production deploy_ |
| Manual security checklist (Section 5) complete    | Security | _pending production deploy_ |
| Penetration test on the Beta cohort               | Security | _pending Beta enrolment_ |

The platform is **launch-ready from a security standpoint** when both automated and manual sections above are fully signed off.
