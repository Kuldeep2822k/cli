import fs from 'fs';
import path from 'path';

/**
 * How tests launch the real CLI as a child process.
 *
 * Two launch paths, chosen by whether the parent runs under c8 coverage (which
 * sets NODE_V8_COVERAGE):
 *
 * - Normal runs (`npm test`, `test:e2e`, ...) launch the prebuilt
 *   `dist/bin/palee.js`, so a spawn pays plain Node startup instead of a
 *   per-spawn tsx/esbuild cold start.
 * - Coverage runs launch the TypeScript sources behind `--import tsx`, so
 *   every process in the report compiles with the same transform as the
 *   parent and the coverage maps merge cleanly. A `dist` child compiles with
 *   tsc instead, and the two lineages do not merge: on the #451 attempt
 *   (2026-10-16) each side's function map replaced the other's and function
 *   coverage fell from 94.35% to 87.07%, below the 93% floor. The price of
 *   this path is the per-spawn cold start, which `test:coverage` bounds with
 *   `--test-concurrency=4`.
 *
 * The build must have run first for the dist path; `pretest`,
 * `pretest:coverage` and the other pretest hooks all do that. A direct
 * `node --test` invocation bypasses every hook, so {@link assertDistBuilt}
 * fails at import with that instruction instead of letting each suite report
 * an unrelated-looking child ENOENT.
 */
const ROOT = path.resolve(__dirname, '..');
const underCoverage = Boolean(process.env.NODE_V8_COVERAGE);

/** The built CLI entry point the non-coverage launch path spawns. */
export const PALEE_DIST_ENTRY: string = path.join(ROOT, 'dist', 'bin', 'palee.js');

/**
 * Fails fast, and legibly, when the build has not run.
 *
 * @remarks
 * Every CLI-spawning suite imports this module, so a missing `dist` used to
 * surface as a child-process ENOENT in each of them: ~83 assertion failures
 * that read as unrelated regressions in the code under test rather than one
 * unmet prerequisite. The `exists` probe is injected so the check is testable
 * without deleting the build directory out from under a running suite.
 *
 * @throws {Error} If the dist entry point is absent.
 */
export function assertDistBuilt(entry: string, exists: (p: string) => boolean): void {
  if (exists(entry)) return;
  throw new Error(
    `palee-cli: the built CLI is missing at ${entry}. Tests spawn dist/bin/palee.js ` +
      'unless NODE_V8_COVERAGE is set, so run `npm run build` first — or use `npm test`, ' +
      'whose pretest hook builds it.'
  );
}

// Only the dist lineage can be missing a build; the coverage lineage spawns the
// TypeScript sources, which exist in any checkout.
if (!underCoverage) {
  assertDistBuilt(PALEE_DIST_ENTRY, fs.existsSync);
}

/** Node argv prefix (after `process.execPath`) that runs the CLI. */
export const PALEE_ARGV: string[] = underCoverage
  ? ['--import', 'tsx', path.join(ROOT, 'bin', 'palee.ts')]
  : [PALEE_DIST_ENTRY];

/**
 * Shell command prefix for `execSync`-style launches. `process.execPath` is
 * quoted because it can contain spaces (e.g. `C:\Program Files\nodejs`), and
 * it replaces the PATH-resolved `node` so shell launches cannot resolve a
 * different runtime than the `spawnSync(process.execPath, PALEE_ARGV)` ones.
 */
export const PALEE_CMD: string = underCoverage
  ? `"${process.execPath}" --import tsx "${path.join(ROOT, 'bin', 'palee.ts')}"`
  : `"${process.execPath}" "${PALEE_DIST_ENTRY}"`;
