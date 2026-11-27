import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { isAffirmativeEnvFlag } from '../src/cli/env-flag';

/**
 * Two call sites grew the same "affirmative env value" test independently:
 * the Windows config-dir guard (#565 P2-05) and `PALEE_JSON` (#357). They
 * already disagreed about whitespace before either was shared, so the predicate
 * takes that difference as an explicit option rather than silently widening a
 * documented contract.
 */
describe('one predicate for affirmative environment flags', () => {
  test('accepts exactly 1 and true, case-insensitively', () => {
    for (const value of ['1', 'true', 'TRUE', 'True']) {
      assert.strictEqual(isAffirmativeEnvFlag(value), true, `${JSON.stringify(value)} must be affirmative`);
    }
    for (const value of [undefined, '', '0', 'false', 'no', 'on', 'yes', '01']) {
      assert.strictEqual(isAffirmativeEnvFlag(value), false, `${JSON.stringify(value)} must not be affirmative`);
    }
  });

  test('trim is opt-in, and only the config guard opts in', () => {
    assert.strictEqual(isAffirmativeEnvFlag(' true '), false, 'PALEE_JSON keeps exact spellings');
    assert.strictEqual(isAffirmativeEnvFlag(' true ', { trim: true }), true);
    assert.strictEqual(isAffirmativeEnvFlag(' 1 ', { trim: true }), true);
    assert.strictEqual(isAffirmativeEnvFlag('   ', { trim: true }), false, 'whitespace is not a yes');
  });

  test('both call sites hold no copy of the spelling', () => {
    const root = path.resolve(__dirname, '../src/cli');
    for (const file of ['config.ts', 'onboarding.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(source, /from '\.\/env-flag'/, `${file} must import the shared predicate`);
      assert.doesNotMatch(
        source,
        /===\s*'true'/,
        `${file} must not carry its own affirmative spelling`
      );
    }
  });
});
