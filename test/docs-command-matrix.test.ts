import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExitCode } from '../src/cli/exit-codes';
import { PALEE_DIST_ARGV, withoutCoverage, CLI_SPAWN_TIMEOUT_MS } from './palee-cli';

/**
 * #268's first item: `palee assess` was registered in `bin/palee.ts`, showed in
 * `palee --help`, and appeared nowhere in the exit-code contract — whose own preamble
 * still counted eleven commands. A number in prose is what rots; the command list
 * the built CLI publishes is the fact. These read both and compare, so adding a
 * command without documenting its exit behavior fails here instead of quietly
 * making the page wrong.
 */
const root = path.resolve(__dirname, '..');
const contract = fs.readFileSync(path.join(root, 'docs/02-0-cli-commands.md'), 'utf8');

// The page carries a second `| Command |` table for machine-readable output, so the
// assertion reads the exit-code section alone; a command with a JSON row but no exit
// row is exactly the gap this test exists to catch. The exit table has one row per
// documented (command, exit) pair, so the parser groups rows by command.
const exitSection = contract.slice(
  contract.indexOf('## Exit Code Contract'),
  contract.indexOf('\n## ', contract.indexOf('## Exit Code Contract') + 1)
);

const help = spawnSync(process.execPath, [...PALEE_DIST_ARGV, '--help'], {
  cwd: root,
  env: withoutCoverage(),
  encoding: 'utf8',
  stdio: 'pipe',
  timeout: CLI_SPAWN_TIMEOUT_MS,
});
assert.ifError(help.error);
assert.strictEqual(help.status, 0, help.stderr);
const commandsSection = help.stdout.slice(
  help.stdout.indexOf('\nCommands:'),
  help.stdout.indexOf('\n\nEnvironment:')
);
const registered = [...commandsSection.matchAll(/^\x20{2}([a-z][a-z-]*)\b/gm)]
  .map((m) => m[1])
  .filter((command) => command !== 'help');

interface ExitRow {
  command: string;
  exit: number;
  behavior: string;
}

function parseExitRows(section: string): ExitRow[] {
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line === '| Command | Exit | Behavior |');
  assert.notStrictEqual(headerIndex, -1, 'the per-command matrix has the long-form header');
  assert.match(
    lines[headerIndex + 1] ?? '',
    /^\| :--- \| :---: \| :--- \|$/,
    'the per-command matrix has a separator row'
  );

  const rows: ExitRow[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    // GFM rows may omit the leading pipe. A row is any pipe-bearing line up to
    // the blank line that ends the table; breaking on the first non-pipe line
    // would let a malformed row render while the test skipped it.
    if (trimmed === '' || !trimmed.includes('|')) break;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    assert.strictEqual(cells.length, 3, `malformed exit row (expected 3 cells): ${line}`);
    const commandMatch = /^`palee ([a-z-]+)`$/.exec(cells[0] ?? '');
    assert.ok(commandMatch, `malformed command cell: ${line}`);
    const command = commandMatch[1];
    assert.ok(command, `malformed command cell: ${line}`);
    const exitText = cells[1] ?? '';
    assert.match(exitText, /^\d+$/, `palee ${command} has a non-integer exit: ${exitText}`);
    const behavior = cells[2] ?? '';
    assert.ok(behavior.length > 0, `palee ${command} exit ${exitText} has no behavior text`);
    rows.push({ command, exit: Number(exitText), behavior });
  }

  assert.ok(rows.length > 0, 'the per-command matrix has at least one row');
  return rows;
}

const exitRows = parseExitRows(exitSection);
const documented = [...new Set(exitRows.map((row) => row.command))];

/**
 * Commands named on one `agent.md` line: the first word of each backticked
 * token, with an optional `palee` prefix. Only registered commands come back,
 * so prose about a planned command (`test`/`tutor`) stays prose.
 */
function namedCommands(line: string): string[] {
  return [
    ...new Set(
      [...line.matchAll(/`([^`]+)`/g)]
        .map((match) => (match[1] ?? '').replace(/^palee\s+/i, '').trim().split(/\s+/)[0] ?? '')
        .filter((name) => registered.includes(name))
    ),
  ];
}

describe('Exit-code contract covers every registered command (#268)', () => {
  test('the built CLI exposes a non-empty, duplicate-free command list', () => {
    assert.ok(registered.length >= 2, `expected top-level commands, got ${registered.join(', ')}`);
    assert.strictEqual(new Set(registered).size, registered.length, 'no command is registered twice');
  });

  test('every registered command has a matrix row, and no row invents a command', () => {
    assert.deepStrictEqual(
      [...documented].sort(),
      [...registered].sort(),
      'every `palee --help` command needs at least one matrix row, and the matrix may not invent one'
    );
  });

  test('the prose count of commands matches the built CLI', () => {
    const claimed = /across all (\d+) commands/.exec(contract);
    assert.ok(claimed, 'the contract preamble states how many commands it covers');
    assert.strictEqual(
      Number(claimed[1]),
      registered.length,
      `the page says ${claimed[1]} commands while the built CLI registers ${registered.length}`
    );
  });

  test('the testing guide counts and names exactly the commands the dispatcher registers', () => {
    // #458 corrected these sentences to the then-true 12, and adding `update` made
    // them wrong again with nothing failing — because the guard above reads only
    // `docs/02-0`. A number stated in a second file is the same kind of fact and
    // needs the same command list behind it.
    const guide = fs.readFileSync(
      path.join(root, 'docs/06-2-integration-and-smoke-tests.md'),
      'utf8'
    );

    const registers = /the CLI registers (\d+) top-level commands/.exec(guide);
    assert.ok(registers, 'the testing guide states how many commands the CLI registers');
    assert.strictEqual(
      Number(registers[1]),
      registered.length,
      `docs/06-2 states ${registers[1]} top-level commands while the built CLI registers ${registered.length}`
    );

    const outside = /(\d+) of the (\d+) registered commands \(([^)]*)\)/.exec(guide);
    assert.ok(outside, 'the guide names the commands falling outside the exit-code matrix');
    assert.strictEqual(
      Number(outside[2]),
      registered.length,
      `docs/06-2 states a total of ${outside[2]} while the built CLI registers ${registered.length}`
    );
    const namedList = outside[3];
    assert.ok(namedList !== undefined, 'the parenthetical list of commands is captured');
    const named = namedList
      .split(',')
      .map((entry) => entry.trim().replace(/`/gu, ''))
      .filter(Boolean);
    assert.strictEqual(
      Number(outside[1]),
      named.length,
      `the guide says ${outside[1]} commands are outside the matrix but names ${named.length}`
    );
    assert.strictEqual(new Set(named).size, named.length, 'the parenthetical list names no command twice');

    // The prose's remaining claim — that the eight commands the suite imports
    // are the other half of the partition — is checked against the imports
    // themselves, not against the sentence that asserts it. A name swapped in
    // either place fails here.
    const exitCodes = fs.readFileSync(path.join(root, 'test/cli-exit-codes.test.ts'), 'utf8');
    const imported = new Set(
      [...exitCodes.matchAll(/^import .*?\b([a-z][A-Za-z]*)Command\b/gmu)].map((match) =>
        (match[1] ?? '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      )
    );
    assert.strictEqual(imported.size, 8, 'the exit-code suite imports eight command handlers');
    assert.deepStrictEqual(
      [...named].sort(),
      registered.filter((command): command is string => command !== undefined && !imported.has(command)).sort(),
      'the named list must be exactly the registered commands the exit-code suite does not import'
    );
  });

  test('assess is documented as a command, not only as an engine rule', () => {
    // The specific regression #268 reported: mastery has one writer, and its remedy
    // for a false gate had no documented syntax, options, or exit contract at all.
    assert.ok(documented.includes('assess'), 'the exit-code matrix names palee assess');
    const scheduling = fs.readFileSync(
      path.join(root, 'docs/02-2-review-and-scheduling-commands.md'),
      'utf8'
    );
    assert.match(scheduling, /## \d+\. Four-Pillar Assessment \(`palee assess`\)/);
    assert.match(scheduling, /palee assess <topic> \[--conceptual N\]/);
    assert.match(scheduling, /\| `palee assess` \|/);
  });

  test('a malformed exit row fails instead of disappearing from the matrix', () => {
    const malformed = exitSection.replace(
      '| `palee update` | 5 |',
      '| `palee update` | -1 |'
    );
    assert.notStrictEqual(malformed, exitSection, 'the fixture contains the row to mutate');
    assert.throws(
      () => parseExitRows(malformed),
      /palee update has a non-integer exit: -1/,
      'a negative exit must fail instead of being filtered out'
    );
  });

  test('a row without a leading pipe is still validated', () => {
    const malformed = exitSection.replace(
      '| `palee update` | 5 |',
      '`palee update` | -1 |'
    );
    assert.notStrictEqual(malformed, exitSection, 'the fixture contains the row to mutate');
    assert.throws(
      () => parseExitRows(malformed),
      /palee update has a non-integer exit: -1/,
      'a pipe-delimited row without a leading pipe must not be skipped'
    );
  });

  test('the exit-code numbers and rows match the documented contract', () => {
    // #486: the summary was checked row-by-row but never as a numeric contract:
    // a seventh code, a renumbered column, or a short row all passed. The
    // numbers come from `ExitCode`, the same object the handlers import.
    const codes = Object.values(ExitCode);
    const documentedCodes = [...exitSection.matchAll(/^\| \*\*(\d+)\*\* \|/gm)].map((match) =>
      Number(match[1])
    );
    assert.deepStrictEqual(
      documentedCodes,
      codes,
      'the summary table documents every ExitCode exactly once, in order'
    );

    const header = exitSection
      .split(/\r?\n/)
      .find((line) => line.startsWith('| Command |'));
    assert.strictEqual(
      header,
      '| Command | Exit | Behavior |',
      'the per-command matrix uses the long-form header'
    );

    const validCodes = new Set<number>(codes);
    const pairs = new Set<string>();
    for (const row of exitRows) {
      assert.ok(
        validCodes.has(row.exit),
        `palee ${row.command} documents exit ${row.exit}, which is not an ExitCode`
      );
      assert.ok(row.behavior.length > 0, `palee ${row.command} exit ${row.exit} has behavior text`);
      const key = `${row.command}\u0000${row.exit}`;
      assert.ok(!pairs.has(key), `palee ${row.command} documents exit ${row.exit} twice`);
      pairs.add(key);
    }

    for (const command of registered) {
      if (command === undefined) continue;
      assert.ok(
        exitRows.some((row) => row.command === command && row.exit === ExitCode.Success),
        `palee ${command} documents an exit-0 success path`
      );
    }

    // `validate --fix` folds a repair skipped by an OCC conflict into
    // `conflicts[]`; it never sets exit 4, and the exit code follows the
    // normal severity rule (#486).
    assert.ok(
      !exitRows.some((row) => row.command === 'validate' && row.exit === ExitCode.Conflict),
      'palee validate never exits 4'
    );
  });
});

/**
 * #486: `agent.md` called `validate --fix` and `session end` "Phase-1 stubs"
 * long after both shipped, and nothing failed because the claim lived only in
 * prose. This ties a stub claim to the handler it names: a command may be
 * called a stub only while its source still carries a stub marker.
 */
describe('agent.md stub claims match the handlers (#486)', () => {
  test('the scanner recognises the historical claim it was written for', () => {
    assert.deepStrictEqual(
      namedCommands('`validate --fix` and `session end` are Phase-1 stubs.'),
      ['validate', 'session']
    );
  });

  test('a registered command called a stub still carries a stub marker in its handler', () => {
    const agent = fs.readFileSync(path.join(root, 'agent.md'), 'utf8');
    const marker = /\b(?:stubs?|unimplemented|not implemented)\b/i;
    const stale: string[] = [];

    for (const line of agent.split(/\r?\n/)) {
      if (!marker.test(line)) continue;
      for (const command of namedCommands(line)) {
        const handler = fs.readFileSync(path.join(root, `src/cli/${command}.ts`), 'utf8');
        if (!marker.test(handler)) {
          stale.push(`\`palee ${command}\` — agent.md: "${line.trim()}"`);
        }
      }
    }

    assert.deepStrictEqual(stale, [], `agent.md calls shipped commands stubs:\n${stale.join('\n')}`);
  });
});

/**
 * #565 P1-12: the README is the first page a user reads and it was the one command
 * table no test read — this file guarded `docs/02-0` and `agent.md` only. Two rows had
 * drifted from the handlers: `session start` promised an AI tutor the handler never
 * calls, and `validate --fix` named one of its three repairers. The table is checked
 * against the same `--help` parse as everything above, so the command list cannot rot
 * either.
 */
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeCommandsSection = readme.slice(
  readme.indexOf('## Commands'),
  readme.indexOf('### Key Options')
);
const readmeTableRows = readme.split(/\r?\n/).filter((line) => line.startsWith('| `palee '));

/** The README table row whose command cell starts with `palee <prefix>`. */
function readmeRow(prefix: string): string {
  const row = readmeTableRows.find((line) => line.startsWith(`| \`palee ${prefix}`));
  assert.ok(row, `README has no \`palee ${prefix}\` table row`);
  return row;
}

describe('README command table matches the built CLI (#565 P1-12)', () => {
  test('every command in the README table is one the CLI registers', () => {
    const named = readmeCommandsSection
      .split(/\r?\n/)
      .filter((line) => line.startsWith('| `palee '))
      .map((line) => /^\| `palee ([a-z-]+)/.exec(line)?.[1] ?? '');

    // Floor: a parse that found nothing would pass vacuously, and the table has always
    // listed every command.
    assert.ok(named.length >= 10, `expected the README commands table, parsed ${named.length} rows`);
    assert.deepStrictEqual(
      named.filter((command) => !registered.includes(command)),
      [],
      'the README table documents a command `palee --help` does not register'
    );
  });

  test('session start reports the provider instead of promising a tutor', () => {
    // `src/cli/session.ts` reads `config.aiProvider` and prints
    // `ai_provider_configured`; the handler contains no provider call at all.
    const row = readmeRow('session start');
    assert.doesNotMatch(row, /tutor/i, 'session start runs no tutor — that promise was never true');
    assert.match(row, /provider is configured/, 'the row has to state what the command actually reports');
  });

  test('validate --fix names every repairer it dispatches', () => {
    // `src/cli/validate.ts` maps valid-session-index and valid-hot-memory to
    // rebuild_derived_views, valid-topic-mastery to recompute_topic_mastery, and
    // valid-review-fields to reset_review_fields. A row naming only SM-2 hides the two
    // repairs that rewrite derived state.
    const row = readmeRow('validate --fix').toLowerCase();
    for (const subject of ['derived views', 'mastery', 'sm-2']) {
      assert.ok(row.includes(subject), `the validate --fix row omits ${subject}`);
    }
  });
});
