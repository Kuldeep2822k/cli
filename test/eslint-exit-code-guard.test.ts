import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ESLint, Linter } from 'eslint';

// The parser is required, not imported: its `exports` map is invisible to this repo's
// `moduleResolution`, and a default import hands `Linter` an object with no
// `parseForESLint` — which then falls back to espree and reports a parse error per file.
const tsParser = require('@typescript-eslint/parser');

/**
 * #207 armed a `no-restricted-syntax` pattern so a command handler cannot write
 * `process.exitCode = 2` where `src/cli/exit-codes.ts` requires `ExitCode.Usage`. CI does
 * run the linter through `npm run check`, but the rule drew all its authority from the
 * config file: deleting the pattern left every gate green, because
 * `test/cli-exit-codes.test.ts` compares handlers against numeric literals and nothing
 * read the config back. These tests do.
 *
 * The rules are asked of ESLint itself: `calculateConfigForFile` returns what the linter
 * would really run for a path, so nothing here copies the selector or the `files` globs,
 * and nothing imports `eslint.config.mjs` as ESM — under `tsx` that reaches `require(esm)`,
 * unflagged only from Node 22.12, which the 22.x CI legs run.
 */

type ExitCodePattern = { selector: string; message: string };

const root = path.resolve(__dirname, '..');
const configFile = path.join(root, 'eslint.config.mjs');

/** The rule the exit-code guard lives under. */
const GUARD = 'no-restricted-syntax';
/** The type-aware rule that shipped code satisfies and the harness deliberately does not. */
const TYPE_AWARE = '@typescript-eslint/no-floating-promises';
/** Files the shipped-code block must cover, and the one it must not. */
const SHIPPED_FILE = 'src/cli/exit-codes.ts';
const BIN_FILE = 'bin/palee.ts';
const HARNESS_FILE = 'test/cli-exit-codes.test.ts';

const resolver = new ESLint({ cwd: root, overrideConfigFile: configFile });

/** The rules ESLint resolves for one path; empty resolution is a failure, not a pass. */
async function rulesFor(file: string): Promise<Record<string, unknown>> {
  const config = await resolver.calculateConfigForFile(file);
  const rules = config.rules as Record<string, unknown> | undefined;
  assert.ok(rules !== undefined && Object.keys(rules).length > 0, `ESLint resolved no rules at all for ${file}`);
  return rules;
}

/** ESLint accepts `'error'` or `2` and resolves both to severity 2; an absent rule has none. */
function severityOf(definition: unknown): number | undefined {
  const level = Array.isArray(definition) ? definition[0] : definition;
  if (level === 'error') return 2;
  if (level === 'warn') return 1;
  if (level === 'off') return 0;
  return typeof level === 'number' ? level : undefined;
}

/**
 * The exit-code pattern from the live config, found by what its message promises rather
 * than by position, so an unrelated `no-restricted-syntax` pattern can be added without
 * reddening this file — and so a broken walk cannot degrade into linting nothing.
 */
async function livePattern(): Promise<ExitCodePattern> {
  const definition = (await rulesFor(SHIPPED_FILE))[GUARD];
  assert.notStrictEqual(definition, undefined, `${GUARD} is not armed for a shipped handler`);
  assert.ok(Array.isArray(definition), `${GUARD} must be configured as [severity, ...patterns]`);
  assert.strictEqual(severityOf(definition), 2, `${GUARD} must be armed as an error`);
  const candidates = definition.slice(1).filter(
    (entry): entry is ExitCodePattern =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as ExitCodePattern).selector === 'string' &&
      typeof (entry as ExitCodePattern).message === 'string'
  );
  const guarded = candidates.filter((entry) => /ExitCode/.test(entry.message));
  assert.strictEqual(guarded.length, 1, 'exactly one armed pattern targets the exit-code contract');
  const pattern = guarded[0];
  assert.ok(pattern !== undefined, 'the exit-code guard pattern is present in the live config');
  return pattern;
}

const linter = new Linter();

/**
 * Runs the live pattern over one snippet: no project service, no type info, no temp
 * file. The parser is needed only so the TypeScript wrapper cases parse; the
 * selector itself is purely syntactic.
 */
function report(code: string, pattern: ExitCodePattern): Array<{ ruleId: string | null; message: string; severity: number }> {
  return linter
    .verify(code, {
      languageOptions: { parser: tsParser, sourceType: 'module', ecmaVersion: 2022 },
      rules: { [GUARD]: ['error', pattern] }
    })
    .map(({ ruleId, message, severity }) => ({ ruleId, message, severity }));
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function show(file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

describe('ESLint exit-code guard enforcement (#207)', () => {
  test('the live config arms one exit-code guard over shipped code, and its message names the fix', async () => {
    assert.notStrictEqual(
      (await rulesFor(BIN_FILE))[GUARD],
      undefined,
      'the guard reaches bin/ as well, or the file scan below polices more than the lint does'
    );
    const pattern = await livePattern();
    // A message that only says "not allowed" sends the developer nowhere; the whole
    // point of the guard is which two forms are correct.
    assert.match(pattern.message, /ExitCode/);
    assert.match(pattern.message, /exitCodeFor\(\)/);
  });

  test('the armed selector reports a numeric exit-code assignment', async () => {
    const pattern = await livePattern();
    assert.deepStrictEqual(
      report('process.exitCode = 2;', pattern),
      [{ ruleId: GUARD, message: pattern.message, severity: 2 }],
      'the guard must report exactly itself, once, as an error'
    );
  });

  test('the armed selector catches TypeScript wrappers, negative literals, and bracket writes', async () => {
    const pattern = await livePattern();
    // A cast is how a numeric literal sneaks past a selector that only looks for a
    // direct Literal child; each form below previously reached `process.exitCode`
    // untouched.
    const bypasses = [
      'process.exitCode = 2 as number;',
      'process.exitCode = 2!;',
      'process.exitCode = 2 satisfies number;',
      'process.exitCode = <number>2;',
      'process.exitCode = -1;',
      "process['exitCode'] = 2;",
      "process['exitCode'] = 2 as number;",
      "process['exitCode'] = 2!;"
    ];
    for (const code of bypasses) {
      assert.deepStrictEqual(
        report(code, pattern),
        [{ ruleId: GUARD, message: pattern.message, severity: 2 }],
        `${code} is a numeric exit-code write and must be caught`
      );
    }
  });

  test('the armed selector stays silent on the two forms the exit-code contract prescribes', async () => {
    const pattern = await livePattern();
    for (const code of [
      'process.exitCode = ExitCode.Usage;',
      'process.exitCode = exitCodeFor(error);',
      "process['exitCode'] = ExitCode.Usage;"
    ]) {
      assert.deepStrictEqual(report(code, pattern), [], `${code} is the correct form; a guard that reports it will be disabled, not obeyed`);
    }
    // The value, not a value somewhere below it: `2` reaches a helper as an argument, so
    // the assignment is not a hard-coded exit code. A descendant selector would report it.
    assert.deepStrictEqual(report('process.exitCode = toExitCode(2);', pattern), [], 'a call whose argument is numeric is not a literal assignment');
  });

  test('the armed selector is anchored to process, not to any object carrying an exitCode', async () => {
    // `bin/palee.ts` reads `cmdErr.exitCode === 0` from a Commander error. That field is
    // not the CLI's exit contract, so a guard widened past `process` would police it too.
    const pattern = await livePattern();
    assert.deepStrictEqual(report('cmdErr.exitCode = 2;', pattern), [], 'a foreign exitCode field is out of scope');
    // And `process` alone is not the anchor: a numeric write to any other process field is
    // not the exit contract either. Dropping the property test would police `process.*`.
    assert.deepStrictEqual(report('process.foo = 2;', pattern), [], 'a non-exitCode process field is out of scope');
  });

  test('the live guard reports nothing across every shipped file', async () => {
    // Run the same selector the linter runs over the real tree, instead of re-deriving it
    // with line regexes: a regex census and a selector are two lists that drift.
    const pattern = await livePattern();
    const offenders: string[] = [];
    const scanned = { src: 0, bin: 0 };

    for (const dir of ['src', 'bin'] as const) {
      for (const file of sourceFiles(path.join(root, dir)).sort()) {
        scanned[dir]++;
        const reports = linter.verify(
          fs.readFileSync(file, 'utf8'),
          {
            languageOptions: { parser: tsParser, sourceType: 'module', ecmaVersion: 2022 },
            rules: { [GUARD]: ['error', pattern] }
          }
        );
        // A file that fails to parse reports nothing, which would look like compliance.
        const broken = reports.filter((entry) => entry.fatal === true);
        assert.deepStrictEqual(
          broken.map((entry) => `${show(file)}: ${entry.message}`),
          [],
          'every scanned file must parse, or a silent pass means the tree was never read'
        );
        for (const entry of reports) {
          if (entry.ruleId === GUARD) offenders.push(`${show(file)}:${entry.line} ${entry.message}`);
        }
      }
    }

    // An empty `offenders` list over an empty scan proves nothing about either directory.
    assert.ok(scanned.src > 0, `the scan found no TypeScript under src/ (scanned ${scanned.src})`);
    assert.ok(scanned.bin > 0, `the scan found no TypeScript under bin/ (scanned ${scanned.bin})`);
    assert.deepStrictEqual(
      offenders,
      [],
      'a numeric exit code is the drift the contract forbids: it survives a renumbered ExitCode silently'
    );
  });

  test('the type-aware guard is armed for shipped code and not inherited by test/', async () => {
    // This asserts config structure, not behaviour: it pins the scoping that keeps
    // `test/` out of the rule. Arming `no-floating-promises` repo-wide measured 2314
    // findings in fire-and-forget harnesses during #207, so the shipped-only scope is
    // deliberate and must not be "fixed" by widening it.
    assert.strictEqual(
      severityOf((await rulesFor(SHIPPED_FILE))[TYPE_AWARE]), 2,
      'shipped code resolves the type-aware rule as an error'
    );
    assert.strictEqual(
      severityOf((await rulesFor(HARNESS_FILE))[TYPE_AWARE]), undefined,
      'the same rule must not reach a test file'
    );
  });
});
