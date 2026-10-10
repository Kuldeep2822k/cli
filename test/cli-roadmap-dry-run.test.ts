import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * Issue #309 — `roadmap --from` rewrites `depends_on` across the vault and
 * had no `--dry-run`.
 *
 * `--dry-run` must run the same pre-write validation, print the full per-note
 * plan (ids, target paths, resolved `depends_on`, which notes would be
 * created), and write zero bytes. A rejected plan still exits `3`. Output
 * stays machine-safe for non-TTY consumers: no ANSI, `•` bullets, plain
 * lines.
 *
 * At base this whole file is red on the first assertion of each test:
 * commander rejects the flag with `error: unknown option '--dry-run'` and
 * exit `2` — the exact repro from the issue.
 */
describe('roadmap --dry-run prints the write plan and changes no bytes (#309)', () => {
  const created: string[] = [];

  after(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the real CLI in a child process against a throwaway vault. */
  function runCLI(configDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: configDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /**
   * Vault: `head.md` (T-head) already depends on `T-out` (outside the
   * roadmap), `second.md` (T-second) carries nothing, `new.md` does not exist
   * yet. The two-topic roadmap plus `--auto-chain` chains second onto head,
   * so the plan has one of every interesting line: an update that preserves,
   * an update with a synthesized edge, and a create.
   *
   * @param name - Prefix for this case's temp directory
   * @param withNewTopic - Also declare the not-yet-existing `new.md` topic
   */
  function makeVault(name: string, withNewTopic = false): { base: string; vault: string; yaml: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `palee-dry-run-${name}-`)));
    created.push(base);
    const vault = path.join(base, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ vaultPath: vault }, null, 2), 'utf8');

    fs.writeFileSync(
      path.join(vault, 'outside.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-out', 'title: Outside', 'depends_on: []', 'topic_mastery: 0', '---', '', '# Outside', ''].join('\n')
    );
    fs.writeFileSync(
      path.join(vault, 'head.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-head', 'title: Head', 'depends_on:', '  - T-out', 'topic_mastery: 0.4', '---', '', '# Head', ''].join('\n')
    );
    fs.writeFileSync(
      path.join(vault, 'second.md'),
      ['---', 'palee_schema: 1', 'palee_id: T-second', 'title: Second', 'depends_on: []', 'topic_mastery: 0', '---', '', '# Second', ''].join('\n')
    );

    const yaml = path.join(base, 'roadmap.yaml');
    fs.writeFileSync(
      yaml,
      [
        'topics:',
        '  - id: T-head',
        '    title: Head',
        '    path: head.md',
        '    order: 1',
        '  - id: T-second',
        '    title: Second',
        '    path: second.md',
        '    order: 2',
        ...(withNewTopic
          ? ['  - id: T-new', '    title: New', '    path: new.md', '    order: 3']
          : []),
        '',
      ].join('\n')
    );
    return { base, vault, yaml };
  }

  /** Snapshots `relative path -> exact bytes` for every file under the vault. */
  function snapshotVault(vault: string): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else {
          snapshot[path.relative(vault, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
        }
      }
    };
    walk(vault);
    return snapshot;
  }

  /** The `depends_on` list a note currently carries on disk. */
  function dependsOn(vault: string, rel: string): unknown {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vault, rel), 'utf8'));
    assert.ok(frontmatter, `${rel} has no frontmatter`);
    return frontmatter.depends_on;
  }

  test('--dry-run prints the per-note plan and writes zero bytes', () => {
    const { base, vault, yaml } = makeVault('plan');
    const before = snapshotVault(vault);

    const result = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--dry-run', '--yes']);
    const out = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `expected exit 0: ${out}`);
    // Full plan: ids, target paths, resolved depends_on, create-vs-update.
    assert.match(out, /Dry-run plan \(no files were written\):/);
    assert.match(out, /• T-head → head\.md \(update existing note\)/);
    assert.match(out, /• T-second → second\.md \(update existing note\)/);
    // The head's resolved list names the preserved on-disk edge (#322 tie-in:
    // the plan shows what the import would actually write).
    assert.match(out, /depends_on: T-out/);
    // The synthesized chain edge is labelled, not just listed.
    assert.match(out, /depends_on: T-head \(synthesized by --auto-chain\)/);
    assert.match(out, /Dry-run complete\. 0 note\(s\) would be created, 2 updated\. No files were modified\./);
    // Machine-safe: no ANSI escape bytes anywhere in the output.
    assert.ok(!out.includes('\u001b['), 'non-TTY output must carry no ANSI escapes');

    // Zero bytes: same file set, byte-identical content.
    assert.deepStrictEqual(snapshotVault(vault), before);
    assert.strictEqual(fs.existsSync(path.join(vault, '.palee')), false, 'dry run must not mint vault metadata either');
  });

  test('the dry-run plan needs no --yes and never reaches the prompt', () => {
    const { base, vault, yaml } = makeVault('noprompt');
    const before = snapshotVault(vault);

    // Non-interactive stdin, no `--yes`: the early return happens before the
    // confirm gate, so a run that writes nothing must not demand confirmation.
    const result = runCLI(base, ['roadmap', '--from', yaml, '--dry-run']);
    const out = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `expected exit 0: ${out}`);
    assert.doesNotMatch(out, /Proceed\?/);
    assert.doesNotMatch(out, /Non-interactive environment detected/);
    assert.match(out, /Dry-run complete\./);
    assert.deepStrictEqual(snapshotVault(vault), before);
  });

  test('a plan naming notes to create reports them as creates', () => {
    const { base, vault, yaml } = makeVault('create', true);
    const before = snapshotVault(vault);

    const result = runCLI(base, ['roadmap', '--from', yaml, '--dry-run', '--yes']);
    const out = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, out);
    assert.match(out, /• T-new → new\.md \(create new note\)/);
    assert.match(out, /Dry-run complete\. 1 note\(s\) would be created, 2 updated\./);
    assert.strictEqual(fs.existsSync(path.join(vault, 'new.md')), false, '--dry-run must not create the note');
    assert.deepStrictEqual(snapshotVault(vault), before);
  });

  test('a rejected plan exits 3 under --dry-run exactly as it would without it', () => {
    const { base, vault } = makeVault('invalid');
    const before = snapshotVault(vault);
    const yaml = path.join(base, 'bad.yaml');
    fs.writeFileSync(
      yaml,
      ['topics:', '  - id: T-head', '    title: Head', '    path: head.md', '    depends_on: [T-ghost]', ''].join('\n')
    );

    const dry = runCLI(base, ['roadmap', '--from', yaml, '--dry-run', '--yes']);
    assert.strictEqual(dry.status, 3, `a missing dependency is a validation failure under --dry-run too: ${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout + dry.stderr, /depends on missing topic: T-ghost/);
    assert.strictEqual(dry.stdout.includes('Dry-run plan'), false, 'a rejected plan must not print a plan');
    assert.deepStrictEqual(snapshotVault(vault), before);

    const wet = runCLI(base, ['roadmap', '--from', yaml, '--yes']);
    assert.strictEqual(wet.status, 3, wet.stdout + wet.stderr);
    assert.deepStrictEqual(snapshotVault(vault), before);
  });

  test('the printed plan matches what the real import then writes', () => {
    const { base, vault, yaml } = makeVault('parity');

    const dry = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--dry-run', '--yes']);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);

    const wet = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--yes']);
    assert.strictEqual(wet.status, 0, wet.stdout + wet.stderr);

    // The plan promised head keeps T-out and second gains T-head; the import
    // lands exactly that, so the dry-run preview is the write plan.
    assert.deepStrictEqual(dependsOn(vault, 'head.md'), ['T-out']);
    assert.deepStrictEqual(dependsOn(vault, 'second.md'), ['T-head']);
  });
});
