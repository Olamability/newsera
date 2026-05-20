/**
 * Phase H — script-drift detector.
 *
 * Validates that every script declared by the workspace is real, runnable,
 * and consistent:
 *
 *   1. Every script target file (e.g. `tsx workers/tests/foo.ts`) exists.
 *   2. Every root script that delegates with `pnpm --filter @newsera/rss-engine <s>`
 *      maps to a script that exists in `services/rss-engine/package.json`.
 *   3. Every services/rss-engine proxy script that delegates with
 *      `pnpm --dir ../../rss-engine run <s>` maps to a script that exists
 *      in `rss-engine/package.json`.
 *   4. No script invokes itself recursively (no `npm/pnpm run <same-name>`).
 *   5. No duplicate script aliases inside a single package.
 *
 * Exits non-zero on the first failure category; prints a summary so CI logs
 * are easy to diagnose. The validator has zero runtime dependencies and is
 * safe to run on a clean machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

interface PackageManifest {
  readonly absolutePath: string;
  readonly directory: string;
  readonly name: string;
  readonly scripts: Record<string, string>;
  readonly rawScriptsText: string;
}

interface Issue {
  readonly package: string;
  readonly script?: string;
  readonly message: string;
}

const issues: Issue[] = [];

function loadManifest(relPath: string): PackageManifest {
  const absolutePath = path.join(repoRoot, relPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
  return {
    absolutePath,
    directory: path.dirname(absolutePath),
    name: parsed.name ?? relPath,
    scripts: parsed.scripts ?? {},
    rawScriptsText: raw
  };
}

// ---------------------------------------------------------------------------
// 1. Manifests under inspection
// ---------------------------------------------------------------------------

const root = loadManifest('package.json');
const proxy = loadManifest('services/rss-engine/package.json');
const engine = loadManifest('rss-engine/package.json');

// ---------------------------------------------------------------------------
// 2. Duplicate alias detection (JSON parses dedupe; raw text is the oracle)
// ---------------------------------------------------------------------------

function detectDuplicates(pkg: PackageManifest): void {
  const re = /"([A-Za-z0-9:_\-]+)"\s*:\s*"/g;
  const seen = new Set<string>();
  // Narrow to the "scripts" object slice.
  const scriptsStart = pkg.rawScriptsText.indexOf('"scripts"');
  if (scriptsStart < 0) return;
  const openBrace = pkg.rawScriptsText.indexOf('{', scriptsStart);
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < pkg.rawScriptsText.length; i++) {
    const ch = pkg.rawScriptsText[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const slice = pkg.rawScriptsText.slice(openBrace, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const key = m[1];
    if (seen.has(key)) {
      issues.push({
        package: pkg.name,
        script: key,
        message: `duplicate script alias "${key}" in ${path.relative(repoRoot, pkg.absolutePath)}`
      });
    } else {
      seen.add(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Recursive self-invocation detector
// ---------------------------------------------------------------------------

function detectRecursion(pkg: PackageManifest): void {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    // A self-invocation looks like `... run <name>` or `... pnpm <name>` where
    // the alias targets the same package. The proxy/root packages purposely
    // delegate via `--filter` or `--dir`, which is *not* self-invocation.
    const reSelf = new RegExp(`(?:pnpm|npm|yarn)\\s+(?:run\\s+)?${name}(?:\\s|$)`);
    if (
      reSelf.test(body) &&
      !/--filter\s/.test(body) &&
      !/--dir\s/.test(body)
    ) {
      issues.push({
        package: pkg.name,
        script: name,
        message: `script "${name}" appears to invoke itself recursively: ${body}`
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. File-target existence
// ---------------------------------------------------------------------------

function detectMissingTargets(pkg: PackageManifest): void {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    // Capture tokens that look like relative paths to source files.
    const reFiles = /(?<![\w.\/-])((?:workers|src|scripts|utils|config)\/[A-Za-z0-9_\-./]+\.(?:ts|js|mjs|cjs))/g;
    let m: RegExpExecArray | null;
    while ((m = reFiles.exec(body)) !== null) {
      const rel = m[1];
      const abs = path.join(pkg.directory, rel);
      if (!fs.existsSync(abs)) {
        issues.push({
          package: pkg.name,
          script: name,
          message: `script "${name}" references missing file "${rel}" (expected at ${path.relative(repoRoot, abs)})`
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Cross-package delegation integrity
// ---------------------------------------------------------------------------

function detectDelegationDrift(
  pkg: PackageManifest,
  filterPattern: RegExp,
  targetPkg: PackageManifest,
  delegationLabel: string
): void {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    const match = body.match(filterPattern);
    if (!match) continue;
    const targetScript = match[1];
    if (!(targetScript in targetPkg.scripts)) {
      issues.push({
        package: pkg.name,
        script: name,
        message:
          `script "${name}" delegates ${delegationLabel} to "${targetScript}" ` +
          `but ${targetPkg.name} (${path.relative(repoRoot, targetPkg.absolutePath)}) does not declare it`
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Execute checks
// ---------------------------------------------------------------------------

for (const pkg of [root, proxy, engine]) {
  detectDuplicates(pkg);
  detectRecursion(pkg);
  detectMissingTargets(pkg);
}

// Root delegates with `--filter @newsera/rss-engine <script>`.
detectDelegationDrift(
  root,
  /--filter\s+@newsera\/rss-engine\s+([A-Za-z0-9:_\-]+)/,
  proxy,
  'via --filter'
);

// Proxy delegates with `--dir ../../rss-engine run <script>`.
detectDelegationDrift(
  proxy,
  /--dir\s+\.\.\/\.\.\/rss-engine\s+run\s+([A-Za-z0-9:_\-]+)/,
  engine,
  'via --dir'
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const checkedScripts =
  Object.keys(root.scripts).length +
  Object.keys(proxy.scripts).length +
  Object.keys(engine.scripts).length;

if (issues.length === 0) {
  console.log(
    `[validateScripts] OK — checked ${checkedScripts} scripts across 3 packages, no drift detected.`
  );
  process.exit(0);
}

console.error(`[validateScripts] FAIL — ${issues.length} issue(s):`);
for (const issue of issues) {
  const where = issue.script ? `${issue.package}#${issue.script}` : issue.package;
  console.error(`  - [${where}] ${issue.message}`);
}
process.exit(1);
