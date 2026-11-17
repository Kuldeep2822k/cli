import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import adoptCommand, { formatDiagnosticPath } from '../src/cli/adopt';
import type { AdoptOptions } from '../src/types';

/**
 * #538: batch `palee adopt --all` judged a note only by the bytes its scan read.
 * Phase 1 re-reads fresh bytes and computed the OCC fingerprint from them, so a
 * `palee_id` written by a concurrent adoption between scan and preflight passed
 * the write check and was silently overwritten — the scan-keyed rename
 * `docs/adr/0015-identity-preservation.md` forbids.
 *
 * @remarks
 * A child process cannot be timed into that window, so the Phase-1 re-read is
 * made to return the concurrently written bytes in process, the same way
 * `test/cli-adopt-undo-disclosure.test.ts` pins the undo drift window.
 */

const PLAIN = ['# Plain', '', 'Nothing adopted here.', ''].join('\n');
const BETA = ['# Beta', '', 'A second candidate note.', ''].join('\n');

function concurrentlyAdopted(idLine: string): string {
  return [
    '---',
    idLine,
    'palee_schema: 1',
    'title: "Alpha"',
    '---',
    '',
    '# Alpha',
    '',
    'Adopted by another process.',
    '',
  ].join('\n');
}

interface NoteFixture {
  name: string;
  content: string;
  /** Bytes the Phase-1 re-read returns instead of what the scan saw. */
  tampered?: string;
  /**
   * Bytes an editor writes to disk at the seam — the Phase-1 re-read reads
   * them back through the real filesystem, so "what the editor left" and "what
   * the reader saw" are one artefact. Stronger than {@link tampered} for
   * byte-for-byte assertions after the run.
   */
  edited?: string;
}

describe('palee adopt --all vs a concurrent adoption (#538)', () => {
  let tempDir: string;
  let vaultDir: string;
  let origConfigDir: string | undefined;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-adopt-concurrency-'));
    vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    origConfigDir = process.env.PALEE_CONFIG_DIR;
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

  /**
   * Runs one plain `adopt --all` where the Phase-1 re-read of each tampered note
   * returns its `tampered` bytes instead of what the scan saw. Asserts the stub
   * fired for every tampered note and that no note's bytes changed.
   */
  async function runBatchAgainst(
    fixtures: NoteFixture[],
    logged: string[],
    options: AdoptOptions = { all: true, yes: true },
    tamperFromRead = 2
  ): Promise<number | undefined> {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    for (const fixture of fixtures) {
      fs.writeFileSync(path.join(vaultDir, fixture.name), fixture.content, 'utf8');
    }

    const tamperedByName = new Map(
      fixtures
        .filter((fixture): fixture is NoteFixture & { tampered: string } => fixture.tampered !== undefined)
        .map((fixture) => [fixture.name, fixture.tampered])
    );
    const editedByName = new Map(
      fixtures
        .filter((fixture): fixture is NoteFixture & { edited: string } => fixture.edited !== undefined)
        .map((fixture) => [fixture.name, fixture.edited])
    );
    const realRead = fs.readFileSync;
    const realWriteFileSync = fs.writeFileSync;
    const reads = new Map<string, number>();
    // Basename-keyed: the CLI canonicalises the vault, so on macOS these paths
    // arrive as `/private/var/...` while the suite's are `/var/...`.
    (fs as any).readFileSync = (...args: unknown[]): unknown => {
      if (typeof args[0] === 'string') {
        const name = path.basename(args[0]);
        const tampered = tamperedByName.get(name);
        const edited = editedByName.get(name);
        if (tampered !== undefined || edited !== undefined) {
          const count = (reads.get(name) ?? 0) + 1;
          reads.set(name, count);
          if (count === tamperFromRead && edited !== undefined) {
            // The editor's write lands on disk exactly at the seam; the
            // Phase-1 read below then observes it through the real fs.
            realWriteFileSync(args[0], edited, 'utf8');
          }
          if (count >= tamperFromRead && tampered !== undefined) {
            // Honour the encoding argument: the handler reads with 'utf8' and
            // parses the result, and a Buffer would throw above the check.
            return typeof args[1] === 'string' ? tampered : Buffer.from(tampered, 'utf8');
          }
        }
      }
      return (realRead as (...a: unknown[]) => unknown)(...args);
    };

    const priorExit = process.exitCode;
    process.exitCode = 0;
    const realErr = console.error;
    const realLog = console.log;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    console.log = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await adoptCommand(undefined, options);
    } finally {
      console.error = realErr;
      console.log = realLog;
      (fs as any).readFileSync = realRead;
    }
    const exit = process.exitCode;
    process.exitCode = priorExit;

    // The stub must have actually fired, or this test proves nothing: if the
    // re-read were never intercepted, the batch would look like a plain success.
    for (const name of [...tamperedByName.keys(), ...editedByName.keys()]) {
      assert.ok(
        (reads.get(name) ?? 0) >= tamperFromRead,
        `expected ${tamperFromRead} read(s) of ${name}, saw ${reads.get(name) ?? 0}`
      );
    }
    // Refused before a single write: every note still holds the bytes the
    // editor left (or the scan's, when no editor ran).
    for (const fixture of fixtures) {
      assert.equal(
        fs.readFileSync(path.join(vaultDir, fixture.name), 'utf8'),
        fixture.edited ?? fixture.content,
        `${fixture.name} must be untouched`
      );
    }
    return exit;
  }

  test('a note adopted between scan and preflight aborts the batch at exit 4, writing nothing', async () => {
    const logged: string[] = [];
    const exit = await runBatchAgainst(
      [
        { name: 'alpha.md', content: PLAIN, tampered: concurrentlyAdopted('palee_id: T-other') },
        { name: 'beta.md', content: BETA },
      ],
      logged
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /OCC conflict: 1 note\(s\) were modified while this run was planning; nothing was adopted/.test(l)),
      logged.join(' | ')
    );
    assert.ok(
      logged.some((l) => /"alpha\.md" \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('a typed id is identity too: a non-string palee_id is refused, never overwritten', async () => {    const logged: string[] = [];
    const exit = await runBatchAgainst(
      [
        { name: 'alpha.md', content: PLAIN, tampered: concurrentlyAdopted('palee_id: 12345') },
        { name: 'beta.md', content: BETA },
      ],
      logged
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /"alpha\.md" \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('an id hidden by an unclosed opener is refused rather than buried under a minted block', async () => {
    const logged: string[] = [];
    const exit = await runBatchAgainst(
      [
        {
          name: 'alpha.md',
          content: PLAIN,
          tampered: ['---', 'palee_id: T-open', 'title: "Never closed"'].join('\n'),
        },
        { name: 'beta.md', content: BETA },
      ],
      logged
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /"alpha\.md" \(the frontmatter opener is unclosed\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('a conflict over more than five notes names the first five and counts the rest', async () => {
    const fixtures: NoteFixture[] = Array.from({ length: 6 }, (_, i) => ({
      name: `n${i}.md`,
      content: PLAIN.replace('Nothing adopted here.', `Body n${i}.`),
      tampered: concurrentlyAdopted(`palee_id: T-n${i}`),
    }));
    const logged: string[] = [];
    const exit = await runBatchAgainst(fixtures, logged);

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /OCC conflict: 6 note\(s\) were modified/.test(l)),
      logged.join(' | ')
    );
    assert.equal(logged.filter((l) => /• "n\d\.md" \(/.test(l)).length, 5, logged.join(' | '));
    assert.ok(logged.some((l) => /… and 1 more/.test(l)), logged.join(' | '));
  });

  test('under --auto-chain, a planned edge is never written against a moved identity', async () => {
    const preview: string[] = [];
    await runBatchAgainst(
      [
        { name: '01-gamma.md', content: PLAIN },
        { name: '02-delta.md', content: BETA },
      ],
      preview,
      { all: true, yes: true, autoChain: true, dryRun: true }
    );
    assert.ok(
      preview.some((l) => /02-delta\.md depends on 01-gamma\.md/.test(l)),
      preview.join(' | ')
    );

    const logged: string[] = [];
    // Distinct paths, and the third read: auto-chain calls loadTopics() before
    // Phase 1, which reads each note one more time (after the scan's read). Read
    // 3 is the pre-write re-read, so the id lands after planning, not during it.
    const exit = await runBatchAgainst(
      [
        { name: '01-gamma.md', content: PLAIN, tampered: concurrentlyAdopted('palee_id: T-other') },
        { name: '02-delta.md', content: BETA },
      ],
      logged,
      { all: true, yes: true, autoChain: true },
      3
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /"01-gamma\.md" \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('dependency declarations changing after planning abort the batch before any write', async () => {
    const logged: string[] = [];
    const exit = await runBatchAgainst(
      [
        { name: '01-gamma.md', content: PLAIN },
        {
          name: '02-delta.md',
          content: BETA,
          tampered: [
            '---',
            'depends_on: [T-other]',
            '---',
            '',
            '# Delta',
            '',
            '## Prerequisites',
            '',
            '- [[01-gamma]]',
            '',
            'A second candidate note.',
            '',
          ].join('\n'),
        },
      ],
      logged,
      { all: true, yes: true, autoChain: true },
      3
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /"02-delta\.md" \(a dependency declaration changed\)/.test(l)),
      logged.join(' | ')
    );
  });

  /** Runs one plain `adopt --all` against the vault exactly as it stands. */
  async function runBatchAgain(logged: string[]): Promise<number | undefined> {
    const priorExit = process.exitCode;
    process.exitCode = 0;
    const realErr = console.error;
    const realLog = console.log;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    console.log = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await adoptCommand(undefined, { all: true, yes: true });
    } finally {
      console.error = realErr;
      console.log = realLog;
    }
    const exit = process.exitCode;
    process.exitCode = priorExit;
    return exit;
  }

  // P3-13 review (#565): the Phase-1 re-read judged the fresh frontmatter with
  // a truthiness gate, so the values YAML parses as 0, false, or "" fell
  // through to a fresh adoption — `composeAdoptedNote` minted a replacement id
  // and the fingerprint of the edited bytes became the write baseline, so the
  // editor's value was overwritten without an OCC conflict. Presence, not
  // truthiness, is the identity rule the scan and `--undo` already apply.
  const FALSY_IDS = [
    { label: 'zero', yamlLine: 'palee_id: 0' },
    { label: 'false', yamlLine: 'palee_id: false' },
    { label: 'an empty string', yamlLine: 'palee_id: ""' },
  ];
  for (const { label, yamlLine } of FALSY_IDS) {
    test(`a present falsy palee_id (${label}) written after the scan keeps its identity`, async () => {
      const logged: string[] = [];
      const editorsBytes = concurrentlyAdopted(yamlLine);
      // The editor's write lands at the scan-to-preparation seam, through the
      // real filesystem; the harness asserts the note still holds these exact
      // bytes afterwards.
      const exit = await runBatchAgainst(
        [
          { name: 'alpha.md', content: PLAIN, edited: editorsBytes },
          { name: 'beta.md', content: BETA },
        ],
        logged
      );

      assert.equal(exit, 4, logged.join(' | '));
      assert.ok(
        logged.some((l) => /OCC conflict: 1 note\(s\) were modified while this run was planning; nothing was adopted/.test(l)),
        logged.join(' | ')
      );
      assert.ok(
        logged.some((l) => /"alpha\.md" \(a palee_id is now declared\)/.test(l)),
        logged.join(' | ')
      );
    });
  }

  test('a present valid id written after the scan is preserved, not replaced', async () => {
    const logged: string[] = [];
    const editorsBytes = concurrentlyAdopted('palee_id: T-editor');
    const exit = await runBatchAgainst(
      [
        { name: 'alpha.md', content: PLAIN, edited: editorsBytes },
        { name: 'beta.md', content: BETA },
      ],
      logged
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /"alpha\.md" \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('after the refusal, the still-eligible note is adopted on the next run', async () => {
    // The vault as the refused run left it: the editor's falsy id is on disk.
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    const editorsBytes = concurrentlyAdopted('palee_id: 0');
    fs.writeFileSync(path.join(vaultDir, 'alpha.md'), editorsBytes, 'utf8');
    fs.writeFileSync(path.join(vaultDir, 'beta.md'), BETA, 'utf8');

    const logged: string[] = [];
    const exit = await runBatchAgain(logged);

    assert.equal(exit, 0, logged.join(' | '));
    assert.equal(
      fs.readFileSync(path.join(vaultDir, 'alpha.md'), 'utf8'),
      editorsBytes,
      'the refused note keeps its identity across the re-run'
    );
    assert.match(
      fs.readFileSync(path.join(vaultDir, 'beta.md'), 'utf8'),
      /palee_id: T-/,
      'the still-eligible note is adopted on the next run'
    );
    assert.ok(
      logged.some((l) => /Invalid palee_id: 1 notes/.test(l)),
      `alpha.md must be counted as skipped: ${logged.join(' | ')}`
    );
  });

  test('an absent or explicit-null palee_id stays unmanaged: the note is adopted', async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    const nullIdNote = [
      '---',
      'palee_id:',
      'title: "Null id"',
      '---',
      '',
      '# Null',
      '',
      'An empty YAML value is not an identity.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(vaultDir, 'alpha.md'), PLAIN, 'utf8');
    fs.writeFileSync(path.join(vaultDir, 'beta.md'), nullIdNote, 'utf8');

    const logged: string[] = [];
    const exit = await runBatchAgain(logged);

    assert.equal(exit, 0, logged.join(' | '));
    for (const name of ['alpha.md', 'beta.md']) {
      assert.match(
        fs.readFileSync(path.join(vaultDir, name), 'utf8'),
        /palee_id: T-/,
        `${name} must receive a minted id — undefined/null is "not adopted yet"`
      );
    }
  });

  test('batch-conflict paths escape newlines and terminal control characters', () => {
    const rendered = formatDiagnosticPath('notes/\nspoof.md\x1b[31m');
    assert.equal(rendered, '"notes/\\nspoof.md\\u001b[31m"');
    assert.equal(rendered.includes('\n'), false);
    assert.equal(rendered.includes('\x1b'), false);
  });
});
