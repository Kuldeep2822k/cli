import path from 'path';

/**
 * How tests launch the real CLI as a child process.
 *
 * Under c8 coverage (which sets NODE_V8_COVERAGE), run the TypeScript source via
 * tsx so collected coverage maps back to `src/**`. Otherwise run the prebuilt
 * `dist/bin/palee.js` directly, which avoids a per-spawn tsx/esbuild cold start
 * and is dramatically faster for the normal (non-coverage) test runs.
 */
const ROOT = path.resolve(__dirname, '..');
const underCoverage = Boolean(process.env.NODE_V8_COVERAGE);

/** Node argv prefix (after `process.execPath`) that runs the CLI. */
export const PALEE_ARGV: string[] = underCoverage
  ? ['--import', 'tsx', path.join(ROOT, 'bin', 'palee.ts')]
  : [path.join(ROOT, 'dist', 'bin', 'palee.js')];

/** Shell command prefix for `execSync`-style launches (path already quoted). */
export const PALEE_CMD: string = underCoverage
  ? `node --import tsx "${path.join(ROOT, 'bin', 'palee.ts')}"`
  : `node "${path.join(ROOT, 'dist', 'bin', 'palee.js')}"`;
