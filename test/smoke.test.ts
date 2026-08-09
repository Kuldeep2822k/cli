import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as palee from '../src/index';

test('palee module loads and exports version', () => {
  assert.ok(palee);
  assert.ok(palee.version);
  assert.match(palee.version, /^\d+\.\d+\.\d+$/);
});

test('version matches package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.strictEqual(palee.version, packageJson.version);
});
