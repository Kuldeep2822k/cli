import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import roadmapCommand from '../src/cli/roadmap';
import { saveConfig } from '../src/cli/config';

/**
 * Issue #267 / #565 — a note whose *bytes* cannot be opened is a skipped note too.
 *
 * `palee roadmap --from` cycle-checks the declared graph, then predicts which notes
 * the write loop will skip and re-checks the graph with each skipped note
 * contributing the `depends_on` it already holds. That prediction asked only
 * `lstat` and `realpath`: a regular file inside the vault passed it, and the read
 * failure behind the pass — the one the loop hits in `readBoundNote` and isolates
 * as `Skipped <id>` — left the note out of the skip set entirely. So the import
 * wrote the dependent, the unreadable note kept its stored backward hop, and the
 * command exited `1` over a vault `palee validate` reports as cyclic: the state the
 * documentation promises means exit `3` and zero writes.
 *
 * The refusal is injected through `fs.openSync` rather than `chmod` so the fixture
 * behaves the same on every platform this CLI ships to. It also reproduces the one
 * divergence where the skip changes the verdict: `loadTopics` reads by path and so
 * still knows the edges the note stores, while the write path's descriptor-bound
 * read is refused. A note no reader can open holds no edges in any command's graph,
 * so modeling it could not close a loop the validator had not already seen.
 */
describe('a roadmap note whose bytes cannot be read is a skipped note too', () => {
  let tempDir: string;
  let prevConfigDir: string | undefined;

  before(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'palee-roadmap-unreadable-')));
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    process.env.PALEE_CONFIG_DIR = tempDir;
  });

  after(() => {
    process.exitCode = undefined;
    if (prevConfigDir === undefined) delete process.env.PALEE_CONFIG_DIR;
    else process.env.PALEE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    // A refusal sets `process.exitCode` in this process, and the runner inherits
    // it at exit — a suite that proved its case would still report that code.
    process.exitCode = undefined;
  });

  /** An ordinary adopted note, far below the read cap. */
  function note(id: string, title: string, storedDeps: string[]): string {
    return [
      '---',
      'palee_schema: 1',
      `palee_id: ${id}`,
      `title: ${title}`,
      ...(storedDeps.length > 0 ? ['depends_on:', ...storedDeps.map((dep) => `  - ${dep}`)] : ['depends_on: []']),
      'topic_mastery: 0',
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n');
  }

  /**
   * Builds a vault holding T-alpha and T-bravo plus the roadmap that declares
   * `T-alpha → T-bravo` and an empty list for T-bravo. Declared, that is a chain;
   * written with T-bravo skipped, T-bravo keeps `storedDeps` and the graph is
   * whatever those hops say.
   *
   * @param name - This case's own directory, so no two cases share a vault
   * @param storedDeps - The `depends_on` T-bravo carries on disk
   */
  function makeVault(name: string, storedDeps: string[]): { vault: string; yaml: string } {
    const dir = path.join(tempDir, name);
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vault, 'n'), { recursive: true });
    saveConfig({ vaultPath: vault });
    fs.writeFileSync(path.join(vault, 'n', 'alpha.md'), note('T-alpha', 'Alpha', []), 'utf8');
    fs.writeFileSync(path.join(vault, 'n', 'bravo.md'), note('T-bravo', 'Bravo', storedDeps), 'utf8');

    const yaml = path.join(dir, 'roadmap.yaml');
    fs.writeFileSync(
      yaml,
      [
        'topics:',
        '  - id: T-alpha',
        '    title: Alpha Rewritten',
        '    path: n/alpha.md',
        '    depends_on: [T-bravo]',
        '  - id: T-bravo',
        '    title: Bravo',
        '    path: n/bravo.md',
        '    depends_on: []',
        '',
      ].join('\n'),
      'utf8'
    );
    return { vault, yaml };
  }

  /**
   * Runs `run` with the descriptor read of `noteName` refused.
   *
   * @remarks
   * `readBoundNote` is the only reader that opens a note by descriptor with `'r'`
   * (`src/cli/roadmap.ts`), so the refusal lands on the write path and nowhere else:
   * the loader's path-based read still succeeds, and `atomicWrite` opens `'w'` temp
   * files plus a directory handle, neither of which matches the name.
   */
  async function withRefusedRead(noteName: string, run: () => Promise<void>): Promise<void> {
    const origOpenSync = fs.openSync;
    (fs as any).openSync = (p: unknown, flags?: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.basename(p) === noteName && flags === 'r') {
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
      }
      return (origOpenSync as (...a: unknown[]) => unknown).apply(fs, [p, flags, ...rest]);
    };
    try {
      await run();
    } finally {
      (fs as any).openSync = origOpenSync;
    }
  }

  /** Runs `run` with `console.log` and `console.error` collected into one transcript. */
  async function capture(run: () => Promise<void>): Promise<string> {
    const origLog = console.log;
    const origError = console.error;
    let transcript = '';
    console.log = (...args: unknown[]) => { transcript += args.map((a) => String(a)).join(' ') + '\n'; };
    console.error = (...args: unknown[]) => { transcript += args.map((a) => String(a)).join(' ') + '\n'; };
    try {
      await run();
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    return transcript;
  }

  test('a note whose bytes cannot be opened is refused before the first write', async () => {
    const { vault, yaml } = makeVault('closes-a-loop', ['T-alpha']);
    const alphaPath = path.join(vault, 'n', 'alpha.md');
    const bravoPath = path.join(vault, 'n', 'bravo.md');
    const alphaBefore = fs.readFileSync(alphaPath, 'utf8');
    const bravoBefore = fs.readFileSync(bravoPath, 'utf8');

    let code: number | undefined;
    const transcript = await capture(() =>
      withRefusedRead('bravo.md', async () => {
        await roadmapCommand({ from: yaml, yes: true });
        code = Number(process.exitCode);
      })
    );

    assert.strictEqual(
      code,
      3,
      `a skip that invalidates the cleared verdict is a validation refusal: ${transcript}`
    );
    assert.match(transcript, /refusing to import/, 'the refusal has to say what it is');
    assert.match(
      transcript,
      /T-bravo \(its content could not be read\)/,
      'the reason is the read, not the target metadata — the case the check did not model'
    );
    assert.match(
      transcript,
      /Cycle the skipped notes would leave behind: .*T-alpha.*T-bravo/,
      `the cycle that would have landed must be printed: ${transcript}`
    );
    assert.strictEqual(
      fs.readFileSync(alphaPath, 'utf8'),
      alphaBefore,
      'the dependent note must not be written with an edge the vault will not get'
    );
    assert.strictEqual(fs.readFileSync(bravoPath, 'utf8'), bravoBefore, 'and the skipped note keeps its bytes');
  });

  test('a dry run refuses the unreadable-bytes plan its own import refuses', async () => {
    const { vault, yaml } = makeVault('closes-a-loop-dry', ['T-alpha']);
    const alphaBefore = fs.readFileSync(path.join(vault, 'n', 'alpha.md'), 'utf8');

    let code: number | undefined;
    const transcript = await capture(() =>
      withRefusedRead('bravo.md', async () => {
        await roadmapCommand({ from: yaml, dryRun: true });
        code = Number(process.exitCode);
      })
    );

    assert.strictEqual(code, 3, `the dry run must predict the refusal, not the plan: ${transcript}`);
    assert.match(transcript, /refusing to import/, 'with the same refusal the import reports');
    assert.doesNotMatch(transcript, /Dry-run complete/, 'and no plan to approve for an import that cannot proceed');
    assert.strictEqual(fs.readFileSync(path.join(vault, 'n', 'alpha.md'), 'utf8'), alphaBefore, 'a dry run writes nothing');
  });

  // The boundary of the fix: an unreadable note is added to the skip set, not made
  // fatal. Refusing every skipped note would throw away a partial import the learner
  // can act on — the rule #267 rejected, and the reason this case keeps exit `1`.
  test('unreadable bytes that close no loop still cost only their own topic', async () => {
    const { vault, yaml } = makeVault('closes-nothing', []);
    const alphaPath = path.join(vault, 'n', 'alpha.md');
    const bravoPath = path.join(vault, 'n', 'bravo.md');
    const bravoBefore = fs.readFileSync(bravoPath, 'utf8');

    let code: number | undefined;
    const transcript = await capture(() =>
      withRefusedRead('bravo.md', async () => {
        await roadmapCommand({ from: yaml, yes: true });
        code = Number(process.exitCode);
      })
    );

    assert.strictEqual(code, 1, `a partial import still exits 1: ${transcript}`);
    assert.match(transcript, /Skipped T-bravo/, 'the skip is still reported per topic');
    assert.match(
      fs.readFileSync(alphaPath, 'utf8'),
      /Alpha Rewritten/,
      'the topic whose bytes can be read is still written'
    );
    assert.strictEqual(fs.readFileSync(bravoPath, 'utf8'), bravoBefore, 'the unreadable note is left byte-identical');
  });
});
