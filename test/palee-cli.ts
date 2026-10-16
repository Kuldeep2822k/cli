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
 * `pretest:coverage` and the other pretest hooks all do that.
 */
const ROOT = path.resolve(__dirname, '..');
const underCoverage = Boolean(process.env.NODE_V8_COVERAGE);

/** Node argv prefix (after `process.execPath`) that runs the CLI. */
export const PALEE_ARGV: string[] = underCoverage
  ? ['--import', 'tsx', path.join(ROOT, 'bin', 'palee.ts')]
  : [path.join(ROOT, 'dist', 'bin', 'palee.js')];

/**
 * Shell command prefix for `execSync`-style launches. `process.execPath` is
 * quoted because it can contain spaces (e.g. `C:\Program Files\nodejs`), and
 * it replaces the PATH-resolved `node` so shell launches cannot resolve a
 * different runtime than the `spawnSync(process.execPath, PALEE_ARGV)` ones.
 */
export const PALEE_CMD: string = underCoverage
  ? `"${process.execPath}" --import tsx "${path.join(ROOT, 'bin', 'palee.ts')}"`
  : `"${process.execPath}" "${path.join(ROOT, 'dist', 'bin', 'palee.js')}"`;
