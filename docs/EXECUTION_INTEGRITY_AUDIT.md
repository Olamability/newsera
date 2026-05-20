# Execution Integrity Audit

_Phase H deliverable. Source of truth for every runnable command in the
Newsera monorepo. If a command is not listed here it is not part of the
launch contract._

## How the workspace is laid out

The monorepo has two kinds of packages:

1. **Workspace members** (`apps/*`, `services/*`, `packages/*`) — registered in
   `pnpm-workspace.yaml`. Most of these are *thin proxies* whose scripts
   delegate to the real package directories using
   `corepack pnpm --dir <relative-path> run <script>`.
2. **External package roots** (`admin-panel/`, `mobile-app/`, `rss-engine/`)
   — full applications with their own lockfiles. They live outside the
   workspace so that they can be deployed independently, but `pnpm install`
   at the monorepo root automatically installs them via the
   `scripts/install-externals.js` postinstall hook.

The script wiring chain for the rss-engine test harnesses is:

```
root package.json
  └── corepack pnpm --filter @newsera/rss-engine <script>
         └── services/rss-engine/package.json     (workspace proxy)
                └── corepack pnpm --dir ../../rss-engine run <script>
                       └── rss-engine/package.json (real package, has tsx)
                              └── tsx workers/tests/<phase>.simulation.ts
```

The drift detector at `rss-engine/workers/tools/validateScripts.ts` walks
this chain on every run and fails the build if any link is broken.

## Required environment

| Tool      | Required version | Source                                              |
|-----------|------------------|-----------------------------------------------------|
| Node.js   | `>= 20.x`        | Asserted by `scripts/verify-launch.js` (`checkEnvironment`) |
| pnpm      | `10.0.0`         | Pinned via root `packageManager` field + corepack    |
| corepack  | bundled with Node | Used to invoke pnpm; no global install required     |
| npm       | bundled with Node | Used only by the CI `rss-engine` job (`npm ci`)      |

No global `tsx` or `typescript` is required — both are installed as
devDependencies of `rss-engine/` by the postinstall hook.

## Required environment variables

The launch pipeline (`pnpm verify:launch`) does **not** require any
secrets. The simulation harnesses run entirely in-process against the
in-memory `fakeSupabase` helper and emit deterministic output.

For *runtime* (not validation) execution of `rss:start` / `rss:worker`,
the variables documented in `rss-engine/.env.example` apply.

## Runnable commands — root

| Command                             | Purpose                                                                 | Expected runtime | Expected output (terminal) | Failure semantics |
|-------------------------------------|-------------------------------------------------------------------------|------------------|----------------------------|-------------------|
| `pnpm install`                      | Install root + every external package root (admin-panel, mobile-app, rss-engine). | 5–60 s (cold), <2 s (warm) | `[postinstall] All external roots installed.` | Non-zero exit if any external install fails. Set `NEWSERA_SKIP_EXTERNAL_INSTALL=1` only for advanced staged installs (e.g. Docker layering). |
| `pnpm dev`                          | Start the admin panel in dev mode.                                      | Long-running    | Vite dev server URL        | Vite-controlled; Ctrl+C to stop. |
| `pnpm build`                        | Build the admin panel for production.                                   | 10–60 s         | `dist/` build summary      | Non-zero on TypeScript/Vite error. |
| `pnpm rss:start`                    | Boot the RSS engine entry point (`rss-engine/index.js`).                | Long-running    | RSS engine logs            | Requires Supabase env vars. |
| `pnpm rss:worker`                   | Boot legacy worker (`rss-engine/worker.js`).                            | Long-running    | Worker logs                | Same as above. |
| `pnpm rss:worker:v2`                | Boot the typed worker (`workers/rss-worker.ts`).                        | Long-running    | Worker logs                | Same as above. |
| `pnpm queue:runner`                 | Boot the queue runner.                                                  | Long-running    | Queue logs                 | Same as above. |
| `pnpm test`                         | **Sanity suite** — runs the queue simulation only.                      | ~6 s            | `All simulations passed.`  | Non-zero on assertion failure. |
| `pnpm test:queue`                   | Phase B queue runner simulation.                                        | ~6 s            | `All simulations passed.`  | Non-zero on assertion failure. |
| `pnpm test:notification`            | Phase C notification dispatch simulation.                               | ~0.3 s          | `All notification simulations passed.` | Non-zero on assertion failure. |
| `pnpm test:personalization`         | Phase D personalization/ranking simulation.                             | ~0.3 s          | `All personalization simulations passed.` | Non-zero on assertion failure. |
| `pnpm test:phaseE`                  | Phase E production hardening simulation.                                | ~0.3 s          | `Phase E simulation: OK`   | Non-zero on assertion failure. |
| `pnpm test:phaseF`                  | Phase F rollout/stabilization simulation.                               | ~0.3 s          | `Phase F simulation: OK`   | Non-zero on assertion failure. |
| `pnpm test:phaseG`                  | Phase G productionization simulation (134 assertions).                  | ~0.3 s          | `Phase G simulation: OK`   | Non-zero on assertion failure. |
| `pnpm test:all`                     | Runs every phase simulation sequentially via `scripts/run-all-tests.js`. Fail-fast. | ~7–8 s | `=== Simulation summary ===` + per-suite timing | Stops at first failing suite, propagates exit code. |
| `pnpm validate:scripts`             | Script drift detector. Verifies every script target file exists, every delegation maps to a real target, no duplicate aliases, no self-recursion. | <2 s | `[validateScripts] OK — checked N scripts across 3 packages` | Exit 1 with itemized issues. |
| `pnpm lint`                         | `pnpm -r --if-present run lint` (admin-panel + rss-engine + mobile-app where present). | 1–3 s | Per-package lint output | Non-zero on any failure. |
| `pnpm typecheck`                    | `pnpm -r --if-present run typecheck` across the workspace.              | 5–15 s          | Per-package `tsc --noEmit` output | Non-zero on any TS error. |
| `pnpm verify`                       | Pre-push gate: lint + typecheck + sanity test (`pnpm test`).            | 15–25 s         | `[verify] Pipeline summary` | Stops at first failure. |
| `pnpm verify:launch`                | **Launch readiness pipeline.** See section below.                       | 20–40 s         | `[verify:launch] ALL GATES PASSED ✅` | Stops at first failure. |

## Runnable commands — rss-engine (used directly during local debugging)

| Command (from `rss-engine/`)        | Notes |
|-------------------------------------|-------|
| `pnpm install --ignore-workspace`   | Installs the engine's own devDeps (tsx, typescript, @types/node). The `--ignore-workspace` flag is required because the engine is *not* part of the monorepo workspace. |
| `pnpm run test:queue` … `test:phaseG` | Same harnesses listed above, invoked directly without the proxy chain. |
| `pnpm run test:all`                 | Sequential runner. |
| `pnpm run validate:scripts`         | Script drift detector. |
| `npm ci && npm run lint && npm run typecheck` | CI mirror — exactly what `.github/workflows/ci.yml :: rss-engine` executes. |

## `pnpm verify:launch` — gate-by-gate

`scripts/verify-launch.js` runs these gates in order and fails fast:

| # | Gate                    | Implementation                                              | What it proves |
|---|-------------------------|-------------------------------------------------------------|----------------|
| 0 | Environment check        | `checkEnvironment()` in `verify-launch.js`                  | Node ≥ 20, corepack pnpm responds. |
| 1 | Workspace integrity      | `corepack pnpm -r exec node -e "process.exit(0)"`           | Every workspace member's `package.json` is parseable and reachable. |
| 2 | Deps integrity — root    | `corepack pnpm install --frozen-lockfile --prefer-offline`  | Root + workspace lockfile is in sync. |
| 3 | Deps integrity — rss-engine | `pnpm install --frozen-lockfile --ignore-workspace` in `rss-engine/` | Engine lockfile is in sync. |
| 4 | Deps integrity — admin-panel | Same, in `admin-panel/`                                  | Admin lockfile is in sync. |
| 5 | Deps integrity — mobile-app | Same, in `mobile-app/`                                    | Mobile lockfile is in sync. |
| 6 | Script drift validation  | `pnpm validate:scripts`                                     | No dangling refs, no duplicates, no self-recursion. |
| 7 | Typecheck                | `pnpm typecheck` (recursive)                                | TypeScript compiles cleanly everywhere. |
| 8 | Lint                     | `pnpm lint` (recursive)                                     | Static checks pass. |
| 9 | Simulations              | `pnpm test:all`                                             | All Phase B–G harnesses pass with real assertions. |
| 10| Runtime boot checks      | `node --check rss-engine/{index,worker}.js`                 | Production entry points parse without throwing. |

Total wall-clock budget on a warm machine: **~20–25 s**.
Cold (first install) budget: **~60–90 s** depending on network.

## CI behaviour

`.github/workflows/ci.yml` keeps three independent jobs (admin-panel,
rss-engine, mobile-app) so that a failure in one does not mask another.
The `rss-engine` job now additionally runs:

```yaml
- name: Script drift validation
  run: npm run validate:scripts

- name: Simulation suite (Phases B–G)
  run: npm run test:all
```

Non-zero exits from any of those steps fail the workflow. There is no
`continue-on-error` anywhere in the simulation chain.

## Platform compatibility

| Concern                | Mitigation |
|------------------------|------------|
| Shell-specific syntax  | All chaining is done by Node.js spawnSync (`scripts/lib/pipeline.js`, `scripts/run-all-tests.js`, `scripts/install-externals.js`). No `&&`, no `;`, no `\|\|` are executed by the shell. |
| Windows `.cmd` shims   | `spawnSync` is called with `shell: process.platform === 'win32'` only where required (corepack/pnpm shim resolution). |
| Path separators        | `path.join` everywhere; no hard-coded `/`. |
| Globally installed tools | None required. `tsx` and `tsc` are resolved from `rss-engine/node_modules/.bin`. The runner errors out with a clear message if they are missing. |

## Known limitations

* **Live Supabase calls are intentionally not part of `verify:launch`.** The
  simulation harnesses use `workers/tests/fakeSupabase.ts` to keep the
  pipeline hermetic and reproducible. A separate manual smoke test against
  staging Supabase is documented in `docs/RUNTIME_VALIDATION_REPORT.md`.
* **No browser-driven tests.** The admin-panel and mobile-app are covered
  by their own typecheck/build steps; UI integration tests are out of
  scope for Phase H.
* **`mobile-app` lint script is absent.** `pnpm lint` uses `--if-present`
  and silently skips it, which is intentional. This is not a regression.
