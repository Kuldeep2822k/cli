import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import { parseFrontmatter } from '../src/storage/frontmatter';
import { isValidTopicId } from '../src/engine/topic-id';

/**
 * #308 — the pre-write gate has to enforce the topic ID format.
 *
 * `roadmap --from` validates a list of defects before it writes anything: duplicate
 * ids, duplicate paths, invalid `difficulty`, non-numeric `order`, vault escapes,
 * invisible paths, incumbent renames, missing dependencies and cycles all fail
 * closed at exit `3` with zero bytes written. ID *format* was the one that got
 * through: the gate tested only `if (!id)`, so `T-Alpha`, `bad-noprefix` and
 * `T-bad_slug` were accepted, written into the vault, and reported as
 * `Roadmap validated successfully.` — and `palee validate` rejected the same ids
 * afterwards, when the notes and every edge naming them were already on disk.
 *
 * These tests pin the gate, not the after-the-fact rule: exit `3`, each offending
 * id named, the rule stated in the same breath, and the vault untouched.
 */
describe('roadmap import enforces the topic ID format before any write (#308)', () => {
  let tempDir: string;
  let vaultDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    origConfigDir = process.env.PALEE_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-id-gate-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ vaultPath: vaultDir }, null, 2),
      'utf8'
    );
  });

  after(() => {
    if (origConfigDir !== undefined) {
      process.env.PALEE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.PALEE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs the real CLI against this suite's vault without throwing on non-zero exit. */
  function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** Writes a roadmap fixture outside the vault and returns its path. */
  function writeFixture(name: string, content: string): string {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  /** Creates a note inside the vault, for fixtures the gate has to read. */
  function writeNote(rel: string, content: string): void {
    const abs = path.join(vaultDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  /** Every `.md` under the vault, as `relative path -> exact bytes`. */
  function snapshotVault(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.md')) {
          snapshot[path.relative(vaultDir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
        }
      }
    };
    walk(vaultDir);
    return snapshot;
  }

  /** A `relative -> bytes` map, for readable failure output on a snapshot diff. */
  function describeSnapshot(snapshot: Record<string, string>): string {
    return JSON.stringify(Object.keys(snapshot).sort());
  }

  function frontmatterOf(rel: string): Record<string, unknown> {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(vaultDir, rel), 'utf8'));
    assert.ok(frontmatter, `${rel} has no frontmatter`);
    return frontmatter;
  }

  // The issue's reproduction, verbatim.
  const BAD_THREE = [
    'topics:',
    '  - {id: T-Alpha,      title: Uppercase,  path: a.md}',
    '  - {id: bad-noprefix, title: NoPrefix,   path: b.md}',
    '  - {id: T-bad_slug,   title: Underscore, path: c.md}',
    '',
  ].join('\n');

  test('the issue fixture is refused at exit 3, every bad id named, zero bytes written', () => {
    const before = snapshotVault();
    const result = runCLI(['roadmap', '--from', writeFixture('badids.yaml', BAD_THREE), '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 3, `unparseable ids must fail closed: ${output}`);
    assert.doesNotMatch(output, /Roadmap validated successfully/, 'the success line is the defect being fixed');
    for (const badId of ['T-Alpha', 'bad-noprefix', 'T-bad_slug']) {
      assert.ok(output.includes(badId), `offending id ${badId} must be named: ${output}`);
    }
    assert.match(output, /Invalid topic ID format/);
    assert.match(output, /T- plus lowercase kebab-case slug/, 'the rule itself is stated, not just "invalid"');

    // Nothing landed: no note for any of the three, and no other byte moved.
    for (const rel of ['a.md', 'b.md', 'c.md']) {
      assert.strictEqual(fs.existsSync(path.join(vaultDir, rel)), false, `${rel} must not be written`);
    }
    assert.deepStrictEqual(
      snapshotVault(),
      before,
      `a refused import writes nothing: ${describeSnapshot(before)} -> ${describeSnapshot(snapshotVault())}`
    );
  });

  test('one malformed id invalidates the whole batch, valid sibling and its edge included', () => {
    // All-or-nothing, the same shape as the checks it sits beside: a roadmap that
    // also holds a well-formed topic must not import the good half and leave the
    // vault holding an edge onto an id that never landed.
    const before = snapshotVault();
    const file = writeFixture(
      'mixed-bad.yaml',
      [
        'topics:',
        '  - id: T-gate-head',
        '    title: Good Head',
        '    path: mixed/one.md',
        '  - id: T-Gate-Tail',
        '    title: Bad Uppercase',
        '    path: mixed/two.md',
        '    depends_on: [T-gate-head]',
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 3, output);
    assert.ok(output.includes('T-Gate-Tail'), 'the offending id is named');
    assert.strictEqual(
      fs.existsSync(path.join(vaultDir, 'mixed', 'one.md')),
      false,
      'the valid sibling is not written either'
    );
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'mixed', 'two.md')), false, 'nor the malformed one');
    assert.deepStrictEqual(snapshotVault(), before, `the refused batch wrote nothing: ${describeSnapshot(before)}`);
  });

  test('an id YAML reads as a number or a list is refused too', () => {
    // `isValidTopicId` is `value is string`, so a non-string id fails it — and that
    // is the right call: `loadTopics` and the wikilink resolver both treat a
    // non-string `palee_id` as no identity at all, so writing one mints a topic no
    // other command can name.
    const numeric = writeFixture(
      'numeric.yaml',
      ['topics:', '  - id: 20240115', '    title: Numeric Id', '    path: numeric.md', ''].join('\n')
    );
    const numericResult = runCLI(['roadmap', '--from', numeric, '--yes']);
    assert.strictEqual(numericResult.status, 3, numericResult.stdout + numericResult.stderr);
    assert.match(numericResult.stderr, /Invalid topic ID format/);
    assert.match(numericResult.stderr, /20240115/, 'the value is reported as written, not coerced');
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'numeric.md')), false);

    const list = writeFixture(
      'list.yaml',
      ['topics:', '  - id: [T-a]', '    title: List Id', '    path: list.md', ''].join('\n')
    );
    const listResult = runCLI(['roadmap', '--from', list, '--yes']);
    assert.strictEqual(listResult.status, 3, listResult.stdout + listResult.stderr);
    assert.match(listResult.stderr, /Invalid topic ID format/);
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'list.md')), false);
  });

  test('a missing id is still reported as a missing field, not as a format defect', () => {
    // `if (!id)` owns the absent case; the new check is guarded on `id`, so the two
    // messages stay distinguishable and one typo never produces two errors.
    const file = writeFixture(
      'noid.yaml',
      ['topics:', '  - title: No Id At All', '    path: noid.md', ''].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    assert.strictEqual(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /Topic missing "id" field/);
    assert.doesNotMatch(result.stderr, /Invalid topic ID format/, 'no id is not a malformed id');
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'noid.md')), false);
  });

  // Four input formats reach the same parsed topic list; the gate runs on that
  // list, so it has to bite in every one of them — not just in pure YAML.
  test('the Markdown frontmatter format is gated too', () => {
    const before = snapshotVault();
    const file = writeFixture(
      'fm-roadmap.md',
      [
        '---',
        'title: Fullstack Path',
        'topics:',
        '  - id: R-md-Upper',
        '    title: TypeScript Advanced',
        '    path: fm/ts-advanced.md',
        '    difficulty: advanced',
        '---',
        '',
        '# Fullstack Roadmap',
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 3, `frontmatter roadmaps go through the same gate: ${output}`);
    assert.match(output, /Invalid topic ID format/);
    assert.ok(output.includes('R-md-Upper'), 'the id as written in the frontmatter is named');
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'fm', 'ts-advanced.md')), false, 'zero bytes written');
    assert.deepStrictEqual(snapshotVault(), before, `the frontmatter batch wrote nothing: ${describeSnapshot(before)}`);
  });

  test('the embedded fenced YAML block format is gated too', () => {
    const before = snapshotVault();
    const file = writeFixture(
      'fenced-roadmap.md',
      [
        '# Cloud Architecture',
        '',
        '```yaml',
        'topics:',
        '  - id: T-bad_slug',
        '    title: Serverless Microservices',
        '    path: fenced/serverless.md',
        '```',
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 3, `fenced YAML goes through the same gate: ${output}`);
    assert.match(output, /Invalid topic ID format/);
    assert.ok(output.includes('T-bad_slug'), 'the id inside the fence is named');
    assert.strictEqual(fs.existsSync(path.join(vaultDir, 'fenced', 'serverless.md')), false, 'zero bytes written');
    assert.deepStrictEqual(snapshotVault(), before, `the fenced batch wrote nothing: ${describeSnapshot(before)}`);
  });

  test('the wikilink format is gated on the ids it inherits from the vault', () => {
    // `resolveWikilinkRoadmap` takes an adopted note's stored `palee_id` as the
    // topic id, so a bad id already living in the vault arrives on the parsed
    // topic list like any other. Refusing it is the fail-closed half of #308:
    // minting a fresh name over it instead is the silent rename the importer
    // already refuses elsewhere.
    writeNote(
      'tracks/legacy-note.md',
      ['---', 'palee_schema: 1', 'palee_id: T-Alpha', 'title: Alpha', 'depends_on: []', 'topic_mastery: 0', '---', '', '# Alpha', ''].join('\n')
    );
    writeNote('tracks/plain-note.md', '# Plain\n');
    const before = snapshotVault();
    const file = writeFixture(
      'wiki-roadmap.md',
      '---\npalee_roadmap: true\n---\n# Roadmap\n\n## Track\n\n- [[tracks/legacy-note]]\n- [[tracks/plain-note]]\n'
    );

    const result = runCLI(['roadmap', '--from', file, '-y']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 3, `a wikilink roadmap inherits ids the gate owns: ${output}`);
    assert.match(output, /Invalid topic ID format/);
    assert.ok(output.includes('T-Alpha'), 'the inherited id is named');
    assert.deepStrictEqual(
      snapshotVault(),
      before,
      `the plain note is not minted over either: ${describeSnapshot(before)} -> ${describeSnapshot(snapshotVault())}`
    );
    assert.deepStrictEqual(frontmatterOf(path.join('tracks', 'legacy-note.md')).palee_id, 'T-Alpha', 'the note is untouched');
  });

  // The legacy half of the policy, which the gate must not lose by re-typing a
  // pattern of its own: `topic-id.ts` keeps tool-generated historical ids valid
  // because validation reports defects in *user* data, not PALEE's own past
  // output. A roadmap naming a note that `adopt` minted before #29 is exactly such
  // a case, and a gate that rejected it would make those vaults un-importable.
  test('a legacy tool-generated adopt id stays acceptable', () => {
    const legacyId = 'T-20260830T120000-a1b2c3d4';
    assert.ok(isValidTopicId(legacyId), 'precondition: the policy itself accepts this id');
    assert.ok(
      !/^T-[a-z0-9]+(-[a-z0-9]+)*$/.test(legacyId),
      'and it passes on the legacy pattern, not the canonical one — which is why re-implementing the pattern here would break it'
    );

    const file = writeFixture(
      'legacy.yaml',
      [
        'topics:',
        `  - id: ${legacyId}`,
        '    title: Legacy Adopt Topic',
        '    path: legacy/one.md',
        '  - id: T-legacy-fore',
        '    title: Points At The Legacy Id',
        '    path: legacy/two.md',
        `    depends_on: [${legacyId}]`,
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `a legacy id must still import: ${output}`);
    assert.match(output, /Roadmap validated successfully/);
    assert.strictEqual(frontmatterOf(path.join('legacy', 'one.md')).palee_id, legacyId, 'the legacy id lands unchanged');
    assert.deepStrictEqual(
      frontmatterOf(path.join('legacy', 'two.md')).depends_on,
      [legacyId],
      'and an edge naming it resolves'
    );
  });

  test('canonical ids of the swept fixture shape still import', () => {
    // Behaviour-neutrality control for the fixture sweep: the ids the migrated
    // tests now use must land exactly as the originals did.
    const file = writeFixture(
      'canonical.yaml',
      [
        'topics:',
        '  - id: T-alpha',
        '    title: Alpha',
        '    path: canon/alpha.md',
        '    difficulty: advanced',
        '  - id: T-md-1',
        '    title: Beta',
        '    path: canon/beta.md',
        '    depends_on: [T-alpha]',
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--yes']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(frontmatterOf(path.join('canon', 'alpha.md')).palee_id, 'T-alpha');
    assert.strictEqual(frontmatterOf(path.join('canon', 'alpha.md')).difficulty, 'advanced');
    assert.strictEqual(frontmatterOf(path.join('canon', 'beta.md')).palee_id, 'T-md-1');
    assert.deepStrictEqual(frontmatterOf(path.join('canon', 'beta.md')).depends_on, ['T-alpha']);
  });

  test('the gate runs before --auto-chain announces anything', () => {
    // `Auto-chain: N chain edge(s) synthesized` is logged only once validation has
    // passed (#73 review item 3); a batch this gate rejects must not have claimed
    // work it did not do.
    const before = snapshotVault();
    const file = writeFixture(
      'autobad.yaml',
      [
        'topics:',
        '  - id: T-Bad-Head',
        '    title: Head',
        '    path: chain/one.md',
        '    order: 1',
        '  - id: T-good-tail',
        '    title: Tail',
        '    path: chain/two.md',
        '    order: 2',
        '',
      ].join('\n')
    );
    const result = runCLI(['roadmap', '--from', file, '--auto-chain', '--yes']);
    assert.strictEqual(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /T-Bad-Head/);
    assert.doesNotMatch(result.stdout, /chain edge\(s\) synthesized/);
    assert.deepStrictEqual(snapshotVault(), before, `the rejected chain wrote nothing: ${describeSnapshot(before)}`);
  });
});
