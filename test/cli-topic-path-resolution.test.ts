import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewCommand } from '../src/cli/review';
import { assessCommand } from '../src/cli/assess';
import { progressCommand } from '../src/cli/progress';
import { sessionCommand } from '../src/cli/session';
import { loadTopics, parseFrontmatter } from '../src/storage';
import { resolveTopicQuery } from '../src/cli/topic-query';

/**
 * #313 — `next`, `plan` and `adopt` display a topic's vault path, so the learner has
 * been handed an identifier the same tool then refused. `resolveTopicQuery` now
 * accepts that exact path, but only after the ID/title lookup found nothing.
 */
async function runInTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-topic-path-'));
  const vaultPath = path.join(tempDir, 'vault');
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(vaultPath, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({ vaultPath }, null, 2));

  const origConfigDir = process.env.PALEE_CONFIG_DIR;
  const origExitCode = process.exitCode;
  process.env.PALEE_CONFIG_DIR = tempDir;
  try {
    await fn(vaultPath);
  } finally {
    if (origConfigDir !== undefined) process.env.PALEE_CONFIG_DIR = origConfigDir;
    else delete process.env.PALEE_CONFIG_DIR;
    process.exitCode = origExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** A note with valid SM-2 state, so a review never trips the corrupt-state guard. */
function note(title: string, id: string): string {
  return [
    '---',
    'palee_schema: 1',
    `palee_id: ${id}`,
    `title: ${title}`,
    'depends_on: []',
    'topic_mastery: 0',
    'ease_factor: 2.5',
    'interval_days: 1',
    'repetition: 0',
    'lapses: 0',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

/** Captures stdout/stderr while `fn` runs. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return chunks.join('\n');
}

describe('topic path resolution (#313)', () => {
  test('review accepts the exact vault path next prints for the same topic', async () => {
    await runInTempVault({ 'w/one.md': note('Alpha Basics', 'T-alpha') }, async (vaultPath) => {
      const before = loadTopics(vaultPath);
      // The string `next`/`plan` show is `LoadedTopic.path`, so that is the string
      // fed back here — nothing else in this test names the topic.
      const displayed = before[0].path;
      assert.strictEqual(displayed, 'w/one.md');

      const output = await captureOutput(() => reviewCommand(displayed, '5'));
      assert.match(output, /Review recorded for Alpha Basics/, output);
      assert.strictEqual(process.exitCode ?? 0, 0, output);

      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, 'w', 'one.md'), 'utf8')
      );
      assert.strictEqual(frontmatter?.repetition, 1, 'the note at that path was the one written');
    });
  });

  test('assess, progress and session all accept the same displayed path', async () => {
    await runInTempVault(
      { 'deep/nested/topic.md': note('Nested Topic', 'T-nested'), 'other.md': note('Other', 'T-other') },
      async (vaultPath) => {
        const displayed = 'deep/nested/topic.md';

        const assessOut = await captureOutput(() => assessCommand(displayed, { conceptual: '0.8' }));
        assert.match(assessOut, /Assessment recorded for Nested Topic \(T-nested\)/, assessOut);
        assert.strictEqual(process.exitCode ?? 0, 0, assessOut);

        process.exitCode = undefined;
        const progressOut = await captureOutput(() => progressCommand({ topic: displayed }));
        assert.match(progressOut, /Progress for: Nested Topic/, progressOut);
        assert.strictEqual(process.exitCode ?? 0, 0, progressOut);

        process.exitCode = undefined;
        const sessionOut = await captureOutput(() => sessionCommand('draft', { topic: displayed }));
        assert.match(sessionOut, /Draft checkpoint created/, sessionOut);
        assert.strictEqual(process.exitCode ?? 0, 0, sessionOut);
        const drafts = fs.readdirSync(path.join(vaultPath, '.palee', 'sessions'));
        const draft = drafts.find((f) => f.startsWith('DRAFT-S-'));
        assert.ok(draft, 'the path query must produce a checkpoint');
        const { frontmatter } = parseFrontmatter(
          fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', draft!), 'utf8')
        );
        assert.strictEqual(
          frontmatter?.topic_id,
          'T-nested',
          'the session records the resolved palee_id, never the path'
        );
      }
    );
  });

  test('an exact path match never shadows an id or title that already matched', async () => {
    // `notes/keep.md` is the path of the SECOND note; the first note's title merely
    // contains that string. ID/title precedence means the query resolves to the note
    // the lookup already answered for — the path branch is a last resort, so adding
    // it cannot move an existing resolution.
    const files = {
      'a.md': note('Everything about notes/keep.md', 'T-keeper'),
      'notes/keep.md': note('Kept Separate', 'T-kept'),
    };
    await runInTempVault(files, async (vaultPath) => {
      const loaded = loadTopics(vaultPath);
      const resolution = resolveTopicQuery(loaded, 'notes/keep.md');
      assert.strictEqual(resolution.kind === 'single' ? resolution.topic.palee_id : resolution.kind, 'T-keeper');

      const keeperBefore = fs.readFileSync(path.join(vaultPath, 'a.md'), 'utf8');
      const keptBefore = fs.readFileSync(path.join(vaultPath, 'notes', 'keep.md'), 'utf8');
      const output = await captureOutput(() => reviewCommand('notes/keep.md', '5'));
      assert.match(output, /Review recorded for Everything about notes\/keep\.md/, output);
      assert.strictEqual(process.exitCode ?? 0, 0, output);
      assert.notStrictEqual(fs.readFileSync(path.join(vaultPath, 'a.md'), 'utf8'), keeperBefore);
      assert.strictEqual(fs.readFileSync(path.join(vaultPath, 'notes', 'keep.md'), 'utf8'), keptBefore);
    });
  });

  test('the path branch is exact, so a bare basename or a substring stays refused', async () => {
    await runInTempVault({ 'w/one.md': note('Alpha Basics', 'T-alpha') }, async () => {
      // Accepting `one.md` (or `w/one`) would turn every loose fragment into a
      // candidate hunt; the displayed string is the whole path, so that is what
      // resolves.
      for (const query of ['one.md', 'w/one', 'notes/w/one.md']) {
        const output = await captureOutput(() => reviewCommand(query, '5'));
        assert.match(output, /No topic found matching/, `${query}: ${output}`);
        assert.strictEqual(process.exitCode, 2, `${query}: ${output}`);
      }
    });
  });

  test('a path no note lives at is still refused at exit 2', async () => {
    await runInTempVault({ 'w/one.md': note('Alpha Basics', 'T-alpha') }, async () => {
      const output = await captureOutput(() => reviewCommand('w/two.md', '5'));
      assert.match(output, /No topic found matching "w\/two\.md"/, output);
      assert.strictEqual(process.exitCode, 2, output);
    });
  });

  test('path case folding follows the platform, not the query spelling', async () => {
    await runInTempVault({ 'w/one.md': note('Alpha Basics', 'T-alpha') }, async (vaultPath) => {
      // The resolver's own contract first: the displayed path resolves on any platform.
      assert.strictEqual(resolveTopicQuery(loadTopics(vaultPath), 'w/one.md').kind, 'single');

      const wrongCase = await captureOutput(() => reviewCommand('W/One.md', '5'));
      if (process.platform === 'win32') {
        // The filesystem itself ignores case here, so the CLI must too — the same
        // folding `adopt`'s wikilink resolution applies (INV-48).
        assert.match(wrongCase, /Review recorded for Alpha Basics/, wrongCase);
        assert.strictEqual(process.exitCode ?? 0, 0, wrongCase);
      } else {
        assert.match(wrongCase, /No topic found matching/, wrongCase);
        assert.strictEqual(process.exitCode, 2, wrongCase);
      }
    });
  });

  test('a backslash query resolves the POSIX displayed path on every platform', async () => {
    // `relativeVaultPath` rewrites `\` to `/` when it builds `LoadedTopic.path`, so a
    // stored path never contains a backslash on any OS. Folding the query the same way
    // is therefore symmetric, not a Windows-only concession: a learner copying
    // `w\one.md` out of `session` output (which prints native separators) gets the note
    // `next` called `w/one.md`.
    await runInTempVault({ 'w/one.md': note('Alpha Basics', 'T-alpha') }, async () => {
      const output = await captureOutput(() => reviewCommand('w\\one.md', '5'));
      assert.match(output, /Review recorded for Alpha Basics/, output);
      assert.strictEqual(process.exitCode ?? 0, 0, output);
    });
  });
});
