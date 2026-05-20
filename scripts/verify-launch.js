#!/usr/bin/env node
/**
 * `pnpm verify:launch` — full launch-readiness pipeline.
 *
 * Runs every Phase H launch gate in deterministic order, fail-fast:
 *
 *   1. Workspace integrity     — `pnpm -r exec node -e ...` resolves every member.
 *   2. Dependency integrity    — `pnpm install --frozen-lockfile` (root + engine).
 *   3. Script drift validator  — `validate:scripts` (no dangling refs).
 *   4. Type check              — `pnpm typecheck` (all workspace members).
 *   5. Lint                    — `pnpm lint`.
 *   6. All simulations         — `pnpm test:all` (queue / notification /
 *                                personalization / phaseE / phaseF / phaseG).
 *   7. Environment verification — Node + pnpm versions inside the supported range.
 *   8. Runtime boot checks     — node --check on the production entry points.
 *
 * Cross-platform: uses spawnSync with explicit argv arrays (no shell
 * features). Exits with the first non-zero status it encounters.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { runPipeline } = require('./lib/pipeline');

const repoRoot = path.resolve(__dirname, '..');
const engineDir = path.join(repoRoot, 'rss-engine');

// ---------------------------------------------------------------------------
// Environment / runtime boot pre-checks (run inline so we can short-circuit
// before invoking heavier pipeline steps).
// ---------------------------------------------------------------------------

function checkEnvironment() {
  const required = 20;
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < required) {
    console.error(
      `[verify:launch] Node.js >= ${required}.x required, found ${process.versions.node}`
    );
    process.exit(1);
  }
  const pnpm = spawnSync('corepack', ['pnpm', '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  if (pnpm.status !== 0) {
    console.error('[verify:launch] corepack pnpm --version failed.');
    process.exit(1);
  }
  console.log(
    `[verify:launch] Environment OK — node=${process.versions.node}, pnpm=${pnpm.stdout.trim()}`
  );
}

function checkBootTargets() {
  const targets = [
    path.join(engineDir, 'index.js'),
    path.join(engineDir, 'worker.js')
  ];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      console.error(`[verify:launch] runtime boot target missing: ${target}`);
      process.exit(1);
    }
    const res = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`[verify:launch] node --check failed for ${target}`);
      process.exit(res.status || 1);
    }
  }
  console.log('[verify:launch] Runtime boot targets parse cleanly.');
}

checkEnvironment();

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

runPipeline('verify:launch', [
  // 1. Workspace integrity: lists every workspace member; pnpm exits non-zero
  //    if the workspace file is broken or a member's package.json is invalid.
  {
    name: 'workspace-integrity',
    cmd: 'corepack',
    args: ['pnpm', '-r', 'exec', 'node', '-e', 'process.exit(0)']
  },

  // 2. Dependency integrity for the workspace (root + apps + services + packages).
  {
    name: 'deps-integrity-root',
    cmd: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']
  },

  // 3. Dependency integrity for the standalone external package roots.
  {
    name: 'deps-integrity-rss',
    cmd: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile', '--ignore-workspace', '--prefer-offline'],
    cwd: engineDir
  },
  {
    name: 'deps-integrity-admin',
    cmd: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile', '--ignore-workspace', '--prefer-offline'],
    cwd: path.join(repoRoot, 'admin-panel')
  },
  {
    name: 'deps-integrity-mobile',
    cmd: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile', '--ignore-workspace', '--prefer-offline'],
    cwd: path.join(repoRoot, 'mobile-app')
  },

  // 4. Script drift validator.
  {
    name: 'script-validation',
    cmd: 'corepack',
    args: ['pnpm', 'run', 'validate:scripts']
  },

  // 5. Type check.
  {
    name: 'typecheck',
    cmd: 'corepack',
    args: ['pnpm', 'run', 'typecheck']
  },

  // 6. Lint.
  {
    name: 'lint',
    cmd: 'corepack',
    args: ['pnpm', 'run', 'lint']
  },

  // 7. All simulations.
  {
    name: 'simulations',
    cmd: 'corepack',
    args: ['pnpm', 'run', 'test:all']
  }
]);

// 8. Runtime boot checks (run after pipeline so we only do them if the rest passed).
checkBootTargets();

console.log('\n[verify:launch] ALL GATES PASSED ✅');
