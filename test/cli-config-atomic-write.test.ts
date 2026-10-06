import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveConfig } from '../src/cli/config';

/**
 * The config writer is a smaller copy of `atomicWrite`, so it inherits its
 * requirements: a temp name no other process can guess.
 */
describe('saveConfig temp file naming', () => {
  let configDir: string;

  before(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-config-tmp-'));
    process.env.PALEE_CONFIG_DIR = configDir;
  });

  after(() => {
    delete process.env.PALEE_CONFIG_DIR;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('two writes in the same millisecond do not share a temp file', () => {
    // The name was `${pid}.${Date.now()}`. Two processes forked from one parent
    // inside the same millisecond — a test runner, a shell loop, an editor
    // plugin — share a pid family and can collide on the clock, and both then
    // `open(w)` the *same* path: the second truncates the first one's payload
    // mid-write, and whichever rename lands last puts a half-written config in
    // place. `atomicWrite` pays for entropy for exactly this reason.
    const names: string[] = [];
    const originalOpen = fs.openSync;
    (fs as unknown as { openSync: unknown }).openSync = ((
      target: fs.PathLike | number,
      options?: unknown
    ) => {
      if (typeof target === 'string' && target.includes('.tmp.')) {
        names.push(target);
      }
      return Reflect.apply(originalOpen, fs, [target, options]);
    }) as typeof fs.openSync;

    try {
      saveConfig({ vaultPath: configDir });
      saveConfig({ vaultPath: configDir });
    } finally {
      (fs as unknown as { openSync: unknown }).openSync = originalOpen;
    }

    assert.strictEqual(names.length, 2, 'both writes must have opened a temp file');
    assert.notStrictEqual(names[0], names[1], 'and they must not race on one name');
    assert.match(
      names[1],
      new RegExp(`\\.tmp\\.${process.pid}\\.[0-9a-f]{8}$`),
      'the suffix is random bytes, not a timestamp'
    );
    assert.ok(fs.existsSync(path.join(configDir, 'config.json')), 'the config itself still lands');
  });
});
