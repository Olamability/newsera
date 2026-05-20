#!/usr/bin/env node
/**
 * Root postinstall hook — install the external package roots.
 *
 * Several apps/services in this monorepo (admin-panel, mobile-app,
 * rss-engine) live OUTSIDE the pnpm workspace by design. The workspace
 * members under `apps/` and `services/` are thin proxies that delegate
 * to the real package directories. Without this hook, a clean
 * `pnpm install` from the root leaves those external roots without
 * node_modules and `pnpm verify:launch` cannot succeed end-to-end.
 *
 * For each external root: run `pnpm install --ignore-workspace`
 * (frozen if the lockfile is satisfied, refreshed otherwise) so that
 * `tsx`, `tsc`, vite/client typings, and other devDeps are present on
 * a clean machine.
 *
 * Guards:
 *   - NEWSERA_SKIP_EXTERNAL_INSTALL=1 disables the hook entirely.
 *   - NEWSERA_EXTERNAL_INSTALL_IN_PROGRESS=1 prevents recursion if a
 *     nested install ever re-enters this hook.
 *
 * Idempotent and cross-platform (no shell features; spawnSync on
 * explicit argv arrays).
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

if (process.env.NEWSERA_SKIP_EXTERNAL_INSTALL === '1') {
  console.log('[postinstall] NEWSERA_SKIP_EXTERNAL_INSTALL=1, skipping external installs.');
  process.exit(0);
}
if (process.env.NEWSERA_EXTERNAL_INSTALL_IN_PROGRESS === '1') {
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');

const externals = [
  { name: 'rss-engine',  dir: path.join(repoRoot, 'rss-engine')  },
  { name: 'admin-panel', dir: path.join(repoRoot, 'admin-panel') },
  { name: 'mobile-app',  dir: path.join(repoRoot, 'mobile-app')  }
];

const env = { ...process.env, NEWSERA_EXTERNAL_INSTALL_IN_PROGRESS: '1' };

function installOne(name, dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    console.warn(`[postinstall] ${name}: package.json missing at ${dir}, skipping.`);
    return true;
  }

  // Try corepack-managed pnpm first (matches the root packageManager).
  // Fall back to bare `pnpm` if corepack is not available. Within each
  // candidate, try a frozen install first; if the lockfile drifted, retry
  // with --no-frozen-lockfile so a clean install still succeeds.
  const candidates = [
    { cmd: 'corepack', baseArgs: ['pnpm', 'install', '--ignore-workspace'] },
    { cmd: 'pnpm',     baseArgs: ['install', '--ignore-workspace'] }
  ];

  for (const { cmd, baseArgs } of candidates) {
    for (const extra of [['--frozen-lockfile'], ['--no-frozen-lockfile']]) {
      const args = [...baseArgs, ...extra];
      console.log(`[postinstall] ${name}: ${cmd} ${args.join(' ')}`);
      const result = spawnSync(cmd, args, {
        cwd: dir,
        stdio: 'inherit',
        env,
        shell: process.platform === 'win32'
      });
      if (!result.error && result.status === 0) {
        return true;
      }
      // ENOENT for the binary: try the next candidate altogether.
      if (result.error && /** @type {any} */ (result.error).code === 'ENOENT') {
        break;
      }
    }
  }
  return false;
}

let ok = true;
for (const { name, dir } of externals) {
  console.log(`\n[postinstall] === Installing ${name} ===`);
  if (!installOne(name, dir)) {
    console.error(`[postinstall] FAILED to install ${name}`);
    ok = false;
    break;
  }
}

if (!ok) {
  process.exit(1);
}
console.log('\n[postinstall] All external roots installed.');
