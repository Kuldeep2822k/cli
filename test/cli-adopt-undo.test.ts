import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PALEE_ARGV } from './palee-cli';
import { Lock } from '../src/storage';

/**
 * `palee adopt --undo` (#299).
 *
 * Adoption is the one write in this CLI that touches every note in a vault, and it
 * had no inverse: after `adopt --all --yes` on 120 notes the only reversal was
 * hand-editing YAML in all 120 files. Reversal has one acceptable shape — strip the
 * keys PALEE owns and not one byte more — so every test here is about what
 * survives, not about what disappears. A removal that re-serialised the whole
 * frontmatter block would pass a "palee_id is gone" test while destroying the
 * learner's comments, key order and body, so the assertions below are byte
 * comparisons over whole trees.
 */
describe('palee adopt --undo reverses adoption without touching authored content', () => {
  let tempDir: string;
  let vaultDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-undo-'));
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
    delete process.env.PALEE_CONFIG_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs the real CLI in a child process against this suite's vault. */
  function runCLI(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [...PALEE_ARGV, ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: tempDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /** Writes one note into the vault root and returns its vault-relative path. */
  function writeNote(name: string, content: string): string {
    fs.writeFileSync(path.join(vaultDir, name), content, 'utf8');
    return name;
  }

  function readNote(name: string): string {
    return fs.readFileSync(path.join(vaultDir, name), 'utf8');
  }

  /** SHA-256 of a file's bytes, so "unchanged" means unchanged, not "equivalent". */
  function fileDigest(absPath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  }

  /** Digest over every byte of a tree, paths included. */
  function treeDigest(dir: string): string {
    const entries: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else {
          entries.push(`${path.relative(dir, child).replace(/\\/g, '/')}=${fileDigest(child)}`);
        }
      }
    };
    walk(dir);
    return crypto.createHash('sha256').update(entries.sort().join('\n')).digest('hex');
  }

  /** The frontmatter keys of a note, in the order they sit on disk. */
  function frontmatterKeys(content: string): string[] {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!block) return [];
    return block[1]
      .split(/\r?\n/)
      .filter((line) => /^[A-Za-z_][\w-]*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
  }

  /** Body text, everything after the closing fence. */
  function bodyOf(text: string): string {
    const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
    return m ? text.slice(m[0].length) : text;
  }

  /**
   * The keys PALEE owns, as `--undo` documents them.
   *
   * @remarks
   * Held here as a literal so a change to the strip set has to be deliberate, and
   * paired with `the owned set is exactly what adoption writes`, which derives the
   * written set from a real adoption's frontmatter diff rather than from this list.
   */
  const OWNED = [
    'palee_id',
    'palee_schema',
    'difficulty',
    'depends_on',
    'topic_mastery',
    'assessed_at',
    'conceptual',
    'practical',
    'debug',
    'feynman',
    'ease_factor',
    'interval_days',
    'repetition',
    'lapses',
    'last_quality',
    'last_reviewed_at',
    'due_at',
    'depends_on_source',
    'topic',
    'track',
    'status',
    'dependencies',
    'assessment',
    'review',
  ];

  const HUMAN_NOTE = [
    '---',
    '# a standalone comment about this file, mine',
    'author: Ada Lovelace          # aligned trailing comment, mine',
    'title: Recursion',
    'tags:',
    '  - cs/recursion',
    '  - lecture',
    'review_by: 2026-11-01',
    'my_block: |',
    '  free text I keep in the frontmatter',
    '  # not a comment, part of the block scalar',
    '---',
    '',
    '# Recursion',
    '',
    'Body prose that happens to contain fence-like lines:',
    '',
    '```',
    '# a heading inside a fence',
    '---',
    '```',
    '',
    '- [ ] read chapter 4',
    '',
  ].join('\n');

  beforeEach(() => {
    for (const entry of fs.readdirSync(vaultDir)) {
      fs.rmSync(path.join(vaultDir, entry), { recursive: true, force: true });
    }
  });

  test('--undo strips the owned keys and leaves authored content byte-identical', () => {
    const note = writeNote('recursion.md', HUMAN_NOTE);
    const beforeBytes = readNote(note);

    const adopt = runCLI(['adopt', note, '--yes']);
    assert.strictEqual(adopt.status, 0, adopt.stdout + adopt.stderr);
    const adoptedBytes = readNote(note);
    assert.match(adoptedBytes, /palee_id: T-/, 'adoption did its job');

    const undo = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);
    const after = readNote(note);

    // 1. No owned key survives anywhere in the note.
    for (const key of OWNED) {
      assert.doesNotMatch(after, new RegExp(`^${key}:`, 'm'), `--undo left ${key} in the frontmatter`);
    }
    assert.doesNotMatch(after, /palee_id/, 'the id is gone, not renamed');

    // 2. The standalone human comment is byte-identical to what was written before
    //    adoption ever ran.
    const standalone = '# a standalone comment about this file, mine';
    assert.ok(beforeBytes.split('\n').includes(standalone), 'the planted comment exists');
    assert.ok(
      after.split('\n').includes(standalone),
      'the comment survived adoption and un-adoption verbatim'
    );

    // 2b. The aligned trailing comment: `--undo` must not move it. Its column
    //     padding is normalised by the CST re-emit that `adopt` performs on the way
    //     in, so the honest comparison for a removal is against the adopted bytes —
    //     and the text itself is what has to survive either way.
    const trailingText = '# aligned trailing comment, mine';
    assert.ok(after.includes(trailingText), 'the trailing comment text survived');
    const lineOf = (text: string, needle: string): string =>
      text.split('\n').find((l) => l.includes(needle)) ?? '';
    assert.strictEqual(
      lineOf(after, trailingText),
      lineOf(adoptedBytes, trailingText),
      'the removal changed nothing on the line the comment sits on'
    );

    // 3. Every authored key survives, with its value and its ordering.
    const authored = ['author', 'title', 'tags', 'review_by', 'my_block'];
    assert.deepStrictEqual(
      frontmatterKeys(after).filter((k) => authored.includes(k)),
      authored,
      'authored keys keep their order and none is dropped'
    );
    assert.match(after, /my_block: \|\r?\n {2}free text I keep in the frontmatter/);
    assert.match(after, / {2}# not a comment, part of the block scalar/, 'block scalar content is not a comment');

    // 4. The body is byte-for-byte what it was before adoption ever ran.
    assert.strictEqual(bodyOf(after), bodyOf(beforeBytes), 'the body is untouched, byte for byte');
    assert.match(after, /# a heading inside a fence/);

    // 5. The run reports which keys it removed.
    assert.match(undo.stdout, /Keys removed:.*palee_id/, undo.stdout);
  });

  test('--undo --dry-run changes not one byte of the vault and names the keys', () => {
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);

    const beforeDigest = treeDigest(vaultDir);
    const dry = runCLI(['adopt', note, '--undo', '--dry-run']);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);

    assert.strictEqual(treeDigest(vaultDir), beforeDigest, 'a dry run writes nothing, anywhere');
    assert.match(dry.stdout, /Dry-run complete\. No files were modified\./, dry.stdout);
    // The required output: which note, and exactly which keys.
    assert.match(dry.stdout, /recursion\.md \(T-\d{8}-\d{6}-[0-9a-f]{8}\)/, dry.stdout);
    assert.match(dry.stdout, /removes: palee_id, palee_schema, difficulty/, dry.stdout);
    assert.match(dry.stdout, /due_at/, dry.stdout);
    assert.match(readNote(note), /palee_id: T-/, 'the preview was honest about not acting');
  });

  test('--undo is idempotent: the second run reports not adopted at exit 0', () => {
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);

    const first = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(first.status, 0, first.stdout + first.stderr);
    const afterFirst = readNote(note);
    assert.doesNotMatch(afterFirst, /palee_id/);

    const second = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(second.status, 0, `a repeat undo is not an error: ${second.stderr}`);
    assert.match(second.stdout, /recursion\.md is not adopted/, second.stdout);
    assert.match(second.stdout, /nothing to un-adopt/, second.stdout);
    assert.strictEqual(readNote(note), afterFirst, 'and it wrote nothing on the repeat');
  });

  test('a batch undo leaves notes that were never adopted alone', () => {
    writeNote('adopted-a.md', '---\ntitle: A\nauthor: human\n---\n# A\n');
    writeNote('adopted-b.md', '---\ntitle: B\nauthor: human\n---\n# B\n');
    const stranger = writeNote('journal.md', '---\ntitle: Journal\ndifficulty: hard-won\n---\n# Journal\n');
    const strangerBefore = readNote(stranger);

    const adopt = runCLI(['adopt', '--all', '--exclude', 'journal.md', '--yes']);
    assert.strictEqual(adopt.status, 0, adopt.stdout + adopt.stderr);
    assert.match(readNote(stranger), /title: Journal/, 'the excluded note was never adopted');
    assert.doesNotMatch(readNote(stranger), /palee_id/);

    const undo = runCLI(['adopt', '--all', '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);
    assert.match(undo.stdout, /Ready to Undo: {4}2 notes/, undo.stdout);
    assert.match(undo.stdout, /Not Adopted: {6}1 notes/, undo.stdout);

    assert.doesNotMatch(readNote('adopted-a.md'), /palee_id/);
    assert.doesNotMatch(readNote('adopted-b.md'), /palee_id/);
    // `difficulty` is on the owned list, but only ever for an adopted note: an
    // untracked note's own key is nobody else's to remove.
    assert.strictEqual(readNote(stranger), strangerBefore, 'the untracked note is untouched');
  });

  test('the owned set is exactly what adoption writes, plus the opt-out title', () => {
    // Derived from a real adopt run rather than from the prose: the frontmatter
    // keys adoption added are the set undo must clear. If adopt starts writing a
    // new key, this fails before --undo silently begins leaving it behind.
    writeNote('probe.md', '---\nauthor: human\n---\n# Probe\n');
    const beforeKeys = frontmatterKeys(readNote('probe.md'));

    runCLI(['adopt', 'probe.md', '--difficulty', 'advanced', '--yes']);
    const written = frontmatterKeys(readNote('probe.md')).filter((k) => !beforeKeys.includes(k));
    assert.ok(
      written.length >= 14,
      `adoption should have written a full tracking block, got ${written.join(', ')}`
    );
    assert.ok(
      written.every((k) => OWNED.includes(k) || k === 'title'),
      `every key adoption wrote is owned or the un-owned title, got ${written.join(', ')}`
    );

    const keptTitle = runCLI(['adopt', 'probe.md', '--undo', '--yes']);
    assert.strictEqual(keptTitle.status, 0, keptTitle.stdout + keptTitle.stderr);
    assert.deepStrictEqual(
      frontmatterKeys(readNote('probe.md')),
      [...beforeKeys, 'title'],
      'every owned key is gone and the un-owned title is the only residue'
    );
    assert.match(keptTitle.stdout, /Kept `title`/, keptTitle.stdout);
    assert.match(keptTitle.stdout, /--drop-title/, keptTitle.stdout);

    // Same note, same adoption, the judgement handed to the user instead.
    writeNote('probe.md', '---\nauthor: human\n---\n# Probe\n');
    runCLI(['adopt', 'probe.md', '--difficulty', 'advanced', '--yes']);
    const dropped = runCLI(['adopt', 'probe.md', '--undo', '--drop-title', '--yes']);
    assert.strictEqual(dropped.status, 0, dropped.stdout + dropped.stderr);
    assert.deepStrictEqual(frontmatterKeys(readNote('probe.md')), beforeKeys);
    assert.match(dropped.stdout, /Keys removed: .*title/, dropped.stdout);
  });

  test('a chained batch undo removes the edges and the provenance label too', () => {
    fs.mkdirSync(path.join(vaultDir, 'mod'), { recursive: true });
    writeNote('mod/01-one.md', '---\ntitle: One\n---\n# One\n');
    writeNote('mod/02-two.md', '---\ntitle: Two\n---\n# Two\n');

    const chain = runCLI(['adopt', 'mod', '--auto-chain', '--yes']);
    assert.strictEqual(chain.status, 0, chain.stdout + chain.stderr);
    assert.match(readNote('mod/02-two.md'), /depends_on_source: numbered/);

    const undo = runCLI(['adopt', 'mod', '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);
    assert.match(undo.stdout, /removes: .*depends_on, .*depends_on_source/, undo.stdout);
    assert.doesNotMatch(readNote('mod/02-two.md'), /depends_on/);
    assert.match(readNote('mod/02-two.md'), /title: Two/, 'the authored title stays');
  });

  test('a note with no frontmatter before adoption comes back byte-identical', () => {
    // The commonest shape in a curriculum vault. Two things have to be true: no
    // orphan `{}` block where the tracking used to be, and the body exactly as it
    // was. `title` is the one key adoption leaves by default, so the byte-identical
    // claim belongs to `--drop-title`, and the default claim is "one key, named".
    const pristine = '# Plain\n\nNothing in the frontmatter, because there was none.\n';
    writeNote('plain.md', pristine);

    runCLI(['adopt', 'plain.md', '--yes']);
    assert.match(readNote('plain.md'), /^---\r?\npalee_id: T-/);

    runCLI(['adopt', 'plain.md', '--undo', '--yes']);
    assert.strictEqual(
      readNote('plain.md'),
      `---\ntitle: Plain\n---\n${pristine}`,
      'the only residue is the minted title, and the block is not an empty `{}`'
    );
    assert.doesNotMatch(readNote('plain.md'), /\{\}/, 'no empty-mapping block was left behind');

    writeNote('plain.md', pristine);
    runCLI(['adopt', 'plain.md', '--yes']);
    runCLI(['adopt', 'plain.md', '--undo', '--drop-title', '--yes']);
    assert.strictEqual(readNote('plain.md'), pristine, 'with --drop-title the file is byte-identical');
  });

  test('--drop-title without --undo is a usage refusal', () => {
    // A qualifier for one mode must not be accepted by the other, where it would
    // be silently inert — the same refusal `--chain-tier` without `--auto-chain` gets.
    const note = writeNote('recursion.md', HUMAN_NOTE);
    const before = treeDigest(vaultDir);

    const run = runCLI(['adopt', note, '--drop-title', '--yes']);
    assert.strictEqual(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /--drop-title requires --undo/, run.stderr);
    assert.strictEqual(treeDigest(vaultDir), before, 'and the refusal wrote nothing');
  });

  test('a CRLF note keeps CRLF and a BOM note keeps its BOM', () => {
    const crlf = writeNote('crlf.md', '---\r\ntitle: CRLF\r\nauthor: human\r\n---\r\n\r\n# CRLF\r\n');
    runCLI(['adopt', crlf, '--yes']);
    assert.match(readNote(crlf), /palee_id: T-\d{8}-\d{6}-[0-9a-f]{8}\r\n/);

    runCLI(['adopt', crlf, '--undo', '--yes']);
    const undone = readNote(crlf);
    const closingFence = undone.indexOf('\r\n---', 4);
    assert.ok(closingFence > 0, 'the block still closes with a CRLF break');
    const block = undone.slice(0, closingFence);
    const lf = (block.match(/\n/g) ?? []).length;
    const crlfCount = (block.match(/\r\n/g) ?? []).length;
    assert.strictEqual(lf, crlfCount, 'no bare LF slipped into a CRLF block');
    assert.match(undone, /author: human\r\n/);

    const bom = writeNote('bom.md', '\uFEFF---\ntitle: Bom\nauthor: human\n---\n# Bom\n');
    runCLI(['adopt', bom, '--yes']);
    runCLI(['adopt', bom, '--undo', '--yes']);
    const bomBytes = fs.readFileSync(path.join(vaultDir, bom));
    assert.strictEqual(bomBytes[0], 0xef, 'the UTF-8 BOM is still the first byte on disk');
    assert.match(bomBytes.toString('utf8'), /author: human/, 'and the authored key survived');
  });

  test('scope selection is adoption\'s: directory, --include, --exclude, --tag', () => {
    fs.mkdirSync(path.join(vaultDir, 'sub'), { recursive: true });
    writeNote('in-scope.md', '---\ntitle: In\n---\n# In\n');
    writeNote('sub/nested.md', '---\ntitle: Nested\n---\n# Nested\n');

    runCLI(['adopt', '--all', '--yes']);
    assert.match(readNote('in-scope.md'), /palee_id/);
    assert.match(readNote('sub/nested.md'), /palee_id/);

    // A directory scope reaches only what is under it.
    const scoped = runCLI(['adopt', 'sub', '--undo', '--yes']);
    assert.strictEqual(scoped.status, 0, scoped.stdout + scoped.stderr);
    assert.doesNotMatch(readNote('sub/nested.md'), /palee_id/);
    assert.match(readNote('sub/nested.md'), /title: Nested/);
    assert.match(readNote('in-scope.md'), /palee_id/, 'the note outside the directory is untouched');

    // `--exclude` refuses its own target, `--include` selects it.
    runCLI(['adopt', '--all', '--undo', '--yes', '--exclude', 'in-scope.md']);
    assert.match(readNote('in-scope.md'), /palee_id/, 'excluded from its own undo');

    runCLI(['adopt', '--all', '--undo', '--yes', '--include', 'in-scope.md']);
    assert.doesNotMatch(readNote('in-scope.md'), /palee_id/, 'included means selected');

    // `--tag` gates on the note's own tags, which undo must not remove first.
    // Block style, because a flow sequence is re-spaced by the CST re-emit that
    // `adopt` itself already performs (`tags: [a]` → `tags: [ a ]`): undo inherits
    // the storage layer's serialisation, and this assertion is about survival.
    const tagged = writeNote('tagged.md', '---\ntitle: Tagged\ntags:\n  - cs/grade-a\n---\n# Tagged\n');
    runCLI(['adopt', tagged, '--yes']);
    const tagRun = runCLI(['adopt', '--all', '--undo', '--yes', '--tag', 'cs/grade-a']);
    assert.strictEqual(tagRun.status, 0, tagRun.stdout + tagRun.stderr);
    assert.doesNotMatch(readNote(tagged), /palee_id/);
    assert.match(readNote(tagged), /tags:\r?\n {2}- cs\/grade-a/, 'the tag that selected it survives');
    assert.doesNotMatch(
      readNote(tagged),
      /^tags: \[ cs\/grade-a \]$/,
      'the list was not reflowed out of shape by the removal'
    );
  });

  test('a note whose frontmatter will not parse is named and skipped, not rewritten', () => {
    const broken = writeNote('broken.md', '---\npalee_id: T-mine\ndepends_on: [unclosed\n---\n# Broken\n');
    const before = readNote(broken);
    const healthy = writeNote('healthy.md', '---\ntitle: Healthy\n---\n# Healthy\n');
    runCLI(['adopt', healthy, '--yes']);

    const undo = runCLI(['adopt', '--all', '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, `one unreadable note must not fail the run: ${undo.stderr}`);
    assert.match(undo.stdout + undo.stderr, /broken\.md/);
    assert.match(undo.stdout + undo.stderr, /frontmatter will not parse/);
    assert.strictEqual(readNote(broken), before, 'its bytes, including its own id, are untouched');
    assert.doesNotMatch(readNote(healthy), /palee_id/, 'the readable note was still reversed');
  });

  test('a non-string palee_id is left alone rather than guessed at', () => {
    // `loadTopics` requires a non-empty string, so `palee_id: 12345` names no topic
    // anywhere in the CLI. Undo mirrors adoption's B7 rule: name it, count it, and
    // do not rewrite frontmatter whose authorship cannot be established.
    const note = writeNote('numeric.md', '---\npalee_id: 12345\ntitle: Numeric\n---\n# Numeric\n');
    const before = readNote(note);

    const undo = runCLI(['adopt', '--all', '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);
    assert.match(undo.stdout, /Unusable palee_id: {2}1 notes/, undo.stdout);
    assert.strictEqual(readNote(note), before);
  });

  test('an unclosed frontmatter opener is reported as unreadable, not as unadopted', () => {
    const note = writeNote('half.md', '---\npalee_id: T-mine\ntitle: Half\n\n# Half\n');
    const before = readNote(note);

    const batch = runCLI(['adopt', '--all', '--undo', '--yes']);
    assert.strictEqual(batch.status, 0, batch.stdout + batch.stderr);
    assert.match(batch.stdout, /never closes/, batch.stdout);
    assert.strictEqual(readNote(note), before);

    const single = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(single.status, 0, single.stdout + single.stderr);
    assert.match(single.stdout, /never closes it/, single.stdout);
    assert.strictEqual(readNote(note), before);
  });

  test('a comment sitting on a PALEE key is disclosed, not silently dropped', () => {
    // The one authored byte class a CST key removal cannot keep: the yaml library
    // attaches a comment to the node it precedes, so deleting the node deletes the
    // annotation. Hiding that would make the dry-run dishonest.
    const note = writeNote('annotated.md', '---\nauthor: human\n---\n# Annotated\n');
    runCLI(['adopt', note, '--yes']);
    const adopted = readNote(note);
    const annotated = adopted.replace(/^palee_id:/m, '# why this note is tracked\npalee_id:');
    assert.notStrictEqual(annotated, adopted, 'the owned key was found to annotate');
    fs.writeFileSync(path.join(vaultDir, note), annotated, 'utf8');

    const dry = runCLI(['adopt', note, '--undo', '--dry-run']);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Warning: removes the comment/, dry.stdout);
    assert.match(dry.stdout, /why this note is tracked/, dry.stdout);
    assert.match(readNote(note), /palee_id/, 'and a dry run still writes nothing');

    const committed = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(committed.status, 0, committed.stdout + committed.stderr);
    assert.match(
      committed.stdout,
      /why this note is tracked/,
      'the run repeats the warning, not only the preview'
    );
    assert.match(readNote(note), /author: human/, 'the authored key beside it is untouched');
  });

  test('flag combinations that describe a write are refused at exit 2, writing nothing', () => {
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);
    const before = treeDigest(vaultDir);

    const refusals: string[][] = [
      ['adopt', note, '--undo', '--auto-chain', '--yes'],
      ['adopt', note, '--undo', '--chain-tier', 'toc', '--yes'],
      ['adopt', note, '--undo', '--depends-on', 'T-x', '--yes'],
      ['adopt', note, '--undo', '--difficulty', 'advanced', '--yes'],
      ['adopt', '--undo'],
      ['adopt', '--undo', '--yes'],
      ['adopt', 'missing-note.md', '--undo', '--yes'],
    ];
    for (const args of refusals) {
      const run = runCLI(args);
      assert.strictEqual(run.status, 2, `${args.join(' ')} must be a usage refusal: ${run.stdout}`);
      assert.match(run.stderr, /Error:/, run.stderr);
    }
    assert.match(
      runCLI(['adopt', note, '--undo', '--auto-chain', '--yes']).stderr,
      /cannot be combined with --undo/
    );
    assert.strictEqual(treeDigest(vaultDir), before, 'a refusal changes no byte');
  });

  test('a batch undo without confirmation is refused in a non-interactive run', () => {
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);
    const before = readNote(note);

    const unconfirmed = runCLI(['adopt', '--all', '--undo']);
    assert.strictEqual(unconfirmed.status, 2, unconfirmed.stdout + unconfirmed.stderr);
    assert.match(
      unconfirmed.stderr,
      /Non-interactive environment\. Use -y or --yes/,
      unconfirmed.stderr
    );
    assert.strictEqual(readNote(note), before, 'a refused confirmation writes nothing');
  });

  test('answering the confirmation prompt with no writes nothing', async () => {
    // The prompt is the batch gate `adopt` already has, and a piped stdin is not a
    // TTY, so the refusal above is what a CI run sees. To exercise the branch that
    // actually asks, `process.stdin` is replaced with a readable that answers `n`.
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);
    const before = readNote(note);

    const { Readable } = await import('node:stream');
    const answered = Object.assign(Readable.from(['n\n']), { isTTY: true });
    const realStdin = process.stdin;
    // Captured at the stream rather than through `console.log`, because readline
    // writes the question straight to `process.stdout` and a console stub would
    // miss the one line this test exists to prove.
    const realWrite = process.stdout.write.bind(process.stdout);
    let printed = '';
    Object.defineProperty(process, 'stdin', { value: answered, configurable: true, writable: true });
    process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]): boolean => {
      printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      void rest;
      return true;
    }) as typeof process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { default: adoptEntry } = await import('../src/cli/adopt');
      await adoptEntry(undefined, { undo: true, all: true });
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write;
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
    }
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.match(printed, /Proceed with un-adoption\? \(y\/N\): /, printed);
    assert.match(printed, /Aborted\./, printed);
    assert.strictEqual(exitCode, undefined, 'declining is a clean exit 0, not an error');
    assert.strictEqual(readNote(note), before, 'and the note keeps every key it had');
  });

  test('a missing vault stops the reversal at exit 2', () => {
    const orphanConfig = path.join(tempDir, 'no-vault');
    fs.mkdirSync(orphanConfig, { recursive: true });
    fs.writeFileSync(path.join(orphanConfig, 'config.json'), JSON.stringify({}), 'utf8');

    const result = spawnSync(process.execPath, [...PALEE_ARGV, 'adopt', '--all', '--undo', '--yes'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PALEE_CONFIG_DIR: orphanConfig },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.strictEqual(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Vault path not configured/, result.stderr);
  });

  test('a path outside the vault is refused and its note keeps its keys', () => {
    const outside = path.join(tempDir, 'outside.md');
    fs.writeFileSync(outside, '---\npalee_id: T-outside-1\n---\n# Outside\n', 'utf8');
    const before = fs.readFileSync(outside, 'utf8');

    const asFile = runCLI(['adopt', '../outside.md', '--undo', '--yes']);
    assert.strictEqual(asFile.status, 2, asFile.stdout + asFile.stderr);
    assert.match(asFile.stderr, /escapes vault/, asFile.stderr);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), before);
  });

  test('an out-of-band edit between the read and the write exits 4 and is not clobbered', async () => {
    // The write's OCC expectation is the fingerprint of the bytes the plan was
    // built from, so a note that moves after being planned is a collision, not a
    // rewrite. Injected in-process: the edit lands after the read that built the
    // plan and before the read that verifies it — exactly the window a concurrent
    // Obsidian save occupies.
    const note = writeNote('race.md', '---\ntitle: Race\nauthor: human\n---\n# Race\n');
    const adopt = runCLI(['adopt', note, '--yes']);
    assert.strictEqual(adopt.status, 0, adopt.stdout + adopt.stderr);

    const abs = path.join(vaultDir, note);
    const originalReadFileSync = fs.readFileSync;
    let reads = 0;
    let edited = false;

    fs.readFileSync = ((target: unknown, options?: unknown): unknown => {
      const result = (originalReadFileSync as (t: unknown, o?: unknown) => unknown)(target, options);
      if (String(target) === abs) {
        reads += 1;
        if (reads === 1 && !edited) {
          edited = true;
          fs.appendFileSync(abs, '\nWritten by someone else while palee was planning.\n', 'utf8');
        }
      }
      return result;
    }) as typeof fs.readFileSync;

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logs: string[] = [];
    const realError = console.error;
    console.error = (msg?: unknown) => {
      logs.push(String(msg));
    };
    try {
      const { default: adoptEntry } = await import('../src/cli/adopt');
      await adoptEntry(note, { undo: true, yes: true });
    } finally {
      console.error = realError;
      fs.readFileSync = originalReadFileSync;
    }

    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.strictEqual(exitCode, 4, logs.join('\n'));
    assert.match(logs.join('\n'), /OCC conflict/);
    const onDisk = originalReadFileSync(abs, 'utf8');
    assert.match(onDisk, /Written by someone else/, 'the concurrent edit survived');
    assert.match(onDisk, /palee_id: T-/, 'and nothing was stripped from the newer bytes');
    assert.ok(reads >= 2, 'the plan was built from a read the write then re-verified');
  });

  test('a held lock on a note exits 4 instead of writing through it', async () => {
    const note = writeNote('locked.md', '---\ntitle: Locked\nauthor: human\n---\n# Locked\n');
    runCLI(['adopt', note, '--yes']);
    const abs = path.join(vaultDir, note);
    const lock = new Lock(vaultDir, abs);

    await lock.acquire();
    try {
      const result = runCLI(['adopt', note, '--undo', '--yes']);
      assert.strictEqual(result.status, 4, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /conflict/i, result.stderr);
      assert.match(readNote(note), /palee_id: T-/, 'the locked note kept its keys');
      assert.match(readNote(note), /author: human/, 'and its own content is intact');
    } finally {
      lock.release();
    }
  });

  test('a conflict partway through a batch unwinds the notes already written', async () => {
    // Rollback is what makes a 120-note reversal safe to attempt: a collision on
    // note two must not leave note one stripped while the run reports failure.
    const first = writeNote('a.md', '---\ntitle: A\nauthor: human\n---\n# A\n');
    const second = writeNote('b.md', '---\ntitle: B\nauthor: human\n---\n# B\n');
    runCLI(['adopt', '--all', '--yes']);
    const aBefore = readNote(first);
    const bBefore = readNote(second);

    const lock = new Lock(vaultDir, path.join(vaultDir, second));
    await lock.acquire();
    try {
      const result = runCLI(['adopt', '--all', '--undo', '--yes']);
      assert.strictEqual(result.status, 4, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Rolling back/, result.stderr);
    } finally {
      lock.release();
    }
    assert.strictEqual(readNote(first), aBefore, 'the note already reversed is restored');
    assert.strictEqual(readNote(second), bBefore, 'and the refused note never moved');
    assert.match(readNote(first), /palee_id: T-/, 'both are still adopted, as the failure claims');
  });

  test('undo leaves .palee/ derived views byte-identical and names what still refers to the topic', () => {
    // `regenerateIndex` and `rebuildHotAndIndex` take `topic_id` from the session
    // note, never from the topic note, so un-adopting cannot stale either view: a
    // rebuild reproduces the bytes already on disk. Undo therefore writes nothing
    // into `.palee/` — and reports the reference instead of quietly orphaning it.
    const note = writeNote('recursion.md', HUMAN_NOTE);
    runCLI(['adopt', note, '--yes']);
    const topicId = /palee_id: (T-[0-9a-f-]+)/.exec(readNote(note))?.[1];
    assert.ok(topicId, 'the adopted id is readable so a session can name it');

    const started = runCLI(['session', 'start', '--topic', topicId as string]);
    assert.strictEqual(started.status, 0, started.stdout + started.stderr);
    const ended = runCLI(['session', 'end', '--topic', topicId as string]);
    assert.strictEqual(ended.status, 0, ended.stdout + ended.stderr);

    const paleeDir = path.join(vaultDir, '.palee');
    assert.ok(fs.existsSync(path.join(paleeDir, 'hot.md')), 'the derived views exist to be protected');
    assert.match(fs.readFileSync(path.join(paleeDir, 'hot.md'), 'utf8'), new RegExp(topicId as string));
    const paleeBefore = treeDigest(paleeDir);

    const undo = runCLI(['adopt', note, '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);

    assert.strictEqual(treeDigest(paleeDir), paleeBefore, 'no byte under .palee/ was rewritten');
    assert.match(undo.stdout, /still name 1 un-adopted topic/, undo.stdout);
    assert.match(undo.stdout, new RegExp(topicId as string), undo.stdout);
    assert.match(undo.stdout, /\.palee\/hot\.md active_topic/, undo.stdout);

    // And the claim is checkable: validate reports the same dangling reference as a
    // warning, which is the surface that owns it.
    const validate = runCLI(['validate', '--json']);
    assert.match(validate.stdout, /valid-hot-memory/, validate.stdout);
  });

  test('an untracked note loses nothing when the vault-wide batch scans it', () => {
    // The vault-wide case from the issue: most notes in the scope were never
    // adopted, so they must not be in the write set at all — a fingerprint
    // comparison, not a re-emit.
    const quiet = writeNote('quiet.md', '---\ntags: [scratch]\nmy_key: 1\n---\n\n# Quiet\n\nprose\n');
    const loud = writeNote('loud.md', '---\ntitle: Loud\n---\n# Loud\n');
    runCLI(['adopt', loud, '--yes']);

    const quietDigest = fileDigest(path.join(vaultDir, quiet));
    const undo = runCLI(['adopt', '--all', '--undo', '--yes']);
    assert.strictEqual(undo.status, 0, undo.stdout + undo.stderr);
    assert.strictEqual(fileDigest(path.join(vaultDir, quiet)), quietDigest);
    assert.doesNotMatch(readNote('loud.md'), /palee_id/);
  });
});
