#!/usr/bin/env node
/**
 * Phase H — sequential test runner.
 *
 * Runs every simulation harness in deterministic order. Uses the local
 * `tsx` binary directly (no globals, no shell features) so the script
 * works identically on Linux, macOS, and Windows. Exits non-zero on the
 * first failure so the pipeline halts immediately (fail-fast).
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

if (!fs.existsSync(tsxBin)) {
  console.error(
    `[run-all-tests] tsx binary missing at ${tsxBin}. ` +
      `Run "pnpm install" inside rss-engine (or "pnpm install" from the monorepo root) and retry.`
  );
  process.exit(2);
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
  const result = spawnSync(tsxBin, [target], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
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
