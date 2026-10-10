/**
 * Reading-path size guard (#332)
 *
 * Contracts under test:
 * - The note read ceiling is a fixed, positive byte count, equal to the ceiling
 *   the TOC reader already applies — parity by value, not by re-export, because
 *   `test/storage-barrel-census.test.ts` treats the storage barrel's export set
 *   as a census and the two documents are not the same contract.
 * - The diagnostic names both the observed size and the ceiling, so a reader
 *   can tell "too large to read" apart from "could not be read".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { MAX_NOTE_SOURCE_BYTES, oversizedNoteDiagnostic } from '../src/storage/source-cap';

describe('Note source size cap (Issue #332)', () => {
  test('the ceiling is 512 KiB, matching the TOC reader it mirrors', () => {
    assert.ok(
      Number.isInteger(MAX_NOTE_SOURCE_BYTES) && MAX_NOTE_SOURCE_BYTES > 0,
      'a bounded positive byte count, never a fraction or a negative'
    );
    assert.strictEqual(MAX_NOTE_SOURCE_BYTES, 512 * 1024);
  });

  test('the diagnostic quotes the ceiling and says the file was not read', () => {
    const message = oversizedNoteDiagnostic(5_000_000);

    assert.match(message, /Oversized/);
    assert.ok(message.includes('5000000'), `observed size missing from: ${message}`);
    assert.ok(
      message.includes(String(MAX_NOTE_SOURCE_BYTES)),
      `ceiling missing from: ${message}`
    );
    assert.match(message, /was not read/);
  });

  test('the diagnostic is stable for the same size, so repeated scans report identically', () => {
    assert.strictEqual(
      oversizedNoteDiagnostic(1234),
      oversizedNoteDiagnostic(1234),
      'no timestamps, no counters — the finding text must not churn a snapshot'
    );
  });
});
