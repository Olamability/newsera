#!/usr/bin/env node
/**
 * `pnpm verify` — fast feedback gate: lint + typecheck + sanity test.
 *
 * Designed for local pre-push and quick CI loops. For the full launch
 * gate, see `verify-launch.js`.
 */

'use strict';

const { runPipeline } = require('./lib/pipeline');

runPipeline('verify', [
  { name: 'lint',      cmd: 'corepack', args: ['pnpm', 'run', 'lint'] },
  { name: 'typecheck', cmd: 'corepack', args: ['pnpm', 'run', 'typecheck'] },
  { name: 'test',      cmd: 'corepack', args: ['pnpm', 'run', 'test'] }
]);
