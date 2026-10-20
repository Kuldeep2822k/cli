import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode } from '../src/cli/exit-codes';

/**
 * #268's first item: `palee assess` was registered in `bin/palee.ts`, showed in
 * `palee --help`, and appeared nowhere in the exit-code contract — whose own preamble
 * still counted eleven commands. A number in prose is what rots; the dispatcher is the
 * fact. These read both and compare, so adding a command without documenting its exit
 * behavior fails here instead of quietly making the page wrong.
 */
const root = path.resolve(__dirname, '..');
const dispatcher = fs.readFileSync(path.join(root, 'bin/palee.ts'), 'utf8');
const contract = fs.readFileSync(path.join(root, 'docs/02-0-cli-commands.md'), 'utf8');

// The page carries a second `| Command |` table for machine-readable output, so the
// assertion reads the exit-code section alone; a command with a JSON row but no exit
// row is exactly the gap this test exists to catch.
const exitSection = contract.slice(
  contract.indexOf('## Exit Code Contract'),
  contract.indexOf('\n## ', contract.indexOf('## Exit Code Contract') + 1)
);

const registered = [...dispatcher.matchAll(/^ {2}\.command\('([a-z-]+)'/gm)].map((m) => m[1]);
const documented = [...exitSection.matchAll(/^\| `palee ([a-z-]+)` \|/gm)].map((m) => m[1]);

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
  test('the dispatcher registers a non-empty, duplicate-free command list', () => {
    assert.ok(registered.length >= 2, `expected top-level commands, got ${registered.join(', ')}`);
    assert.strictEqual(new Set(registered).size, registered.length, 'no command is registered twice');
  });

  test('the matrix has exactly one row per command, and no row for a command that is not one', () => {
    assert.strictEqual(documented.length, new Set(documented).size, 'a command has no second matrix row');
    assert.deepStrictEqual(
      [...documented].sort(),
      [...registered].sort(),
      'every `palee --help` command needs a matrix row, and the matrix may not invent one'
    );
  });

  test('the prose count of commands matches the dispatcher', () => {
    const claimed = /across all (\d+) commands/.exec(contract);
    assert.ok(claimed, 'the contract preamble states how many commands it covers');
    assert.strictEqual(
      Number(claimed[1]),
      registered.length,
      `the page says ${claimed[1]} commands while bin/palee.ts registers ${registered.length}`
    );
  });

  test('the testing guide counts and names exactly the commands the dispatcher registers', () => {
    // #458 corrected these sentences to the then-true 12, and adding `update` made
    // them wrong again with nothing failing — because the guard above reads only
    // `docs/02-0`. A number stated in a second file is the same kind of fact and
    // needs the same dispatcher behind it.
    const guide = fs.readFileSync(
      path.join(root, 'docs/06-2-integration-and-smoke-tests.md'),
      'utf8'
    );

    const registers = /the CLI registers (\d+) top-level commands/.exec(guide);
    assert.ok(registers, 'the testing guide states how many commands the CLI registers');
    assert.strictEqual(
      Number(registers[1]),
      registered.length,
      `docs/06-2 states ${registers[1]} top-level commands while bin/palee.ts registers ${registered.length}`
    );

    const outside = /(\d+) of the (\d+) registered commands \(([^)]*)\)/.exec(guide);
    assert.ok(outside, 'the guide names the commands falling outside the exit-code matrix');
    assert.strictEqual(
      Number(outside[2]),
      registered.length,
      `docs/06-2 states a total of ${outside[2]} while bin/palee.ts registers ${registered.length}`
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

  test('the exit-code numbers and cells match the documented contract', () => {
    // #486: the matrix was checked row-by-row but never as a numeric contract:
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
    assert.ok(header, 'the per-command matrix has a header row');
    const columns = [...header.matchAll(/Exit Code (\d+)/g)].map((match) => Number(match[1]));
    assert.deepStrictEqual(columns, codes, 'the matrix has one numeric column per ExitCode');

    const rows = new Map<string, string>();
    for (const match of exitSection.matchAll(/^\| `palee ([a-z-]+)` \|(.+)\|$/gm)) {
      const command = match[1];
      if (command !== undefined) rows.set(command, match[2] ?? '');
    }

    for (const command of registered) {
      if (command === undefined) continue;
      const row = rows.get(command);
      assert.ok(row !== undefined, `palee ${command} has a matrix row`);
      const cells = row.split('|').map((cell) => cell.trim());
      assert.strictEqual(cells.length, columns.length, `palee ${command} has one cell per code`);
      assert.notStrictEqual(cells[0], 'N/A', `palee ${command} documents a success path`);
      assert.ok(
        cells.every((cell) => cell.length > 0),
        `palee ${command} leaves no exit-code cell empty`
      );
    }

    // `validate --fix` folds a repair skipped by an OCC conflict into
    // `conflicts[]`; it never sets exit 4, and the exit code follows the
    // normal severity rule (#486).
    const validateCells = (rows.get('validate') ?? '').split('|').map((cell) => cell.trim());
    assert.strictEqual(validateCells[4], 'N/A', 'palee validate never exits 4');
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
