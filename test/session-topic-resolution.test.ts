import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sessionCommand } from '../src/cli/session';
import { reviewCommand } from '../src/cli/review';
import { parseFrontmatter } from '../src/storage';

/**
 * #302 — `session` resolves `--topic` against the vault instead of accepting it
 * verbatim.
 *
 * Before the fix, `resolveSessionTopic()` returned any non-empty trimmed argument
 * as the session topic, so `session start/draft/end --topic T-does-not-exist-999`
 * exited 0 and wrote real files under `.palee/sessions/`, while `review` rejected
 * the identical string with exit 2. These tests pin the fail-closed behaviour and
 * the exit code (2 = usage, never a new code) plus the one deliberate carve-out:
 * a topic inherited from `hot.md` is not re-resolved.
 */
async function runInTempVault(
  files: Record<string, string>,
  fn: (vaultPath: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-session-topic-'));
  const vaultPath = path.join(tempDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
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

/** A minimal adopted note. */
function note(id: string, title: string): string {
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

/** Captures stdout and stderr while `fn` runs. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const log = console.log;
  const err = console.error;
  const warn = console.warn;
  console.log = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  console.warn = (...a: unknown[]): void => {
    chunks.push(a.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
  }
  return chunks.join('\n');
}

/** Every file under `.palee/sessions/`, sorted; empty when the directory was never made. */
function sessionFiles(vaultPath: string): string[] {
  const dir = path.join(vaultPath, '.palee', 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

const VAULT_FILES = {
  'k8s.md': note('T-kubernetes-basics', 'Kubernetes Basics'),
  'net.md': note('T-networking', 'Networking Primer'),
};

describe('session --topic resolution (#302)', () => {
  test('session start refuses a phantom --topic at exit 2 and writes nothing', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const output = await captureOutput(() =>
        sessionCommand('start', { topic: 'T-does-not-exist-999' })
      );

      assert.match(output, /No topic found matching "T-does-not-exist-999"/, output);
      assert.strictEqual(process.exitCode, 2, `expected exit 2, output was:\n${output}`);
      assert.deepStrictEqual(sessionFiles(vaultPath), [], 'no session or draft file may be written');
      assert.ok(
        !fs.existsSync(path.join(vaultPath, '.palee', 'hot.md')),
        'the phantom must not even become the working memory topic'
      );
    });
  });

  test('session draft refuses a phantom --topic at exit 2 and leaves no checkpoint', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const output = await captureOutput(() =>
        sessionCommand('draft', { topic: 'T-does-not-exist-999' })
      );

      assert.match(output, /No topic found matching "T-does-not-exist-999"/, output);
      assert.strictEqual(process.exitCode, 2, output);
      assert.deepStrictEqual(sessionFiles(vaultPath), []);
    });
  });

  test('session end refuses a phantom --topic at exit 2 and writes no session note', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const output = await captureOutput(() =>
        sessionCommand('end', { topic: 'T-does-not-exist-999' })
      );

      assert.match(output, /No topic found matching "T-does-not-exist-999"/, output);
      assert.strictEqual(process.exitCode, 2, output);
      assert.deepStrictEqual(sessionFiles(vaultPath), []);
      assert.ok(
        !fs.existsSync(path.join(vaultPath, '.palee', 'index.md')),
        'the session index must not gain a row for a topic that does not exist'
      );
    });
  });

  test('session gives the identical refusal review gives for the same string', async () => {
    // The asymmetry was the bug: one command accepted the ID, the other rejected it.
    // Both go through `resolveTopicQuery` now, so the complaint is the same sentence.
    const query = 'T-does-not-exist-999';
    let sessionOutput = '';
    let reviewOutput = '';
    await runInTempVault(VAULT_FILES, async () => {
      sessionOutput = await captureOutput(() => sessionCommand('draft', { topic: query }));
      const sessionExit = process.exitCode;
      process.exitCode = undefined;
      reviewOutput = await captureOutput(() => reviewCommand(query, '3'));
      assert.strictEqual(sessionExit, 2);
      assert.strictEqual(process.exitCode, 2);
    });

    const sessionLine = sessionOutput.split('\n').find((l) => l.includes(query)) ?? '';
    const reviewLine = reviewOutput.split('\n').find((l) => l.includes(query)) ?? '';
    assert.match(sessionLine, /No topic found matching/);
    assert.strictEqual(
      sessionLine.replace('Error: ', '').trim(),
      reviewLine.replace('Error: ', '').trim(),
      'session and review must reject the string the same way'
    );
  });

  test('an ambiguous --topic exits 2 and lists every candidate', async () => {
    const files = {
      'a.md': note('T-recursion-basics', 'Recursion Basics'),
      'b.md': note('T-recursion-depth', 'Recursion Depth'),
    };
    await runInTempVault(files, async (vaultPath) => {
      const output = await captureOutput(() => sessionCommand('draft', { topic: 'T-recursion' }));

      assert.match(output, /Multiple topics match "T-recursion":/, output);
      assert.match(output, /- T-recursion-basics: Recursion Basics/, output);
      assert.match(output, /- T-recursion-depth: Recursion Depth/, output);
      assert.match(output, /more specific query/, output);
      assert.strictEqual(process.exitCode, 2, output);
      assert.deepStrictEqual(sessionFiles(vaultPath), []);
    });
  });

  test('a real --topic still starts, drafts and ends at exit 0', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const startOutput = await captureOutput(() =>
        sessionCommand('start', { topic: 'T-kubernetes-basics' })
      );
      assert.strictEqual(process.exitCode, undefined, startOutput);
      assert.match(startOutput, /Active Topic: T-kubernetes-basics/, startOutput);

      process.exitCode = undefined;
      const draftOutput = await captureOutput(() =>
        sessionCommand('draft', { topic: 'T-kubernetes-basics' })
      );
      assert.strictEqual(process.exitCode, undefined, draftOutput);
      assert.strictEqual(sessionFiles(vaultPath).filter((f) => f.startsWith('DRAFT-S-')).length, 1);

      process.exitCode = undefined;
      const endOutput = await captureOutput(() =>
        sessionCommand('end', { topic: 'T-kubernetes-basics' })
      );
      assert.strictEqual(process.exitCode, undefined, endOutput);
      assert.match(endOutput, /Session recorded/, endOutput);

      const confirmed = sessionFiles(vaultPath).filter((f) => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', confirmed[0]), 'utf8')
      );
      assert.strictEqual(frontmatter?.topic_id, 'T-kubernetes-basics');
    });
  });

  test('a title query records the canonical palee_id, not the words the learner typed', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const output = await captureOutput(() => sessionCommand('start', { topic: 'Kubernetes Basics' }));
      assert.strictEqual(process.exitCode, undefined, output);

      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'hot.md'), 'utf8')
      );
      assert.strictEqual(
        frontmatter?.active_topic,
        'T-kubernetes-basics',
        'hot memory must carry the resolved ID, never the raw query'
      );

      process.exitCode = undefined;
      const draftOut = await captureOutput(() => sessionCommand('draft', { topic: 'kubernetes' }));
      assert.strictEqual(process.exitCode, undefined, draftOut);
      const draft = sessionFiles(vaultPath).find((f) => f.startsWith('DRAFT-S-'));
      assert.ok(draft, 'the substring query must produce a checkpoint');
      const { frontmatter: draftFm } = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', draft!), 'utf8')
      );
      assert.strictEqual(draftFm?.topic_id, 'T-kubernetes-basics');
    });
  });

  test('--json reports the refusal as a machine-readable error at exit 2', async () => {
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const output = await captureOutput(() =>
        sessionCommand('draft', { topic: 'T-does-not-exist-999', json: true })
      );
      assert.strictEqual(process.exitCode, 2, output);

      const payload = JSON.parse(output);
      assert.match(payload.error, /No topic found matching "T-does-not-exist-999"/);
      assert.deepStrictEqual(sessionFiles(vaultPath), []);
    });
  });

  test('--topic "(none)" keeps meaning "no topic" rather than a lookup', async () => {
    await runInTempVault(VAULT_FILES, async () => {
      const output = await captureOutput(() => sessionCommand('draft', { topic: '(none)' }));
      assert.match(output, /Topic required/, output);
      assert.strictEqual(process.exitCode, 2, output);
      assert.ok(
        !output.includes('No topic found matching'),
        'the sentinel is not a query, so it must not be reported as a phantom ID'
      );
    });
  });

  test('a topic inherited from hot.md is not re-resolved, so a vanished note still ends', async () => {
    // Deliberate carve-out: `hot.md` is canonical. Refusing here would strand a real
    // session because the note was renamed or deleted mid-flight — losing recorded
    // work is worse than recording it against an ID the learner was shown.
    await runInTempVault(VAULT_FILES, async (vaultPath) => {
      const startOutput = await captureOutput(() =>
        sessionCommand('start', { topic: 'T-kubernetes-basics' })
      );
      assert.strictEqual(process.exitCode, undefined, startOutput);

      fs.unlinkSync(path.join(vaultPath, 'k8s.md'));

      process.exitCode = undefined;
      const endOutput = await captureOutput(() => sessionCommand('end'));
      assert.strictEqual(process.exitCode, undefined, endOutput);
      const confirmed = sessionFiles(vaultPath).filter((f) => f.startsWith('S-'));
      assert.strictEqual(confirmed.length, 1, endOutput);
      const { frontmatter } = parseFrontmatter(
        fs.readFileSync(path.join(vaultPath, '.palee', 'sessions', confirmed[0]), 'utf8')
      );
      assert.strictEqual(frontmatter?.topic_id, 'T-kubernetes-basics');
    });
  });
});
