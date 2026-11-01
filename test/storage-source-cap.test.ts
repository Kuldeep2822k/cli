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
 * - The predicate the write paths now share is inclusive of the ceiling itself:
 *   a note of exactly 512 KiB is a legitimate note, one byte more is not.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  MAX_NOTE_SOURCE_BYTES,
  noteContentExceedsReadCap,
  noteExceedsReadCap,
  oversizedNoteDiagnostic,
  oversizedWriteDiagnostic,
} from '../src/storage/source-cap';

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

  // #565 P1-10: both sides of the boundary, because a one-sided assertion also
  // passes against a zero-byte cap.
  describe('the predicate the write paths share (#565 P1-10)', () => {
    test('a note of exactly the ceiling is still readable', () => {
      assert.strictEqual(noteExceedsReadCap(MAX_NOTE_SOURCE_BYTES), false);
    });

    test('one byte past the ceiling is refused', () => {
      assert.strictEqual(noteExceedsReadCap(MAX_NOTE_SOURCE_BYTES + 1), true);
    });

    test('an empty note is readable', () => {
      assert.strictEqual(noteExceedsReadCap(0), false);
    });
  });

  // #565 P1-10 review: bounding the source is not enough. The write paths add managed
  // frontmatter, so the *result* needs the same two-sided check.
  describe('the result a write would produce (#565 P1-10 review)', () => {
    test('content of exactly the ceiling is still writable', () => {
      assert.strictEqual(noteContentExceedsReadCap('x'.repeat(MAX_NOTE_SOURCE_BYTES)), false);
    });

    test('one byte past the ceiling is refused', () => {
      assert.strictEqual(noteContentExceedsReadCap('x'.repeat(MAX_NOTE_SOURCE_BYTES + 1)), true);
    });

    test('the check counts bytes, not characters, so multi-byte text is not under-counted', () => {
      // One 'é' is two bytes in UTF-8, so a string of `MAX / 2 + 1` of them is over the
      // cap while its `.length` still looks under it.
      const content = 'é'.repeat(MAX_NOTE_SOURCE_BYTES / 2 + 1);
      assert.ok(content.length <= MAX_NOTE_SOURCE_BYTES, 'the string length alone would pass');
      assert.strictEqual(noteContentExceedsReadCap(content), true, 'the byte length must decide');
    });

    test('the write diagnostic names the size it would have produced and the ceiling', () => {
      const message = oversizedWriteDiagnostic(MAX_NOTE_SOURCE_BYTES + 217);
      assert.ok(message.includes(String(MAX_NOTE_SOURCE_BYTES + 217)), message);
      assert.ok(message.includes(String(MAX_NOTE_SOURCE_BYTES)), message);
      assert.match(message, /read cap/);
    });
  });
});
