import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';

describe('CLI Commands', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-cli-test-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number | null, stdout: string, stderr: string } {
    try {
      const stdout = execSync(`npx tsx bin/palee.ts ${args.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  test('config set-vault points to directory', () => {
    const result = runCLI(['config', 'set-vault', vaultDir]);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Vault path set to/);
  });

  test('config set-vault rejects file', () => {
    const file = path.join(tempDir, 'file.txt');
    fs.writeFileSync(file, 'hello');
    const result = runCLI(['config', 'set-vault', file]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /vault path is not a directory/);
  });

  test('adopt command sets up topic', () => {
    const notePath = path.join(vaultDir, 'note.md');
    fs.writeFileSync(notePath, '# Test Note\n');
    
    const result = runCLI(['adopt', 'note.md', '--difficulty', 'advanced']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Adopted as topic/);

    const content = fs.readFileSync(notePath, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    assert.ok(frontmatter);
    assert.strictEqual(frontmatter.difficulty, 'advanced');
    assert.strictEqual(frontmatter.topic_mastery, 0);
  });

  test('adopt command rejects path escaping vault', () => {
    const outsideFile = path.join(tempDir, 'outside.md');
    fs.writeFileSync(outsideFile, '# Outside');
    const result = runCLI(['adopt', '../outside.md']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /escapes vault/);
  });

  test('roadmap command preserves existing state and prevents path traversal', () => {
    // 1. Create a roadmap yaml
    const roadmapYaml = path.join(tempDir, 'roadmap.yaml');
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First
    path: first.md
  - id: R-2
    title: Traversal
    path: ../escaped.md
`);

    // 2. Mock user input for prompt (Y)
    let result;
    try {
      const stdout = execSync(`npx tsx bin/palee.ts roadmap --from "${roadmapYaml}" --yes`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      result = { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      result = { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }

    // Since R-2 escapes the vault, the command should fail but still process R-1
    assert.strictEqual(result.status, 1, `Command should exit with 1 due to failures.\nStdout: ${result.stdout}\nStderr: ${result.stderr}`);
    assert.match(result.stderr, /Roadmap path escapes vault/);
    assert.match(result.stderr, /Failed to import 1 topics/);

    // R-1 should exist
    const firstPath = path.join(vaultDir, 'first.md');
    assert.ok(fs.existsSync(firstPath));

    // 3. Modify R-1 state manually to simulate a review
    let content = fs.readFileSync(firstPath, 'utf8');
    let parsed = parseFrontmatter(content);
    parsed.frontmatter!.topic_mastery = 0.8;
    parsed.frontmatter!.repetition = 5;
    
    // rewrite
    const { updateFrontmatter } = require('../src/storage/frontmatter');
    fs.writeFileSync(firstPath, updateFrontmatter(content, parsed.frontmatter));

    // 4. Run roadmap import again, but with a valid roadmap
    fs.writeFileSync(roadmapYaml, `
topics:
  - id: R-1
    title: First Modified
    path: first.md
`);
    
    try {
      execSync(`npx tsx bin/palee.ts roadmap --from "${roadmapYaml}" --yes`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        stdio: 'pipe',
      });
    } catch (e) {}

    // Check state preservation
    content = fs.readFileSync(firstPath, 'utf8');
    parsed = parseFrontmatter(content);
    assert.strictEqual(parsed.frontmatter!.title, 'First Modified'); // Should be updated
    assert.strictEqual(parsed.frontmatter!.topic_mastery, 0.8); // Should be preserved
    assert.strictEqual(parsed.frontmatter!.repetition, 5); // Should be preserved
  });

  test('review command updates mastery and SM2 fields', () => {
    // Review R-1
    const result = runCLI(['review', 'R-1', '4']);
    assert.strictEqual(result.status, 0, `Command should exit with 0. Stderr: ${result.stderr}`);

    const firstPath = path.join(vaultDir, 'first.md');
    const content = fs.readFileSync(firstPath, 'utf8');
    const parsed = parseFrontmatter(content);

    assert.ok(parsed.frontmatter!.last_reviewed_at);
    assert.ok(parsed.frontmatter!.due_at);
    assert.strictEqual(parsed.frontmatter!.conceptual, 0.8);
    assert.strictEqual(parsed.frontmatter!.practical, 0.8);
    assert.strictEqual(parsed.frontmatter!.debug, 0.8);
    assert.strictEqual(parsed.frontmatter!.feynman, 0.8);
    // (c+p+d+f*2)/5 = (0.8+0.8+0.8+1.6)/5 = 4/5 = 0.8
    assert.strictEqual(parsed.frontmatter!.topic_mastery, 0.8);
  });
});
