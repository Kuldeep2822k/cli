/**
 * Census: a platform guard must skip visibly, never return silently (#539 review)
 *
 * Contracts under test:
 * - No test asserts nothing while reporting `pass`. A bare `if (process.platform …)
 *   return;` at the top of a body finishes green on the other platform, so the report
 *   claims a check ran when none did — the dead-test shape ADR-0026 names.
 * - `{ skip: <condition> }` is the supported form and reports `SKIP`, which is honest.
 * - A visible `t.skip('reason'); return;` inside a block is allowed: it names itself in
 *   the report, and one test in `storage-atomic-write-containment.test.ts` uses it.
 *
 * The pattern is assembled from parts so this file's own source cannot match it —
 * otherwise the census would report itself and force an exception.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'test');

/** `process.platform`, built at runtime so the literal never appears in this file. */
const PLATFORM = ['process', '.', 'platform'].join('');

/** The silent form: a platform check followed by a bare early exit, all on one line. */
const SILENT_ONE_LINE = new RegExp(`if[ \\t]*\\([ \\t]*${PLATFORM}\\b[^\\n]*?\\)[ \\t]*return[ \\t]*;`);

/** The same guard written as a block, `if (…) { return; }`, possibly across lines. */
const SILENT_BLOCK = new RegExp(`if[ \\t]*\\([ \\t]*${PLATFORM}\\b[^\\n]*?\\)[ \\t]*\\{[ \\t\\r\\n]*return[ \\t]*;`);

/** The supported spelling, counted as a floor so the scan cannot pass vacuously. */
const VISIBLE_SKIP = new RegExp(`skip:\\s*${PLATFORM}`, 'g');

/** Recursively lists every file under `dir`, sorted for deterministic output. */
function testFiles(dir = TEST_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...testFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Renders an absolute path as repo-relative POSIX for assertion messages. */
function show(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

describe('Platform guards skip visibly — census', () => {
  test('no test returns early on a platform check and reports a green pass', () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of testFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      scanned += 1;
      for (const pattern of [SILENT_ONE_LINE, SILENT_BLOCK]) {
        const global = new RegExp(pattern.source, 'g');
        for (const match of content.matchAll(global)) {
          const line = content.slice(0, match.index).split(/\r?\n/).length;
          offenders.push(`${show(file)}:${line}: ${match[0].replace(/\s+/g, ' ').trim()}`);
        }
      }
    }

    // Floor: an empty or broken walk would satisfy the assertion below for the wrong
    // reason, and this census exists precisely to catch that class of vacuity.
    assert.ok(scanned > 50, `expected to scan the whole suite, scanned ${scanned} files`);

    assert.deepStrictEqual(
      offenders,
      [],
      `a platform guard must use \`{ skip: … }\` so the report says SKIP, not a green PASS `
        + `that asserts nothing (ADR-0026):\n  ${offenders.join('\n  ')}`
    );
  });

  test('the visible skip form is actually in use, so the census has something to find', () => {
    // If every `skip:` were rewritten into a bare return, the test above would pass
    // trivially. A floor on the supported spelling keeps the pair honest.
    let uses = 0;
    for (const file of testFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      uses += [...content.matchAll(VISIBLE_SKIP)].length;
    }
    assert.ok(uses >= 5, `expected the suite to use \`skip: ${PLATFORM}…\` at least 5 times, saw ${uses}`);
  });
});
