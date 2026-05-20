/**
 * Tiny pipeline runner used by `verify` and `verify:launch`.
 *
 * No third-party deps; cross-platform (no shell features); fail-fast.
 * Returns normally when every step passes (so callers can chain extra
 * inline checks); calls `process.exit` with a non-zero status the moment
 * any step fails or the spawn itself errors.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * @param {string} pipelineName
 * @param {ReadonlyArray<{name: string, cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv}>} steps
 */
function runPipeline(pipelineName, steps) {
  const overallStart = Date.now();
  const results = [];

  for (const step of steps) {
    const started = Date.now();
    const cwd = step.cwd || repoRoot;
    console.log(
      `\n[${pipelineName}] ▶ ${step.name}: ${step.cmd} ${step.args.join(' ')}  (cwd=${path.relative(repoRoot, cwd) || '.'})`
    );

    const result = spawnSync(step.cmd, step.args, {
      cwd,
      stdio: 'inherit',
      env: step.env || process.env,
      shell: process.platform === 'win32'
    });

    const elapsedMs = Date.now() - started;

    if (result.error) {
      console.error(
        `\n[${pipelineName}] ✗ ${step.name} failed to spawn after ${elapsedMs}ms: ${result.error.message}`
      );
      process.exit(2);
    }
    if (typeof result.status !== 'number' || result.status !== 0) {
      console.error(
        `\n[${pipelineName}] ✗ ${step.name} FAILED with exit code ${result.status} after ${elapsedMs}ms`
      );
      process.exit(result.status || 1);
    }
    results.push({ name: step.name, elapsedMs });
    console.log(`[${pipelineName}] ✓ ${step.name} (${elapsedMs}ms)`);
  }

  const totalMs = Date.now() - overallStart;
  console.log(`\n[${pipelineName}] Pipeline summary (${results.length} step(s), ${totalMs}ms total):`);
  for (const r of results) {
    console.log(`  ✓ ${r.name.padEnd(22)} ${r.elapsedMs} ms`);
  }
}

module.exports = { runPipeline };
