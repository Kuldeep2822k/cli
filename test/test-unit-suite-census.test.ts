/**
 * #565 P3-17 — `test:unit` must include the application and validation suites.
 *
 * `package.json`'s `test:unit` globbed only `test/storage-*.test.ts`,
 * `test/engine-*.test.ts`, `test/types-*.test.ts` and `test/smoke.test.ts`, so
 * the 6 `test/application-*.test.ts` and 12 `test/validation-*.test.ts` suites
 * — the pure use-case cores (`src/application/`) and the rule catalog behind
 * `palee validate` (`src/validation/`) — never ran under the script despite
 * being unit suites by the same definition as the layers it did cover. The two
 * family globs were added; this census keeps them from silently drifting away:
 *
 * - every `application-*.test.ts` / `validation-*.test.ts` file on disk must be
 *   matched by at least one glob argument of `test:unit` (discovered from disk,
 *   so a future suite in either family is covered the day it is added);
 * - every glob argument must match at least one existing file, so a typo'd or
 *   renamed-away family glob is a loud failure, not a quiet no-op;
 * - the script stays on the `node --import tsx --test` runner the suite uses.
 *
 * The assertion is against the expanded globs, not the literal token list: any
 * glob shape that still covers the suites satisfies the invariant, and dropping
 * either family glob (the revert) fails on the suites it uncovered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * The suites the item names, discovered from disk rather than hard-coded so a
 * new application or validation suite is in scope the day it is committed.
 */
function suiteFilesInFamily(): string[] {
  return fs
    .readdirSync(path.join(root, 'test'))
    .filter((file) => /^(application|validation)-.*\.test\.ts$/.test(file))
    .sort();
}

/**
 * The quoted arguments `test:unit` hands to `--test`. The command's prefix is
 * pinned separately, so these are the glob arguments the runner expands.
 */
function testUnitGlobs(): string[] {
  const script = pkg.scripts['test:unit'];
  assert.ok(script, 'package.json must define a test:unit script (#565 P3-17)');
  assert.match(
    script,
    /^node --import tsx --test /,
    'test:unit must stay on the node:test runner the suite uses',
  );
  return [...script.matchAll(/"([^"]+)"/g)].map((match) => {
    assert.ok(match[1] !== undefined, 'a quoted test:unit argument was not captured');
    return match[1];
  });
}

/**
 * Translates one `test:unit` glob to a matcher over `test/`-relative paths.
 * The shape assertion keeps this honest: an unsupported wildcard arriving in a
 * future edit fails loudly here instead of silently matching everything (or
 * nothing) under a permissive regex.
 */
function globToRegExp(token: string): RegExp {
  assert.match(
    token,
    /^test\/[\w.-]*\*?[\w.-]*\.test\.ts$/,
    `unsupported glob syntax in test:unit ("${token}") — extend the matcher in this test rather than weakening it`,
  );
  const source = token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${source}$`);
}

describe('test:unit suite census (#565 P3-17)', () => {
  const globs = testUnitGlobs();

  it('covers every application and validation suite on disk', () => {
    const patterns = globs.map(globToRegExp);
    const uncovered = suiteFilesInFamily().filter(
      (file) => !patterns.some((pattern) => pattern.test(`test/${file}`)),
    );
    assert.deepStrictEqual(
      uncovered,
      [],
      'test:unit dropped application/validation suites (#565 P3-17) — ' +
        'restore the test/application-*.test.ts and test/validation-*.test.ts globs',
    );
  });

  it('has no glob argument that matches no file at all', () => {
    const files = fs
      .readdirSync(path.join(root, 'test'))
      .filter((file) => file.endsWith('.test.ts'));
    const dead = globs.filter((glob) => {
      const pattern = globToRegExp(glob);
      return !files.some((file) => pattern.test(`test/${file}`));
    });
    assert.deepStrictEqual(
      dead,
      [],
      'test:unit carries a glob matching no test file — fix the pattern instead of letting it expand to nothing',
    );
  });

  it('discovers the suite families the item names', () => {
    // The discovery above is only meaningful while both families exist on disk.
    // This control fails loudly if the prefixes change, so the census cannot
    // quietly start asserting over an empty set.
    const files = suiteFilesInFamily();
    assert.ok(
      files.some((file) => file.startsWith('application-')),
      'no test/application-*.test.ts files found — the census is asserting over nothing',
    );
    assert.ok(
      files.some((file) => file.startsWith('validation-')),
      'no test/validation-*.test.ts files found — the census is asserting over nothing',
    );
  });
});
