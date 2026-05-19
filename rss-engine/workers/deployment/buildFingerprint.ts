/**
 * Phase G — Build fingerprint.
 *
 * Deterministic, content-addressed identifier for a build artifact set.
 * Used by the release orchestrator and deployment lineage to detect
 * accidental redeploys, prove blue/green parity, and resolve "what code
 * was actually shipped" after the fact.
 *
 * Pure compute. No I/O.
 */

export interface BuildInputs {
  /** Short identifier set by CI — e.g. "build-2412". */
  buildId: string;
  gitSha: string;
  gitBranch: string;
  /** Map of package name → checksum / hash of the build artifact. */
  packageHashes: Record<string, string>;
  /** Names of feature flags compiled into the binary. */
  compiledFlags: string[];
  /** Build environment markers — node version, OS, etc. */
  environmentMarkers: Record<string, string>;
}

export interface BuildFingerprint {
  buildId: string;
  gitSha: string;
  gitBranch: string;
  /** Content hash over the deterministic representation. */
  contentHash: string;
  /** Hash over just the packageHashes set — handy for "code changed?" check. */
  artifactHash: string;
  /** Hash over compiledFlags only. */
  flagsHash: string;
  createdAt: string;
  packageCount: number;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortedKeys<T extends Record<string, unknown>>(obj: T): string[] {
  return Object.keys(obj).sort();
}

export function computeBuildFingerprint(
  input: BuildInputs,
  now: () => Date = () => new Date(),
): BuildFingerprint {
  const pkgPart = sortedKeys(input.packageHashes)
    .map((k) => `${k}=${input.packageHashes[k]}`)
    .join('|');
  const flagsPart = [...input.compiledFlags].sort().join(',');
  const envPart = sortedKeys(input.environmentMarkers)
    .map((k) => `${k}=${input.environmentMarkers[k]}`)
    .join('|');

  const artifactHash = fnv1a(pkgPart);
  const flagsHash = fnv1a(flagsPart);
  const contentHash = fnv1a(
    [input.gitSha, input.gitBranch, artifactHash, flagsHash, fnv1a(envPart)].join('::'),
  );

  return {
    buildId: input.buildId,
    gitSha: input.gitSha,
    gitBranch: input.gitBranch,
    contentHash,
    artifactHash,
    flagsHash,
    createdAt: now().toISOString(),
    packageCount: Object.keys(input.packageHashes).length,
  };
}

/** Strict equality on the content hash. */
export function fingerprintMatches(a: BuildFingerprint, b: BuildFingerprint): boolean {
  return a.contentHash === b.contentHash;
}

/** True only if code AND compiled flags are identical. */
export function fingerprintIsRedeploy(a: BuildFingerprint, b: BuildFingerprint): boolean {
  return a.artifactHash === b.artifactHash && a.flagsHash === b.flagsHash;
}
