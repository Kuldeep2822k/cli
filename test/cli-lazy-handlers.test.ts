import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * `bin/palee.ts` imported all thirteen command handlers statically, so
 * `--version`, `--help` and every command paid for the whole vault/engine/
 * storage graph before Commander had parsed argv (#565 P2-12). Each action now
 * pulls its own handler in through `import()`.
 *
 * The split is what this census pins: no handler module may return to the
 * static import list, every `.action(...)` must load its own handler through
 * `lazyHandler`, and the modules the parser and the fatal/notice paths need on
 * every run stay static. Line comments are stripped first; block-comment
 * stripping would be wrong here because the adopt help text contains a glob
 * whose characters open a block comment.
 */
const HANDLERS = [
  'config',
  'adopt',
  'next',
  'plan',
  'progress',
  'review',
  'assess',
  'validate',
  'roadmap',
  'migrate',
  'session',
  'dashboard',
  'update',
] as const;

/** Always-needed modules: parsing, version, exit codes, fatal JSON, notice. */
const STATIC_ALLOWLIST = [
  'commander',
  '../package.json',
  '../src/cli/exit-code-values',
  '../src/cli/onboarding',
  '../src/cli/program-name',
  '../src/cli/update-check',
] as const;

describe('bin/palee.ts loads command handlers on dispatch (#565 P2-12)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../bin/palee.ts'), 'utf8');
  // Line comments only: the adopt help text contains `**/*.md`, which a
  // block-comment regex reads as an opener and would swallow real code.
  const code = source.replace(/^\s*\/\/.*$/gm, '');

  // Anchored at column 0: every static import in this file sits there, while
  // help-template prose and the action callbacks are indented.
  const staticImports = [...code.matchAll(/^import\s+(?:type\s+)?[^;]*?from\s+'([^']+)'/gm)].map(
    (match) => match[1]
  );
  // Anchored to the wrapper itself: a bare `import(...)` in a comment, at
  // module scope, or inside a hand-written action would not satisfy it.
  const dynamicImports = [
    ...code.matchAll(/\.action\(\s*lazyHandler\(\(\) => import\('(\.\.\/src\/cli\/[a-z]+)'\)\)\)/g),
  ].map((match) => match[1]);
  // Every handler import anywhere in the file, wrapped or not: one added at
  // module scope would restore eager loading without changing the wrapped list.
  const allHandlerImports = [...code.matchAll(/import\('(\.\.\/src\/cli\/[a-z]+)'\)/g)].map(
    (match) => match[1]
  );

  test('no command handler is imported statically', () => {
    for (const handler of HANDLERS) {
      assert.ok(
        !staticImports.includes(`../src/cli/${handler}`),
        `../src/cli/${handler} must not appear in a static import`
      );
    }
  });

  test('every command handler is imported from inside its action', () => {
    for (const handler of HANDLERS) {
      assert.ok(
        dynamicImports.includes(`../src/cli/${handler}`),
        `../src/cli/${handler} must be loaded through a dynamic import`
      );
    }
    assert.strictEqual(
      dynamicImports.length,
      HANDLERS.length,
      'the dynamic import list must be exactly the handlers — no stray or missing entry'
    );
    assert.strictEqual(
      (code.match(/\.action\(/g) ?? []).length,
      HANDLERS.length,
      'every command action must be registered exactly once'
    );
    assert.deepStrictEqual(
      allHandlerImports.slice().sort(),
      HANDLERS.map((handler) => `../src/cli/${handler}`).sort(),
      'handler imports must exist nowhere but inside their lazyHandler actions'
    );
  });

  test('the modules every run needs stay static', () => {
    for (const required of STATIC_ALLOWLIST) {
      assert.ok(staticImports.includes(required), `${required} must stay statically imported`);
    }
    const unexpected = staticImports.filter(
      (specifier) => !STATIC_ALLOWLIST.includes(specifier as (typeof STATIC_ALLOWLIST)[number])
    );
    assert.deepStrictEqual(unexpected, [], 'the static import list must contain only always-needed modules');
  });
});
