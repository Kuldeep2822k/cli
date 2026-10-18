import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Direct `execSync`/`spawnSync`/`execFileSync` calls block their worker with no
 * way back, so an unbounded one that hangs takes the whole test file down and
 * reports nothing about what hung. `runPalee` has carried a 120 s budget since
 * #456; these call sites bypass that helper and were never given one.
 *
 * This guard stops the debt growing. It does not yet enforce it everywhere —
 * `PARTIALLY_BOUNDED` lists the files still on the old footing, and the second
 * test fails if one of them is fully bounded but still listed, so the list can
 * only shrink.
 */
const PARTIALLY_BOUNDED: readonly string[] = [
  'test/cli-adopt-autochain.test.ts',
  'test/cli-adopt-batch.test.ts',
  'test/cli-adopt-pattern-accounting.test.ts',
  'test/cli-adopt-prereq-text.test.ts',
  'test/cli-adopt-preservation.test.ts',
  'test/cli-adopt-single-file-filters.test.ts',
  'test/cli-adopt-undo-disclosure.test.ts',
  'test/cli-commands.test.ts',
  'test/cli-fatal-error-output.test.ts',
  'test/cli-migrate-relabel-ties.test.ts',
  'test/cli-review-early.test.ts',
  'test/cli-roadmap-autochain-head-deps.test.ts',
  'test/cli-roadmap-dry-run.test.ts',
  'test/cli-roadmap-edge-integrity.test.ts',
  'test/cli-roadmap-id-gate.test.ts',
  'test/cli-roadmap-label-staleness.test.ts',
  'test/cli-roadmap-skip-cycle.test.ts',
  'test/cli-roadmap-symlink.test.ts',
  'test/cli-roadmap-wikilink.test.ts',
  'test/cli-session-containment.test.ts',
  'test/cli-vault-echo.test.ts',
];

const CALL = /\b(execSync|spawnSync|execFileSync)\s*\(/;
/** Options for one call can span a dozen lines; look far enough to see `timeout`. */
const OPTIONS_WINDOW_LINES = 12;
/** Matches both `timeout: value` and the `{ timeout }` shorthand property. */
const TIMEOUT_OPTION = /\btimeout\s*:|^\s*timeout\s*[,}]/m;

function collectTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Maps each repo-relative test file to its unbounded direct-spawn calls.
 *
 * @remarks
 * Comment lines are skipped: `palee-cli.ts` names `spawnSync` in prose, and a
 * doc comment is not a call site.
 *
 * @returns Relative path to count of calls with no `timeout` in their options.
 */
function unboundedSpawns(): Map<string, number> {
  const root = path.resolve(__dirname, '..');
  const testDir = path.join(root, 'test');
  const self = path.relative(root, __filename).replace(/\\/g, '/');
  const result = new Map<string, number>();

  for (const abs of collectTestFiles(testDir)) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (rel === self) continue;
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    let unbounded = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!CALL.test(line)) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      const window = lines.slice(i, i + OPTIONS_WINDOW_LINES).join('\n');
      if (!TIMEOUT_OPTION.test(window)) unbounded++;
    }
    if (unbounded > 0) result.set(rel, unbounded);
  }
  return result;
}

describe('direct CLI spawn timeouts', () => {
  test('no unbounded direct spawn outside the shrinking allow-list', () => {
    const found = unboundedSpawns();
    const offenders = [...found.entries()]
      .filter(([rel]) => !PARTIALLY_BOUNDED.includes(rel))
      .map(([rel, count]) => `${rel} (${count})`);
    assert.deepStrictEqual(
      offenders,
      [],
      'every direct execSync/spawnSync/execFileSync must pass `timeout: CLI_SPAWN_TIMEOUT_MS` — ' +
        'an unbounded call hangs its worker with no diagnostic'
    );
  });

  test('the allow-list has no entries that are already fully bounded', () => {
    const found = unboundedSpawns();
    const stale = PARTIALLY_BOUNDED.filter((rel) => !found.has(rel));
    assert.deepStrictEqual(
      stale,
      [],
      `these files are now fully bounded and must be dropped from PARTIALLY_BOUNDED: ${stale.join(', ')}`
    );
  });
});
