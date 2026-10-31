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
 *   parent and the coverage maps merge cleanly. tsx resolves its tsconfig
 *   from the process cwd, so a child started from another working directory
 *   must point `TSX_TSCONFIG_PATH` at the repository config or it compiles a
 *   second lineage. A `dist` child compiles with tsc instead, and the two
 *   lineages do not merge: on the #451 attempt (2026-10-16) each side's
 *   function map replaced the other's and function coverage fell from 94.35%
 *   to 87.07%, below the 93% floor. The price of this path is the per-spawn
 *   cold start, which `test:coverage` bounds with `--test-concurrency=4`.
 *
 * The build must have run first for the dist path; `pretest`,
 * `pretest:coverage` and the other pretest hooks all do that. A direct
 * `node --test` invocation bypasses every hook, so {@link assertDistBuilt}
 * fails at import with that instruction instead of letting each suite report
 * an unrelated-looking child ENOENT.
 */
const ROOT = path.resolve(__dirname, '..');

/**
 * Whether the suite is running under c8 coverage (`test:coverage`).
 *
 * @remarks
 * `PALEE_ARGV` selects the launch path from this flag; suites that spawn from
 * a foreign working directory also read it to decide whether the child needs
 * the `TSX_TSCONFIG_PATH` pin described above.
 */
export const underCoverage = Boolean(process.env.NODE_V8_COVERAGE);

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
 * Node argv prefix that launches the built CLI in both launch modes.
 *
 * @remarks
 * `PALEE_ARGV` swaps to the TypeScript sources whenever coverage is on, so a
 * `test:coverage` run never executes `dist/bin/palee.js` — the file the
 * tarball ships. CI's matrix legs run `test:coverage` and nothing else, so an
 * artifact check written against `PALEE_ARGV` proves nothing about the built
 * CLI exactly where CI would notice. Suites that exist to prove the built CLI
 * starts use this prefix with {@link withoutCoverage}; `pretest:coverage`
 * builds `dist` first, so the entry point is present in both modes.
 */
export const PALEE_DIST_ARGV: string[] = [PALEE_DIST_ENTRY];

/**
 * The parent environment with `NODE_V8_COVERAGE` removed.
 *
 * @remarks
 * A `dist` child instrumented into the same directory as the `tsx` children
 * compiles with tsc, and the two lineages do not merge: on the #451 attempt
 * each side's function map replaced the other's and function coverage fell
 * from 94.35% to 87.07%. Dropping the variable for these launches keeps the
 * artifact check honest without moving the floor.
 */
export function withoutCoverage(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.NODE_V8_COVERAGE;
  return child;
}

/**
 * Shell command prefix for `execSync`-style launches. `process.execPath` is
 * quoted because it can contain spaces (e.g. `C:\Program Files\nodejs`), and
 * it replaces the PATH-resolved `node` so shell launches cannot resolve a
 * different runtime than the `spawnSync(process.execPath, PALEE_ARGV)` ones.
 */
export const PALEE_CMD: string = underCoverage
  ? `"${process.execPath}" --import tsx "${path.join(ROOT, 'bin', 'palee.ts')}"`
  : `"${process.execPath}" "${PALEE_DIST_ENTRY}"`;

/**
 * Per-spawn budget for a CLI child process launched directly.
 *
 * @remarks
 * `execSync` and `spawnSync` block their worker with no way back, so an
 * unbounded call that hangs takes the whole file down and reports nothing about
 * what hung. 120 s is roughly two orders of magnitude above the slowest single
 * invocation measured across the direct-spawn suites (all under 1 s; the
 * multi-spawn suites that aggregate several calls top out near 32 s), and it is
 * the budget `runPalee` has carried in `test/e2e/test-env.ts` since #456, so
 * both launch styles fail on the same clock.
 */
export const CLI_SPAWN_TIMEOUT_MS = 120_000;
