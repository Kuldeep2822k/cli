import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

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
});
