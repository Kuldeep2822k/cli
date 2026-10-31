import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import adoptCommand from '../src/cli/adopt';
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
    const realRead = fs.readFileSync;
    const reads = new Map<string, number>();
    // Basename-keyed: the CLI canonicalises the vault, so on macOS these paths
    // arrive as `/private/var/...` while the suite's are `/var/...`.
    (fs as any).readFileSync = (...args: unknown[]): unknown => {
      if (typeof args[0] === 'string') {
        const name = path.basename(args[0]);
        const tampered = tamperedByName.get(name);
        if (tampered !== undefined) {
          const count = (reads.get(name) ?? 0) + 1;
          reads.set(name, count);
          if (count >= tamperFromRead) {
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
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await adoptCommand(undefined, options);
    } finally {
      console.error = realErr;
      (fs as any).readFileSync = realRead;
    }
    const exit = process.exitCode;
    process.exitCode = priorExit;

    // The stub must have actually fired, or this test proves nothing: if the
    // re-read were never intercepted, the batch would look like a plain success.
    for (const name of tamperedByName.keys()) {
      assert.ok(
        (reads.get(name) ?? 0) >= tamperFromRead,
        `expected ${tamperFromRead} read(s) of ${name}, saw ${reads.get(name) ?? 0}`
      );
    }
    // Refused before a single write: every note still holds the scan's bytes.
    for (const fixture of fixtures) {
      assert.equal(
        fs.readFileSync(path.join(vaultDir, fixture.name), 'utf8'),
        fixture.content,
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
      logged.some((l) => /alpha\.md \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });

  test('a typed id is identity too: a non-string palee_id is refused, never overwritten', async () => {
    const logged: string[] = [];
    const exit = await runBatchAgainst(
      [
        { name: 'alpha.md', content: PLAIN, tampered: concurrentlyAdopted('palee_id: 12345') },
        { name: 'beta.md', content: BETA },
      ],
      logged
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /alpha\.md \(a palee_id is now declared\)/.test(l)),
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
      logged.some((l) => /alpha\.md \(the frontmatter opener is unclosed\)/.test(l)),
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
    assert.equal(logged.filter((l) => /• n\d\.md \(/.test(l)).length, 5, logged.join(' | '));
    assert.ok(logged.some((l) => /… and 1 more/.test(l)), logged.join(' | '));
  });

  test('under --auto-chain, a planned edge is never written against a moved identity', async () => {
    const logged: string[] = [];
    // Distinct paths, and the third read: auto-chain calls loadTopics() before
    // Phase 1, which reads each note one more time (after the scan's read). Read
    // 3 is the pre-write re-read, so the id lands after planning, not during it.
    const exit = await runBatchAgainst(
      [
        { name: 'gamma.md', content: PLAIN, tampered: concurrentlyAdopted('palee_id: T-other') },
        { name: 'delta.md', content: BETA },
      ],
      logged,
      { all: true, yes: true, autoChain: true },
      3
    );

    assert.equal(exit, 4, logged.join(' | '));
    assert.ok(
      logged.some((l) => /gamma\.md \(a palee_id is now declared\)/.test(l)),
      logged.join(' | ')
    );
  });
});
