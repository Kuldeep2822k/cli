import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';

/**
 * Issue #322 — `roadmap --auto-chain` must not erase the chain head's
 * existing on-disk `depends_on`.
 *
 * At base, `applyRoadmapAutoChain` assigned the rank-0 head an explicit
 * `topic.depends_on = []`, and `resolveTopicUpdates` treats an explicit
 * empty list as "clear" (it is not nullish, so it wins over the
 * preserve-existing branch). A note that the chain merely *heads* — and
 * which already carries hand-authored prerequisites pointing outside the
 * roadmap — had those prerequisites silently dropped. Without `--auto-chain`
 * the same roadmap entry preserves them. The cycle-skip branch already left
 * the field unassigned for exactly this reason; the head must behave the
 * same way.
 *
 * Fixture: `outside.md` (T-out) is no part of the roadmap. `head.md` (T-head)
 * is the roadmap's rank-0 topic and already depends on T-out on disk.
 * `second.md` (T-second) is chained onto T-head by the flag.
 */
describe('roadmap --auto-chain preserves the chain head\'s on-disk dependencies (#322)', () => {
  const created: string[] = [];

  after(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the real CLI in a child process against a throwaway vault. */
  function runCLI(configDir: string, args: string[]): { status: number | null; out: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: configDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  /**
   * Builds a vault whose future chain head already depends on a note outside
   * the roadmap, plus the two-topic ordered roadmap that makes it the head.
   *
   * @param name - Prefix for this case's temp directory
   * @param headDeclaredDeps - Lines spliced into the T-head roadmap entry
   */
  function makeVault(name: string, headEntryExtra: string[] = []): { base: string; vault: string; yaml: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `palee-head-deps-${name}-`)));
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
      ['---', 'palee_schema: 1', 'palee_id: T-head', 'title: Head', 'depends_on:', '  - T-out', 'topic_mastery: 0.4', '---', '', '# Head', '', 'Hand-written body.'].join('\n')
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
        ...headEntryExtra,
        '  - id: T-second',
        '    title: Second',
        '    path: second.md',
        '    order: 2',
        '',
      ].join('\n')
    );
    return { base, vault, yaml };
  }

  /** The `depends_on` list a note currently carries on disk. */
  function dependsOn(vault: string, rel: string): unknown {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vault, rel), 'utf8'));
    assert.ok(frontmatter, `${rel} has no frontmatter`);
    return frontmatter.depends_on;
  }

  test('--auto-chain leaves the head note\'s existing dependency in place', () => {
    const { base, vault, yaml } = makeVault('chain');
    const result = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--yes']);

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.out}`);
    assert.match(result.out, /Auto-chain: 1 chain edge\(s\) synthesized across 2 roadmap topics\./);
    // The head keeps its hand-authored edge to the out-of-roadmap note —
    // at base this was erased to `[]` (the #322 defect).
    assert.deepStrictEqual(dependsOn(vault, 'head.md'), ['T-out']);
    // The chain itself still forms: second depends on the head.
    assert.deepStrictEqual(dependsOn(vault, 'second.md'), ['T-head']);
  });

  test('the head with and without --auto-chain resolve identically', () => {
    const { base, vault, yaml } = makeVault('parity');
    const plain = runCLI(base, ['roadmap', '--from', yaml, '--yes']);
    assert.strictEqual(plain.status, 0, plain.out);
    assert.deepStrictEqual(dependsOn(vault, 'head.md'), ['T-out']);
    // Without the flag nothing is chained; with it (test above) the head is
    // unchanged too. The flag may only ADD chain edges, never remove authored
    // ones from a note it does not chain.
    assert.deepStrictEqual(dependsOn(vault, 'second.md'), []);
  });

  test('a head entry that explicitly declares depends_on: [] still clears', () => {
    // User intent is untouched by the #322 fix: an explicit empty list in the
    // ROADMAP FILE is the learner's own "clear" claim and must still win.
    const { base, vault, yaml } = makeVault('declared-clear', ['    depends_on: []']);
    const result = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--yes']);
    assert.strictEqual(result.status, 0, result.out);
    assert.deepStrictEqual(dependsOn(vault, 'head.md'), []);
    assert.deepStrictEqual(dependsOn(vault, 'second.md'), ['T-head']);
  });

  test('a brand-new chain head is created with an empty depends_on', () => {
    // Bytes-on-create are unchanged by the fix: with no note and no existing
    // topic behind the id, preservation still resolves to `[]`.
    const { base, vault, yaml } = makeVault('fresh-head');
    fs.rmSync(path.join(vault, 'head.md'));
    const result = runCLI(base, ['roadmap', '--from', yaml, '--auto-chain', '--yes']);
    assert.strictEqual(result.status, 0, result.out);
    assert.deepStrictEqual(dependsOn(vault, 'head.md'), []);
    assert.deepStrictEqual(dependsOn(vault, 'second.md'), ['T-head']);
  });
});
