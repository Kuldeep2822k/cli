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
/** Options for one call can span a dozen lines; look no further than that. */
const OPTIONS_WINDOW_LINES = 12;
/**
 * A line that closes the call: `});`, `}).trim()`, `)`, `);`. Anything after it
 * belongs to some other construct, so its `timeout` must not vouch for this call.
 */
const CLOSES_CALL = /^\s*(?:\}\s*\)|\))/;
/** A line that comments instead of binding: prose cannot set an option. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
/** A trailing comment, safe to cut once quoted spans are blanked. */
const TRAILING_COMMENT = /\/\/.*$/;
/** A `timeout: value` key anchored at the scanned column. */
const TIMEOUT_VALUE_AT = /\btimeout\s*:\s*([^,})\s]+)/y;
/** A `{ timeout }` shorthand key anchored at the scanned column. */
const TIMEOUT_SHORTHAND_AT = /timeout\s*[,}]/y;
/** A value written as a number literal, as opposed to an identifier or expression. */
const NUMERIC_LITERAL = /^[+-]?\d+(?:\.\d+)?$/;
/** One closed quoted span, blanked so a string is never read as code. */
const QUOTED_SPAN = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
/** The object depth of the options argument's own keys, counted from the call. */
const OPTIONS_DEPTH = 1;

/**
 * Every timeout key a line sets, each with the object depth it sits at.
 *
 * @remarks
 * Depth is counted in braces from `fromIndex`, which is the call itself on the
 * window's opening line — so a brace that merely encloses the statement, as in
 * `if (ok) { spawnSync(a, b, { timeout: 1 }); }`, cannot push the options
 * argument a level deeper and turn bounded code into reported debt. Every key
 * on the line is collected, not just the first, so a nested `{ retry: { timeout: 0 } }`
 * ahead of a real top-level `timeout` does not hide it. Quoted spans are
 * blanked and a trailing comment cut before any of this, so neither a brace, a
 * `timeout` in a string, nor one in prose is mistaken for code.
 *
 * @param line - One source line of a call's window.
 * @param enteredAt - Object depth when the line begins.
 * @param fromIndex - Column on this line to count depth from.
 * @returns The keys found (empty value means the `{ timeout }` shorthand) and
 * the depth the line ends at.
 */
function timeoutKeysOnLine(
  line: string,
  enteredAt: number,
  fromIndex: number
): { keys: Array<{ depth: number; value: string }>; exitAt: number } {
  let code = line.replace(QUOTED_SPAN, ' ');
  if (!COMMENT_LINE.test(code)) code = code.replace(TRAILING_COMMENT, ' ');
  const keys: Array<{ depth: number; value: string }> = [];
  let depth = enteredAt;
  for (let i = fromIndex; i < code.length; i++) {
    TIMEOUT_VALUE_AT.lastIndex = i;
    const explicit = TIMEOUT_VALUE_AT.exec(code);
    if (explicit !== null) {
      keys.push({ depth, value: explicit[1] ?? '' });
      i = TIMEOUT_VALUE_AT.lastIndex - 1;
      continue;
    }
    TIMEOUT_SHORTHAND_AT.lastIndex = i;
    if (TIMEOUT_SHORTHAND_AT.exec(code) !== null && opensKey(code, i)) {
      keys.push({ depth, value: '' });
      i = TIMEOUT_SHORTHAND_AT.lastIndex - 1;
      continue;
    }
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  return { keys, exitAt: depth };
}

/**
 * Whether the word at `index` sits in key position rather than value position.
 *
 * @remarks
 * `{ timeout }` and `{ retry: timeout }` differ only by what precedes the word,
 * and telling them apart is the difference between a bound and a false one.
 *
 * @param code - The line with quoted spans already blanked.
 * @param index - Column of the `timeout` occurrence.
 * @returns True when nothing but an object opener or separator precedes it.
 */
function opensKey(code: string, index: number): boolean {
  const before = code.slice(0, index).replace(/\s+$/, '').slice(-1);
  return before === '' || before === '{' || before === ',';
}

/**
 * Whether the lines spanning one call set an active timeout on the call itself.
 *
 * @remarks
 * Three ways a window can look bounded and not be. A `timeout` in a comment
 * binds nothing. `timeout: 0` is Node's "no limit" — the option applies only
 * when non-zero. And a `timeout` below the options argument's own level, as in
 * `{ retry: { timeout: 1 } }`, is a property of some other object, which
 * `spawnSync` ignores: verified against a live child, which ran to completion
 * under a nested `timeout: 1` and died at `ETIMEDOUT` under a top-level one.
 * Anything not statically resolvable — the shorthand, an identifier, a
 * `120_000` separator — counts as bounding the call, since guessing otherwise
 * would flag code that is genuinely bounded.
 *
 * @param window - The source lines belonging to one call, opening line included.
 * @param callIndex - Column of the call on the window's opening line.
 * @returns True when the call carries an active, positive, top-level timeout.
 */
function hasActiveTimeout(window: string[], callIndex: number): boolean {
  let depth = 0;
  for (const [offset, line] of window.entries()) {
    if (COMMENT_LINE.test(line)) continue;
    const scan = timeoutKeysOnLine(line, depth, offset === 0 ? callIndex : 0);
    depth = scan.exitAt;
    for (const key of scan.keys) {
      if (key.depth !== OPTIONS_DEPTH) continue;
      if (!NUMERIC_LITERAL.test(key.value)) return true;
      if (Number(key.value) > 0) return true;
    }
  }
  return false;
}

/**
 * Recursively lists the TypeScript files under a directory.
 *
 * @param dir - Directory to walk.
 * @returns Every `.ts` file beneath it, including nested suites such as `e2e/`.
 */
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
 * Counts direct spawn calls in a source text that carry no active `timeout`.
 *
 * @remarks
 * Each call's window ends at whichever comes first: the closing line of the
 * call, the next call, or the line cap. Without the closing bound a `timeout`
 * belonging to a later construct — a `test('x', { timeout })` option, a nested
 * object — would satisfy an unbounded spawn above it, and without the
 * next-call bound a bounded neighbour would vouch for it. Both are false
 * negatives of exactly the kind this guard exists to catch. Comment lines are
 * skipped outright: `palee-cli.ts` names `spawnSync` in prose, and a `timeout`
 * written in a comment bounds nothing.
 *
 * @param source - Whole file contents to scan.
 * @returns How many call sites lack a timeout that will actually fire.
 */
function countUnboundedSpawns(source: string): number {
  const lines = source.split(/\r?\n/);
  let unbounded = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!CALL.test(line)) continue;
    if (COMMENT_LINE.test(line)) continue;
    let end = Math.min(i + OPTIONS_WINDOW_LINES, lines.length);
    for (let j = i + 1; j < end; j++) {
      const next = lines[j] ?? '';
      if (CALL.test(next) || CLOSES_CALL.test(next)) {
        end = j;
        break;
      }
    }
    if (!hasActiveTimeout(lines.slice(i, end), CALL.exec(line)?.index ?? 0)) unbounded++;
  }
  return unbounded;
}

/**
 * Maps each repo-relative test file to its unbounded direct-spawn calls.
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
    const unbounded = countUnboundedSpawns(fs.readFileSync(abs, 'utf8'));
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

  test('an unbounded call is not vouched for by a bounded neighbour below it', () => {
    // The first draft read a fixed 12-line window that did not stop at the next
    // call, so the second call's `timeout` satisfied the first and the unbounded
    // site passed silently — the exact false negative this guard exists to catch.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      "  encoding: 'utf8',",
      '});',
      'const b = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  timeout: CLI_SPAWN_TIMEOUT_MS,',
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'the first call has no timeout; the second must not cover for it'
    );
  });

  test('a timeout on a later construct does not vouch for the spawn', () => {
    // The window used to run to a fixed line count, so a `timeout` that belongs
    // to something after the call — here a test option, not a spawn option at
    // all — satisfied the unbounded spawn above it.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '});',
      "test('next', { timeout: 5000 }, () => {});",
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'the call closes on line 3; the timeout on line 4 is not its option'
    );
  });

  test('a bounded call is not counted, so the check is not always-red', () => {
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  timeout: CLI_SPAWN_TIMEOUT_MS,',
      '});',
    ].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a commented-out timeout does not bound the call', () => {
    // Matching the key name alone accepted this: the `timeout` exists only in
    // prose, so the spawn it "documents" still blocks its worker forever.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  // timeout: CLI_SPAWN_TIMEOUT_MS,',
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'a timeout written in a comment binds nothing'
    );
  });

  test('a zero-valued timeout is no limit, not a bound', () => {
    // Node applies `timeout` only when it is non-zero, so this call is unbounded
    // despite carrying the option.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  timeout: 0,',
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'timeout: 0 leaves the synchronous spawn unbounded'
    );
  });

  test('a positive numeric timeout bounds the call', () => {
    // The control for the zero case, so rejecting 0 cannot pass by rejecting
    // every literal.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  timeout: 120000,',
      '});',
    ].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('the shorthand property still bounds the call', () => {
    // `runPalee` passes `{ timeout }` by name; the guard recognises that form
    // only through the shorthand branch, so it must not go dead.
    const source = [
      'const timeout = 120000;',
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT,',
      '  timeout,',
      '});',
    ].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a timeout nested in another options object does not bound the call', () => {
    // `{ nested: { timeout: 1 } }` is a property of `nested`, not of the options
    // argument, and `spawnSync` ignores it. Verified against a live child: under
    // a nested `timeout: 1` it ran to completion, under a top-level one it died
    // at `ETIMEDOUT`.
    const source = ['spawnSync(process.execPath, argv, { nested: { timeout: 1 } });'].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'a timeout below the options level binds nothing'
    );
  });

  test('a timeout nested across lines does not bound the call', () => {
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  retry: {',
      '    timeout: 1,',
      '  },',
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'depth carries across lines, so a nested key stays nested'
    );
  });

  test('a timeout inside a string does not bound the call', () => {
    // The key sits at the options level here, so only blanking the quoted span
    // keeps this from reading as `timeout: 5`.
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      "  input: 'palee export --label timeout: 5',",
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'a key inside a quoted span is not an option'
    );
  });

  test('a brace inside a string does not bury the real timeout', () => {
    // Without blanking, the brace in the argument array counts toward depth and
    // the genuine top-level timeout lands at depth 2 — a false positive that
    // would report bounded code as debt.
    const source = ["spawnSync(process.execPath, ['--label', '{'], { timeout: 120000 });"].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a top-level timeout on the call line still bounds the call', () => {
    // The control for the nesting checks, so depth matching cannot pass by
    // rejecting every single-line form.
    const source = ['spawnSync(process.execPath, argv, { timeout: 120000 });'].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a brace that merely encloses the call does not bury its timeout', () => {
    // Depth is counted from the call, not from column 0 of the line. Starting
    // anywhere else turns this into reported debt on genuinely bounded code,
    // and the false positive is permanent: the file must join the allow-list,
    // and dropping it back off then fails the stale-entry assertion.
    const source = [
      'if (enabled) { const r = spawnSync(process.execPath, argv, { timeout: CLI_SPAWN_TIMEOUT_MS }); }',
    ].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a nested key does not hide a real timeout further along the same line', () => {
    // Only the first key used to be examined, so the nested one below decided
    // the verdict and the genuine top-level timeout went unseen.
    const source = [
      'spawnSync(process.execPath, argv, { retry: { timeout: 0 }, timeout: CLI_SPAWN_TIMEOUT_MS });',
    ].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a timeout in a trailing comment does not bound the call', () => {
    const source = [
      'const a = spawnSync(process.execPath, argv, {',
      '  cwd: ROOT, // timeout: CLI_SPAWN_TIMEOUT_MS was dropped here',
      '});',
    ].join('\n');
    assert.strictEqual(
      countUnboundedSpawns(source),
      1,
      'a key after the comment marker is not an option'
    );
  });

  test('an inline shorthand property bounds the call', () => {
    const source = ['spawnSync(process.execPath, argv, { timeout });'].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 0);
  });

  test('a timeout used as a value is not a key', () => {
    // `{ retry: timeout }` sets `retry`; only the column before the word tells
    // this from `{ timeout }`, and getting it backwards would bound nothing.
    const source = ['spawnSync(process.execPath, argv, { retry: timeout });'].join('\n');
    assert.strictEqual(countUnboundedSpawns(source), 1);
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
