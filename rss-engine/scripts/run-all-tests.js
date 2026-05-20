#!/usr/bin/env node
/**
 * Phase H — sequential test runner.
 *
 * Runs every simulation harness in deterministic order. Spawns the
 * current Node executable (`process.execPath`) and points it at the
 * portable `tsx/cli` ES module entry — never a `.cmd`/`.ps1`
 * shim — so the script works identically on:
 *
 *   • Linux / macOS
 *   • Windows CMD
 *   • Windows PowerShell
 *   • Windows Git Bash / MINGW64 (where spawning `.cmd` files produces
 *     EINVAL because Node's libuv refuses to launch non-`.exe` images
 *     without `shell: true`, which we deliberately avoid).
 *
 * Exits non-zero on the first failure so the pipeline halts immediately
 * (fail-fast).
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Environment / shell detection (informational; logged so CI artifacts make
// it obvious which shell we ran under when triaging Windows-specific bugs).
// ---------------------------------------------------------------------------

function detectShellEnvironment() {
  const isWin = process.platform === 'win32';
  // Git Bash / MSYS2 / MINGW set one or more of these; PowerShell and CMD
  // do not. `MSYSTEM` is the canonical signal (MINGW64, MINGW32, MSYS).
  const msystem = process.env.MSYSTEM || '';
  const isMingw =
    Boolean(msystem) ||
    /mingw|msys/i.test(process.env.TERM_PROGRAM || '') ||
    /(^|[\\/])(bash|sh)\.exe$/i.test(process.env.SHELL || '');
  let label;
  if (!isWin) {
    label = `${process.platform} (${process.arch})`;
  } else if (isMingw) {
    label = `Windows Git Bash / MINGW (${msystem || 'detected'})`;
  } else if (process.env.PSModulePath) {
    label = 'Windows PowerShell / pwsh';
  } else {
    label = 'Windows CMD';
  }
  return { isWin, isMingw, label };
}

const shellEnv = detectShellEnvironment();

// ---------------------------------------------------------------------------
// Resolve the tsx CLI entry as a plain ES module file path. We never invoke
// the `.bin/tsx(.cmd)` shim — that path triggers spawnSync EINVAL on Git
// Bash / MINGW64 because libuv will not exec a `.cmd` without `shell: true`,
// and `shell: true` is explicitly forbidden by this script's contract.
// ---------------------------------------------------------------------------

function resolveTsxCli() {
  // Prefer the package-relative resolution so we follow normal Node module
  // resolution rules (works in pnpm's nested store, npm hoisted layouts,
  // and plain `node_modules` alike).
  const candidates = [
    // Modern tsx exports this stable subpath.
    'tsx/cli',
    'tsx/dist/cli.mjs',
    // Older tsx releases shipped the CLI at `dist/cli.js`; keep as a
    // best-effort fallback so a minor version bump doesn't break us.
    'tsx/dist/cli.js'
  ];
  const errors = [];
  for (const spec of candidates) {
    try {
      return require.resolve(spec, { paths: [repoRoot, __dirname] });
    } catch (err) {
      errors.push(`${spec}: ${err && err.message ? err.message : err}`);
    }
  }
  console.error(
    `[run-all-tests] Unable to resolve the tsx CLI entry from ${repoRoot}.\n` +
      `Tried:\n  - ${errors.join('\n  - ')}\n` +
      `Run "pnpm install" inside rss-engine (or "pnpm install" from the monorepo root) and retry.`
  );
  process.exit(2);
}

const tsxCli = resolveTsxCli();

if (!fs.existsSync(tsxCli)) {
  console.error(
    `[run-all-tests] resolved tsx CLI does not exist on disk: ${tsxCli}. ` +
      `Run "pnpm install" inside rss-engine and retry.`
  );
  process.exit(2);
}

console.log(
  `[run-all-tests] shell=${shellEnv.label}; node=${process.execPath}; tsx=${path.relative(repoRoot, tsxCli) || tsxCli}`
);
if (shellEnv.isWin && shellEnv.isMingw) {
  console.log(
    '[run-all-tests] Git Bash/MINGW detected — spawning Node directly with the tsx ESM entry (no .cmd shim, no shell:true).'
  );
}

const suites = [
  { name: 'queue',           file: 'workers/tests/queueRunner.simulation.ts'    },
  { name: 'notification',    file: 'workers/tests/notification.simulation.ts'   },
  { name: 'personalization', file: 'workers/tests/personalization.simulation.ts'},
  { name: 'phaseE',          file: 'workers/tests/phaseE.simulation.ts'         },
  { name: 'phaseF',          file: 'workers/tests/phaseF.simulation.ts'         },
  { name: 'phaseG',          file: 'workers/tests/phaseG.simulation.ts'         }
];

const results = [];
const overallStart = Date.now();

for (const suite of suites) {
  const target = path.join(repoRoot, suite.file);
  if (!fs.existsSync(target)) {
    console.error(`[run-all-tests] missing harness: ${suite.file}`);
    process.exit(2);
  }
  const started = Date.now();
  console.log(`\n=== Running ${suite.name} (${suite.file}) ===`);
  // Portable invocation: Node executable + tsx ESM CLI + simulation file.
  // No `.cmd` shim, no `shell: true` — works on Linux, macOS, Windows CMD,
  // PowerShell, and Git Bash / MINGW64.
  const result = spawnSync(process.execPath, [tsxCli, target], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    shell: false,
    windowsHide: true
  });
  const elapsedMs = Date.now() - started;
  if (result.error) {
    console.error(`[run-all-tests] failed to spawn ${suite.name}:`, result.error.message);
    process.exit(2);
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    console.error(
      `[run-all-tests] ${suite.name} FAILED with exit code ${result.status} after ${elapsedMs}ms`
    );
    process.exit(result.status || 1);
  }
  results.push({ name: suite.name, elapsedMs });
}

const totalMs = Date.now() - overallStart;
console.log('\n=== Simulation summary ===');
for (const r of results) {
  console.log(`  ✓ ${r.name.padEnd(16)} ${r.elapsedMs} ms`);
}
console.log(`Total: ${results.length} suites in ${totalMs} ms`);
