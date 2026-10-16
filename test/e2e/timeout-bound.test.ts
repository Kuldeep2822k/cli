import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPalee } from './test-env';

/**
 * #451: `runPalee` had no timeout, so a CLI child that never finished blocked
 * its test worker forever. The runner now passes a default `timeout` to
 * `spawnSync` and surfaces an `ETIMEDOUT` as an error naming the command and
 * showing how far the child got. This pins that branch, plus the fact that the
 * default leaves a fast invocation alone.
 */
describe('runPalee bounds a hung CLI child (#451)', () => {
  let tempDir: string;
  let configDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-timeout-'));
    configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a 1 ms budget turns a real invocation into a named timeout error', () => {
    assert.throws(
      () => runPalee(['--version'], configDir, { timeout: 1 }),
      (err: Error) => {
        assert.match(err.message, /did not finish within 1ms during '--version'/);
        return true;
      }
    );
  });

  test('the default budget does not interfere with a fast invocation', () => {
    const result = runPalee(['--version'], configDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
  });
});
