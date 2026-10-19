import { test, describe } from 'node:test';
import assert from 'node:assert';
import { PALEE_ARGV, PALEE_DIST_ENTRY, assertDistBuilt } from './palee-cli';

describe('palee-cli launch guard', () => {
  // Without a build, every CLI-spawning suite used to fail with a child ENOENT
  // that read as an unrelated regression in the code under test. The guard turns
  // that into one named prerequisite at import time.

  test('a missing build throws a named prerequisite error, not a silent launch', () => {
    assert.throws(
      () => assertDistBuilt('/repo/dist/bin/palee.js', () => false),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(
          message.includes('/repo/dist/bin/palee.js'),
          `the error must name the path it looked for, got: ${message}`
        );
        assert.ok(
          message.includes('npm run build'),
          `the error must state the remedy, got: ${message}`
        );
        return true;
      },
      'an absent dist entry must fail fast at import, not spawn a child that cannot exist'
    );
  });

  test('a present build is left alone', () => {
    assert.doesNotThrow(() => assertDistBuilt(PALEE_DIST_ENTRY, () => true));
  });

  test('the guard checks the exact entry PALEE_ARGV spawns', (t) => {
    // If the two paths ever drift, the guard passes while the spawn still fails,
    // which is the failure mode this exists to prevent.
    if (process.env.NODE_V8_COVERAGE) {
      t.skip('coverage runs launch the tsx sources, so there is no dist entry to pin');
      return;
    }
    assert.strictEqual(
      PALEE_ARGV[0],
      PALEE_DIST_ENTRY,
      'PALEE_ARGV must spawn the same path the guard verifies'
    );
  });
});
