import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

/**
 * Pins the decision that two CLI-layer functions are internal utilities,
 * not part of the documented package public API surface.
 *
 * The package barrel (src/index.ts) intentionally re-exports only
 * types, engine, storage, and validation — never src/cli/. These two
 * functions carry `export` only because TypeScript requires it for
 * same-module sibling calls; they have no external consumers.
 *
 * #skylos-unnecessary-exports
 */
const REPO = path.resolve(__dirname, '..');

function grepExcluding(pattern: string, excludeFile: string): string[] {
  const result = execSync(
    `grep -rn "${pattern}" ${REPO}/src/ ${REPO}/bin/ ${REPO}/test/ ` +
    `--include="*.ts" | grep -v node_modules | grep -v "skylos-report" | grep -v "${excludeFile}"`,
    { encoding: 'utf8', timeout: 10000 }
  );
  return result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('Internal export hygiene — CLI layer utilities', () => {
  const srcDir = path.join(REPO, 'src');

  /** Files that must NOT be re-exported from the package barrel. */
  const cliSubfiles = ['onboarding.ts', 'vault-echo.ts', 'session.ts'];

  test('src/index.ts barrel does not re-export anything from src/cli/', () => {
    const barrel = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
    for (const file of cliSubfiles) {
      assert.ok(
        !barrel.includes(`./cli/${file.replace(/\\.ts$/, '')}`) &&
        !barrel.includes(`./cli/${file}`),
        `src/index.ts should not re-export from ./cli/${file}`
      );
    }
    assert.ok(
      !barrel.includes('./cli'),
      'src/index.ts must not contain a bare ./cli barrel import'
    );
  });

  test('resolveSessionTopicResolution is imported only by its own module and its tests', () => {
    const importers = grepExcluding(
      'resolveSessionTopicResolution',
      'test/internal-export-hygiene.test.ts'
    ).filter((line) => !line.includes('src/cli/session.ts'));
    assert.deepStrictEqual(
      importers, [],
      `No external importers of resolveSessionTopicResolution, found: ${JSON.stringify(importers)}`
    );
  });

  test('echoVaultTarget is imported only by its own module and its tests', () => {
    const importers = grepExcluding(
      'echoVaultTarget',
      'test/internal-export-hygiene.test.ts'
    ).filter((line) => !line.includes('src/cli/vault-echo.ts'));
    assert.deepStrictEqual(
      importers, [],
      `No external importers of echoVaultTarget, found: ${JSON.stringify(importers)}`
    );
  });
});
