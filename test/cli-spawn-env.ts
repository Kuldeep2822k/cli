/**
 * Environment and budget helpers for suites that spawn a child process, kept in
 * a module that asserts nothing about the build.
 *
 * @remarks
 * #565 P1-11 review: these two lived in `test/palee-cli.ts`, which performs a
 * module-level `dist/bin/palee.js` check because most of its exports describe the
 * *built* CLI. A suite that only launches `tsx` against `src` — the timezone
 * matrix does exactly that — still inherited the prerequisite, so a targeted
 * `node --import tsx --test test/timezone-matrix.test.ts` failed on a clean
 * checkout before a single assertion ran.
 *
 * They live here now, and `test/palee-cli.ts` re-exports them so every existing
 * importer is unchanged.
 */

/**
 * The parent environment with `NODE_V8_COVERAGE` removed.
 *
 * @param env - Environment to copy; defaults to the parent's
 * @returns A child environment that will not write its own coverage
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
