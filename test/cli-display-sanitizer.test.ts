import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCommand } from '../src/cli/plan';
import { nextCommand } from '../src/cli/next';
import { sessionCommand } from '../src/cli/session';
import { saveConfig } from '../src/cli/config';
import { sanitizeForDisplay } from '../src/cli/display-safety';

/**
 * A cloned or shared vault can carry ANSI/OSC escape sequences in a note's
 * frontmatter `title`, and the CLI interpolated it straight into terminal
 * output (#565 P2-06). An escape there can recolor or hide warnings, retitle
 * the window, or set the clipboard via OSC 52; the provider boundary already
 * stripped control characters from its own text, and the display layer did not.
 *
 * The seed title is an OSC 52 clipboard write followed by BEL: the sequence a
 * terminal acts on and a human cannot see.
 */
const ESC = '\u001b';
const BEL = '\u0007';
const SEED_TITLE = `Disk${ESC}]52;c;cGF3bg==${BEL}`;
const VISIBLE_TITLE = 'Disk]52;c;cGF3bg==';
const SEED_ID = `T-esc${ESC}${BEL}`;
// The identifier is interpolated beside the title at every one of these sinks
// and is equally vault-controlled: the loader accepts any non-empty string.
// With the control bytes removed the id closes right after `T-esc`; with them
// present this exact parenthesised form cannot appear.
const VISIBLE_ID = '(T-esc)';

describe('vault-derived titles are sanitised at the display boundary (#565 P2-06)', () => {
  let tmpDir: string;
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  let prevPaleeJson: string | undefined;
  let loggedOutputs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    prevConfigDir = process.env.PALEE_CONFIG_DIR;
    prevPaleeJson = process.env.PALEE_JSON;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palee-display-'));
    tmpConfigDir = path.join(tmpDir, '.config');
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    process.env.PALEE_CONFIG_DIR = tmpConfigDir;
    delete process.env.PALEE_JSON;
    saveConfig({ vaultPath: tmpDir });

    // The escape has to survive YAML, so it is written as a double-quoted
    // scalar with hex escapes rather than as a raw control byte.
    fs.writeFileSync(
      path.join(tmpDir, 'escape.md'),
      `---
palee_schema: 1
palee_id: "T-esc\\x1b\\a"
title: "Disk\\x1b]52;c;cGF3bg==\\a"
difficulty: beginner
topic_mastery: 0
due_at: 2020-01-01
depends_on: []
---
# Body
`,
      'utf8'
    );

    // A dangling prerequisite is printed as `waiting on <ids>`, so its id must
    // be sanitised too.
    fs.writeFileSync(
      path.join(tmpDir, 'blocked.md'),
      `---
palee_schema: 1
palee_id: T-blocked
title: "Blocked child"
difficulty: beginner
topic_mastery: 0
due_at: 2020-01-01
depends_on: ["T-missing\\x1b\\a"]
---
# Body
`,
      'utf8'
    );

    loggedOutputs = [];
    console.log = (...args: unknown[]) => {
      loggedOutputs.push(args.map((a) => String(a)).join(' '));
    };
    console.error = console.log;
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
    if (prevConfigDir !== undefined) process.env.PALEE_CONFIG_DIR = prevConfigDir;
    else delete process.env.PALEE_CONFIG_DIR;
    if (prevPaleeJson !== undefined) process.env.PALEE_JSON = prevPaleeJson;
    else delete process.env.PALEE_JSON;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the predicate strips C0/C1/DEL and keeps Unicode text intact', () => {
    assert.strictEqual(sanitizeForDisplay(`a${ESC}[31mred${ESC}[0m`), 'a[31mred[0m');
    assert.strictEqual(sanitizeForDisplay(`x${BEL}y`), 'xy');
    assert.strictEqual(sanitizeForDisplay('del\u007fhere'), 'delhere');
    assert.strictEqual(sanitizeForDisplay('c1\u009b2J'), 'c12J');
    // Accents and ZWJ emoji sequences are text, not terminal commands.
    assert.strictEqual(sanitizeForDisplay('Café'), 'Café');
    assert.strictEqual(sanitizeForDisplay('👨\u200d👩\u200d👧'), '👨\u200d👩\u200d👧');
    assert.strictEqual(sanitizeForDisplay('plain title'), 'plain title');
    // Whitespace controls become a space rather than joining words.
    assert.strictEqual(sanitizeForDisplay('Line one\nLine two'), 'Line one Line two');
    assert.strictEqual(sanitizeForDisplay('Chapter\t1'), 'Chapter 1');
    // Bidi overrides reorder a line without being Cc.
    assert.strictEqual(sanitizeForDisplay('safe\u202Eevil'), 'safeevil');
  });

  test('plan and next print the visible title and no escape byte', async () => {
    await planCommand({});
    assert.ok(loggedOutputs.length > 0, 'plan printed nothing');
    const planOutput = loggedOutputs.join('\n');
    assert.ok(!planOutput.includes(ESC), 'plan output must not carry ESC');
    assert.ok(!planOutput.includes(BEL), 'plan output must not carry BEL');
    assert.ok(planOutput.includes(VISIBLE_TITLE), `plan must print the visible title:\n${planOutput}`);
    assert.ok(planOutput.includes(VISIBLE_ID), `plan must print the visible identifier:\n${planOutput}`);

    loggedOutputs = [];
    await nextCommand({});
    const nextOutput = loggedOutputs.join('\n');
    assert.ok(nextOutput.length > 0, 'next printed nothing');
    assert.ok(!nextOutput.includes(ESC), 'next output must not carry ESC');
    assert.ok(!nextOutput.includes(BEL), 'next output must not carry BEL');
    assert.ok(nextOutput.includes(VISIBLE_TITLE), `next must print the visible title:\n${nextOutput}`);
  });

  test('--json keeps the stored value: the escaping is the wire format\'s job', async () => {
    loggedOutputs = [];
    await planCommand({ json: true });
    const raw = loggedOutputs[loggedOutputs.length - 1];
    assert.ok(raw, 'plan --json printed nothing');
    // No literal control byte reaches the wire either: JSON.stringify escapes it.
    assert.ok(!raw.includes(ESC), 'the JSON payload must not carry a literal ESC');
    const parsed = JSON.parse(raw) as { reviews_due: Array<{ title: string }> };
    assert.strictEqual(
      parsed.reviews_due[0]?.title,
      SEED_TITLE,
      'machine output carries the stored title, not the rendered one'
    );
  });

  test('plan prints cycle identifiers sanitised too', async () => {
    // A cycle is reported as `ids.join(' → ')`, a path the title/id lines do not
    // cover; both ids carry the same OSC 52 sequence.
    fs.writeFileSync(
      path.join(tmpDir, 'cycle-a.md'),
      `---
palee_schema: 1
palee_id: "T-cyc-a\\x1b\\a"
title: CycleA
difficulty: beginner
topic_mastery: 0
depends_on: ["T-cyc-b\\x1b\\a"]
---
# Body
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'cycle-b.md'),
      `---
palee_schema: 1
palee_id: "T-cyc-b\\x1b\\a"
title: CycleB
difficulty: beginner
topic_mastery: 0
depends_on: ["T-cyc-a\\x1b\\a"]
---
# Body
`,
      'utf8'
    );

    await planCommand({});
    const output = loggedOutputs.join('\n');
    assert.match(output, /Dependency cycle quarantined/);
    assert.ok(!output.includes(ESC), 'the cycle line must not carry ESC');
    assert.ok(!output.includes(BEL), 'the cycle line must not carry BEL');
    assert.match(output, /Dependency cycle quarantined: T-cyc-a → T-cyc-b/);
  });

  test('session start prints the active topic sanitised', async () => {
    await sessionCommand('start', { topic: SEED_ID });
    const output = loggedOutputs.join('\n');
    assert.match(output, /Session Started/);
    assert.ok(!output.includes(ESC), 'the session banner must not carry ESC');
    assert.ok(!output.includes(BEL), 'the session banner must not carry BEL');
    assert.match(output, /Active Topic: T-esc/);
  });
});
