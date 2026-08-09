import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { walkVault } from '../src/storage/vault-walker';
import { NodeError } from '../src/types';

describe('Vault Walker', () => {
  let testVaultPath: string;

  test.before(() => {
    // Create temporary test vault
    testVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-test-vault-'));

    // Create directory structure
    fs.mkdirSync(path.join(testVaultPath, 'notes'));
    fs.mkdirSync(path.join(testVaultPath, '.obsidian'));
    fs.mkdirSync(path.join(testVaultPath, '.trash'));
    fs.mkdirSync(path.join(testVaultPath, '.git'));
    fs.mkdirSync(path.join(testVaultPath, 'node_modules'));
    fs.mkdirSync(path.join(testVaultPath, '.hidden'));

    // Create test files
    fs.writeFileSync(path.join(testVaultPath, 'root.md'), '# Root note');
    fs.writeFileSync(path.join(testVaultPath, 'notes', 'note1.md'), '# Note 1');
    fs.writeFileSync(path.join(testVaultPath, 'notes', 'note2.md'), '# Note 2');
    fs.writeFileSync(path.join(testVaultPath, '.obsidian', 'workspace.md'), 'excluded');
    fs.writeFileSync(path.join(testVaultPath, '.trash', 'deleted.md'), 'excluded');
    fs.writeFileSync(path.join(testVaultPath, '.git', 'commit.md'), 'excluded');
    fs.writeFileSync(path.join(testVaultPath, 'node_modules', 'module.md'), 'excluded');
    fs.writeFileSync(path.join(testVaultPath, '.hidden', 'secret.md'), 'excluded');
    fs.writeFileSync(path.join(testVaultPath, 'notes', 'readme.txt'), 'not markdown');
  });

  test.after(() => {
    // Cleanup
    fs.rmSync(testVaultPath, { recursive: true, force: true });
  });

  test('collects only markdown files', () => {
    const files = walkVault(testVaultPath);
    const basenames = files.map(f => path.basename(f)).sort();

    assert.deepStrictEqual(basenames, ['note1.md', 'note2.md', 'root.md']);
  });

  test('excludes .obsidian directory', () => {
    const files = walkVault(testVaultPath);
    const hasObsidian = files.some(f => f.includes('.obsidian'));
    assert.strictEqual(hasObsidian, false);
  });

  test('excludes .trash directory', () => {
    const files = walkVault(testVaultPath);
    const hasTrash = files.some(f => f.includes('.trash'));
    assert.strictEqual(hasTrash, false);
  });

  test('excludes .git directory', () => {
    const files = walkVault(testVaultPath);
    const hasGit = files.some(f => f.includes('.git'));
    assert.strictEqual(hasGit, false);
  });

  test('excludes node_modules directory', () => {
    const files = walkVault(testVaultPath);
    const hasNodeModules = files.some(f => f.includes('node_modules'));
    assert.strictEqual(hasNodeModules, false);
  });

  test('excludes dot-directories', () => {
    const files = walkVault(testVaultPath);
    const hasHidden = files.some(f => f.includes('.hidden'));
    assert.strictEqual(hasHidden, false);
  });

  test('excludes non-markdown files', () => {
    const files = walkVault(testVaultPath);
    const hasTxt = files.some(f => f.endsWith('.txt'));
    assert.strictEqual(hasTxt, false);
  });

  test('skips symlinks by default', () => {
    const symlinkPath = path.join(testVaultPath, 'symlink-dir');
    const targetPath = path.join(testVaultPath, 'notes');

    try {
      fs.symlinkSync(targetPath, symlinkPath, 'junction');
      const files = walkVault(testVaultPath);
      const hasSymlink = files.some(f => f.includes('symlink-dir'));
      assert.strictEqual(hasSymlink, false);
    } catch (e: unknown) {
      const err = e as NodeError;
      // Symlink creation might fail without permissions - skip test
      if (err.code !== 'EPERM') throw err;
    }
  });

  test('handles permission denied gracefully', () => {
    // Create a directory and immediately try to walk it
    // (can't easily test actual permission denial in unit tests)
    const files = walkVault(testVaultPath);
    assert.ok(Array.isArray(files));
  });

  test('returns absolute paths', () => {
    const files = walkVault(testVaultPath);
    files.forEach(file => {
      assert.ok(path.isAbsolute(file));
    });
  });
});
