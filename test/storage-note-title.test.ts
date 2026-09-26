import { test } from 'node:test';
import assert from 'node:assert';
import { resolveNoteTitle } from '../src/storage/note-title';

/**
 * Title resolution reads the first real `# heading`. An example block showing
 * both fence styles used to end at the wrong marker, so a heading that only
 * exists inside a code sample became the note's minted title — and the importer
 * writes that into the note's frontmatter.
 */
test('note title resolution (INV-48 title minting)', () => {
  assert.strictEqual(resolveNoteTitle('# Real\n\nBody\n', '/vault/n.md'), 'Real');
  assert.strictEqual(resolveNoteTitle('no heading here\n', '/vault/02-first-app.md'), '02-first-app');
  assert.strictEqual(resolveNoteTitle('plain text, no path'), 'Untitled');
});

test('a tilde line never closes a backtick fence in title extraction', () => {
  const content =
    '# Real Title\n\n```markdown\nusage:\n~~~\n# Phantom Title\n```\n\nBody after the example.\n';
  assert.strictEqual(resolveNoteTitle(content, '/vault/real-name.md'), 'Real Title');
});

test('an unclosed fence runs to the end of the document', () => {
  const content = '```md\n# Phantom Title\n\n# Also Phantom\n';
  assert.strictEqual(resolveNoteTitle(content, '/vault/real-name.md'), 'real-name');
});

test('a heading after a properly closed fence is still the title', () => {
  const content = '```md\n# Not The Title\n```\n\n# The Title\n';
  assert.strictEqual(resolveNoteTitle(content, '/vault/real-name.md'), 'The Title');
});
