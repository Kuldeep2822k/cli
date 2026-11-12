import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL_ACTIVE_CHARACTERS } from '../src/text-safety';
import { describeForeignText } from '../src/ai/provider';
import { sanitizeForDisplay, sanitizeMultilineForDisplay } from '../src/cli/display-safety';

/**
 * The provider boundary and the CLI display layer each carried their own
 * control-character class (#INV-30, #565 P2-06). They differ only in the
 * substitute — `?` for a message that must stay diagnosable, deletion for
 * terminal output — so the class lives in `src/text-safety.ts` now and both
 * callers must reference it.
 */
describe('one terminal-active character class for every text sink', () => {
  test('matches C0 (except tab/newline/CR), DEL, C1 and bidi controls', () => {
    const hits = (value: string): number => (value.match(TERMINAL_ACTIVE_CHARACTERS) ?? []).length;
    assert.strictEqual(hits('\u001b[31m'), 1, 'ESC is terminal-active');
    assert.strictEqual(hits('a\u0007b'), 1, 'BEL is terminal-active');
    assert.strictEqual(hits('del\u007f'), 1, 'DEL is terminal-active');
    assert.strictEqual(hits('c1\u009b'), 1, 'CSI is terminal-active');
    assert.strictEqual(hits('safe\u202eevil'), 1, 'RLO can reorder a line');
    // The three whitespace controls are each caller's separate concern.
    assert.strictEqual(hits('a\tb\nc\rd'), 0);
    assert.strictEqual(hits('Café 👨\u200d👩\u200d👧'), 0);
  });

  test('the provider keeps `?` as its substitute and now covers bidi', () => {
    assert.strictEqual(describeForeignText(undefined, 'a\u001bb'), 'a?b');
    assert.strictEqual(describeForeignText(undefined, 'safe\u202eevil'), 'safe?evil');
    assert.strictEqual(describeForeignText(undefined, 'line one\nline two'), 'line one line two');
    assert.strictEqual(describeForeignText('sekret', 'bad sekret\u001b'), 'bad ***?');
  });

  test('both sinks reference the shared class instead of their own copy', () => {
    const files: Array<[string, RegExp]> = [
      ['ai/provider.ts', /from '\.\.\/text-safety'/],
      ['cli/display-safety.ts', /from '\.\.\/text-safety'/],
    ];
    for (const [file, importer] of files) {
      const source = fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
      assert.match(source, importer, `${file} must import the shared class`);
      assert.doesNotMatch(source, /\\u0000-\\u0008/, `${file} must not carry a local C0 class`);
      assert.doesNotMatch(source, /\\u061C/, `${file} must not carry a local bidi list`);
    }
    // The display variants still keep their distinct whitespace contracts.
    assert.strictEqual(sanitizeForDisplay('one\ntwo'), 'one two');
    assert.strictEqual(sanitizeMultilineForDisplay('one\ntwo'), 'one\ntwo');
  });
});
