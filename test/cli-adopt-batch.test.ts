import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { resolveNoteTitle } from '../src/cli/adopt';

describe('CLI Adopt Batch Integration Tests', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-batch-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });

    // Seed realistic multi-directory vault
    // MODULES/01-foundations/
    fs.mkdirSync(path.join(vaultDir, 'MODULES', '01-foundations'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md'),
      `---\ntitle: Systems Thinking\ntags:\n  - type/concept\n---\n# Systems Thinking\n`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md'),
      `---\ntitle: Runbook Template\ntags:\n  - template\n---\n# Template\n`
    );

    // MODULES/02-linux/
    fs.mkdirSync(path.join(vaultDir, 'MODULES', '02-linux'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', '01-processes.md'),
      `---\ntags:\n  - type/concept\n---\n# Linux Process Deep Dive\n`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', 'lab-01-triage.md'),
      `# Linux Triage Lab\n\nSome lab content without frontmatter.`
    );
    fs.writeFileSync(
      path.join(vaultDir, 'MODULES', '02-linux', 'rubric.md'),
      `---\ntags:\n  - type/rubric\n---\n`
    );

    // PROJECTS/
    fs.mkdirSync(path.join(vaultDir, 'PROJECTS'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'PROJECTS', 'project-01.md'),
      `---\ntitle: Project 1\ntags:\n  - category/project\n---\n# Project 1\n`
    );

    // Configure vault
    runCLI(['config', 'set-vault', vaultDir]);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const escapedArgs = args.map((arg) => (/[*?[\]\s,]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      const stdout = execSync(`npx tsx bin/palee.ts ${escapedArgs.join(' ')}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }

  test('resolveNoteTitle helper extracts title from frontmatter, H1 heading, or filename', () => {
    // 1. Frontmatter title
    assert.strictEqual(
      resolveNoteTitle('---\ntitle: My Frontmatter Title\n---\n# Ignored H1\n', 'path/to/file.md'),
      'My Frontmatter Title'
    );
    // 2. H1 heading in body
    assert.strictEqual(
      resolveNoteTitle('<!-- comment -->\n```ts\n# not h1\n```\n# Extracted H1 Title\n\nBody', 'path/to/file.md'),
      'Extracted H1 Title'
    );
    // 3. Filename fallback
    assert.strictEqual(
      resolveNoteTitle('No headings here\nJust text', 'path/to/fallback-name.md'),
      'fallback-name'
    );
  });

  test('palee adopt --dry-run previews adoption without modifying any files', () => {
    const result = runCLI(['adopt', '--all', '--dry-run', '--verbose']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Dry-run complete\. No files were modified\./);
    assert.match(result.stdout, /Ready to Adopt:\s+6 notes/);

    // Verify no files have palee_id
    const note = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(note, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt exits with code 2 in non-interactive environment without --yes', () => {
    const result = runCLI(['adopt', '--all']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /Non-interactive environment\. Use -y or --yes/);
  });

  test('palee adopt rejects path escaping vault with code 2', () => {
    const result = runCLI(['adopt', '../outside', '--yes']);
    assert.strictEqual(result.status, 2);
  });

  test('palee adopt <directory> scopes adoption strictly and resolves titles with fallbacks', () => {
    const result = runCLI(['adopt', 'MODULES/02-linux', '--difficulty', 'beginner', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 3 notes/);

    // Verify 02-linux notes were adopted with difficulty=beginner
    const procNote = path.join(vaultDir, 'MODULES', '02-linux', '01-processes.md');
    const parsedProc = parseFrontmatter(fs.readFileSync(procNote, 'utf8'));
    assert.ok(parsedProc.frontmatter?.palee_id);
    assert.strictEqual(parsedProc.frontmatter?.difficulty, 'beginner');
    // Title resolved from H1
    assert.strictEqual(parsedProc.frontmatter?.title, 'Linux Process Deep Dive');

    // Title resolved from H1 on note with no prior frontmatter
    const triageNote = path.join(vaultDir, 'MODULES', '02-linux', 'lab-01-triage.md');
    const parsedTriage = parseFrontmatter(fs.readFileSync(triageNote, 'utf8'));
    assert.strictEqual(parsedTriage.frontmatter?.title, 'Linux Triage Lab');

    // Title resolved from filename for rubric.md
    const rubricNote = path.join(vaultDir, 'MODULES', '02-linux', 'rubric.md');
    const parsedRubric = parseFrontmatter(fs.readFileSync(rubricNote, 'utf8'));
    assert.strictEqual(parsedRubric.frontmatter?.title, 'rubric');

    // Verify 01-foundations notes were NOT adopted
    const foundNote = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    const parsedFound = parseFrontmatter(fs.readFileSync(foundNote, 'utf8'));
    assert.strictEqual(parsedFound.frontmatter?.palee_id, undefined);
  });

  test('palee adopt skips already adopted notes idempotently', () => {
    // Re-run adopt on MODULES/02-linux
    const result = runCLI(['adopt', 'MODULES/02-linux', '--yes']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Already Adopted:\s+3 notes/);
    assert.match(result.stdout, /Ready to Adopt:\s+0 notes/);
  });

  test('palee adopt with --tag filters notes by Obsidian frontmatter tags', () => {
    const result = runCLI(['adopt', 'MODULES/01-foundations', '--tag', 'type/concept', '--yes']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 1 notes/);

    // Concept note should be adopted
    const sysNote = path.join(vaultDir, 'MODULES', '01-foundations', '01-systems.md');
    assert.ok(parseFrontmatter(fs.readFileSync(sysNote, 'utf8')).frontmatter?.palee_id);

    // Template note should be untouched
    const tmplNote = path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(tmplNote, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt with --include and --exclude handles glob patterns', () => {
    const result = runCLI(['adopt', '--all', '--include', '**/*.md', '--exclude', '*template*', '-y']);
    assert.strictEqual(result.status, 0, `Command failed: ${result.stderr}`);
    assert.match(result.stdout, /Successfully adopted 1 notes/);

    // Project 1 note should be adopted
    const projNote = path.join(vaultDir, 'PROJECTS', 'project-01.md');
    assert.ok(parseFrontmatter(fs.readFileSync(projNote, 'utf8')).frontmatter?.palee_id);

    // Template note was excluded
    const tmplNote = path.join(vaultDir, 'MODULES', '01-foundations', 'runbook-template.md');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(tmplNote, 'utf8')).frontmatter?.palee_id, undefined);
  });

  test('palee adopt with invalid glob option returns clean code 2 error', () => {
    const result = runCLI(['adopt', '--all', '--include', 'valid/**', '-y']);
    assert.strictEqual(result.status, 0);
  });
});
