# Environment Hardening Report

_Track 2.1 deliverable. Audit of every component's runtime environment surface across the monorepo._

## Scope

| Component | Source of env | Owner |
| --- | --- | --- |
| `rss-engine` | `.env` loaded by `dotenv` at process start | RSS worker / queue runner |
| `admin-panel` | Vite `import.meta.env.VITE_*` injected at build time | Browser bundle |
| `mobile-app` | Expo `app.config.*` / `EXPO_PUBLIC_*` | Mobile bundle |
| Supabase backend | Project settings + migrations | DB |
| Cron jobs (pg_cron) | Defined inside migrations | DB |
| Deployment scripts | `package.json`, `ecosystem.config.js`, `RELEASE_WORKFLOW.md` | CI / VPS |

## Inventory (canonical names)

| Variable | Required by | Sensitivity | Notes |
| --- | --- | --- | --- |
| `SUPABASE_URL` | rss-engine, admin-panel (`VITE_SUPABASE_URL`), mobile (`EXPO_PUBLIC_SUPABASE_URL`) | public | Safe in client bundles. |
| `SUPABASE_ANON_KEY` | admin-panel (`VITE_SUPABASE_ANON_KEY`), mobile (`EXPO_PUBLIC_SUPABASE_ANON_KEY`) | public | RLS-bounded. Safe in client bundles. |
| `SUPABASE_SERVICE_ROLE_KEY` | rss-engine, queue runner, notification runner, cron-helper scripts | **SECRET** | Must never appear in any `VITE_*` or `EXPO_PUBLIC_*` namespace, must never appear in mobile or admin bundles, must never be committed. |
| `RSS_WORKER_LEASE_SECONDS` | rss-engine | non-secret | Default 60. |
| `RSS_WORKER_MAX_PARALLEL` | rss-engine | non-secret | Default 4. |
| `QUEUE_RUNNER_BATCH_SIZE` | rss-engine queue runner | non-secret | Default 25. |
| `NOTIFICATION_DISPATCH_BATCH` | rss-engine notification runner | non-secret | Default 100. |
| `EXPO_PUBLIC_API_BASE_URL` | mobile-app | public | Must point to the prod Supabase URL in release builds. |
| `EXPO_PUBLIC_RELEASE_CHANNEL` | mobile-app | public | One of `production` / `staging` / `dev`. |
| `LOG_LEVEL` | all services | non-secret | `info` in production. |
| `NODE_ENV` | all services | non-secret | `production` in all release builds. |

## Findings

### Critical (MUST fix before launch)

* None. The repository's documented separation (`VITE_*` / `EXPO_PUBLIC_*` for client, bare names for server) is respected by every entry-point we inspected. `SUPABASE_SERVICE_ROLE_KEY` is never referenced under a public namespace.

### Should fix

* **Inconsistent fallback defaults.** A handful of rss-engine modules read `process.env.X || hard_coded_default`. Defaults are sane but document them in `DEPLOYMENT_PIPELINE.md` so operators don't assume "unset === safe."
* **`.env.example` drift.** Recommend regenerating after every release using `grep -rho 'process.env.[A-Z_]*' rss-engine | sort -u` so the example stays canonical.
* **Mobile `EXPO_PUBLIC_RELEASE_CHANNEL`** is read in code but is not enforced — recommend adding a startup assertion that errors when the channel is `dev` in a `production` build flavour.

### Stale / dead

* Any legacy `NEWSERA_*` variables that predate the canonical schema are no longer read by any module — confirmed via grep. Remove from operator runbooks.

### Service-role leakage check

* `grep -r 'SUPABASE_SERVICE_ROLE_KEY' admin-panel/src mobile-app/src`: **no matches**. ✅
* `grep -r 'service_role' admin-panel/src mobile-app/src`: **no matches**. ✅
* Vite build output (`admin-panel/dist`) was greped for the literal `service_role` after building — **no matches**. ✅

### Feature-flag hygiene

The `feature_flags` table is the single source of truth for runtime toggles (see migration 045 + 047). Hard-coded boolean envs for ranking / personalization / notifications must NOT be reintroduced. Operators flip behavior through the admin panel → audited via `admin_update_feature_flag`.

## Remediation actions

1. Append a lint step to CI that fails the build if any `VITE_*` or `EXPO_PUBLIC_*` variable name contains the substring `SERVICE_ROLE` or `SECRET`.
2. Add startup assertions in `rss-engine` entry-points: refuse to boot when `SUPABASE_SERVICE_ROLE_KEY` is unset or matches the anon key.
3. Add a startup assertion in `mobile-app` that errors when the runtime channel does not match the build flavour.
4. Document the variable inventory above in the README (already linked from `DEPLOYMENT_PIPELINE.md`).
5. Rotate the service-role key on every emergency rollback that involved credential exposure; record the rotation in `admin_audit_log`.

## Sign-off

Environment surface is launch-ready. No critical leaks detected. The Should-fix items are operational hygiene, not launch blockers — see `LAUNCH_BLOCKERS.md`.
