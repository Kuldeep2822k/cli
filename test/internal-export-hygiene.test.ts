import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pins the decision that two CLI-layer functions are internal utilities,
 * not part of the documented package public API surface.
 *
 * The package barrel (src/index.ts) intentionally re-exports only
 * types, engine, storage, and validation — never src/cli/. These two
 * functions are used only inside their own files and do not need to be
 * exported. Keeping `export` on them produces Skylos SKY-E004 findings
 * and signals a public API surface that does not exist.
 *
 * #skylos-unnecessary-exports
 */
const REPO = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO, 'src');
const TEST_DIR = path.join(REPO, 'test');
const BIN_DIR = path.join(REPO, 'bin');

/**
 * Recursively reads all .ts files under `dir`, returning { file, lines }.
 * Replaces shell-based grep so the tests work on Windows CI where grep
 * may not be on PATH.
 */
function readAllTsFiles(dir: string): { file: string; lines: string[] }[] {
  const results: { file: string; lines: string[] }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !fullPath.includes('node_modules')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      results.push({ file: fullPath, lines: content.split('\n') });
    }
  }
  return results;
}

/** All .ts source files (src + bin, excluding tests and node_modules). */
const SOURCE_FILES = [...readAllTsFiles(SRC_DIR), ...readAllTsFiles(BIN_DIR)];

/**
 * Returns import statements referencing `pattern` from source files outside `excludeFile`.
 * Only matches actual `import`/`require` lines, not comments or JSDoc `{@link}` tags.
 */
function findReferences(pattern: string, excludeFile: string): string[] {
  const matches: string[] = [];
  const thisTestFile = path.join(TEST_DIR, 'internal-export-hygiene.test.ts');
  const importPatterns = [
    // ESM: import { X, ... } from '...';  or import X from '...';
    /^import\b.*?\bfrom\b/,
    // Dynamic: const X = require('...');  or  import('...')
    /\brequire\s*\(/,
    /\bimport\s*\(/,
  ];
  for (const { file, lines } of SOURCE_FILES) {
    if (path.relative(file, excludeFile) === '') continue;
    lines.forEach((line, idx) => {
      if (importPatterns.some((re) => re.test(line)) && line.includes(pattern)) {
        matches.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
  // Also check test files for actual import/require statements
  for (const { file, lines } of readAllTsFiles(TEST_DIR)) {
    if (path.relative(file, excludeFile) === '') continue;
    if (path.relative(file, thisTestFile) === '') continue;
    lines.forEach((line, idx) => {
      if (importPatterns.some((re) => re.test(line)) && line.includes(pattern)) {
        matches.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
  return matches;
}

describe('Internal export hygiene — CLI layer utilities', () => {
  /** Files that must NOT be re-exported from the package barrel. */
  const cliSubfiles = ['onboarding.ts', 'vault-echo.ts', 'session.ts'];

  test('src/index.ts barrel does not re-export anything from src/cli/', () => {
    const barrel = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf8');
    for (const file of cliSubfiles) {
      const bare = file.replace(/\.ts$/, '');
      assert.ok(
        !barrel.includes(`./cli/${bare}`) &&
        !barrel.includes(`./cli/${file}`),
        `src/index.ts should not re-export from ./cli/${file}`
      );
    }
    assert.ok(
      !barrel.includes('./cli'),
      'src/index.ts must not contain a bare ./cli barrel import'
    );
  });

  test('resolveSessionTopicResolution has no export keyword and no external importers', () => {
    const filePath = path.join(SRC_DIR, 'cli', 'session.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Verify the declaration is NOT exported via any pattern:
    // 1. Direct: export function resolveSessionTopicResolution
    // 2. Grouped single-line: export { resolveSessionTopicResolution }
    // 3. Grouped multi-line: export { ... \n resolveSessionTopicResolution \n ... }
    assert.ok(
      !content.includes('export function resolveSessionTopicResolution'),
      'resolveSessionTopicResolution must not use `export function` — it is used only inside session.ts'
    );
    assert.ok(
      !content.includes('export { resolveSessionTopicResolution'),
      'resolveSessionTopicResolution must not be in a grouped export — it is used only inside session.ts'
    );
    // Check multiline grouped exports: "export {" ... "resolveSessionTopicResolution" ... "}"
    const groupedExports = content.match(/export\s*\{[\s\S]*?\}/g) ?? [];
    for (const block of groupedExports) {
      assert.ok(
        !/\bresolveSessionTopicResolution\b/.test(block),
        `resolveSessionTopicResolution must not be exported via grouped export: ${block}`
      );
    }

    // Verify no source file outside session.ts imports it
    const importers = findReferences('resolveSessionTopicResolution', filePath);
    assert.deepStrictEqual(
      importers, [],
      `No external importers of resolveSessionTopicResolution, found: ${JSON.stringify(importers)}`
    );
  });

  test('echoVaultTarget has no export keyword and no external importers', () => {
    const filePath = path.join(SRC_DIR, 'cli', 'vault-echo.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Verify the declaration is NOT exported via any pattern:
    // 1. Direct: export function echoVaultTarget
    // 2. Grouped single-line: export { echoVaultTarget }
    // 3. Grouped multi-line: export { ... \n echoVaultTarget \n ... }
    assert.ok(
      !content.includes('export function echoVaultTarget'),
      'echoVaultTarget must not use `export function` — it is used only inside vault-echo.ts'
    );
    assert.ok(
      !content.includes('export { echoVaultTarget'),
      'echoVaultTarget must not be in a grouped export — it is used only inside vault-echo.ts'
    );
    // Check multiline grouped exports: "export {" ... "echoVaultTarget" ... "}"
    const groupedExports = content.match(/export\s*\{[\s\S]*?\}/g) ?? [];
    for (const block of groupedExports) {
      assert.ok(
        !/\bechoVaultTarget\b/.test(block),
        `echoVaultTarget must not be exported via grouped export: ${block}`
      );
    }

    // Verify no source file outside vault-echo.ts imports it
    const importers = findReferences('echoVaultTarget', filePath);
    assert.deepStrictEqual(
      importers, [],
      `No external importers of echoVaultTarget, found: ${JSON.stringify(importers)}`
    );
  });
});
