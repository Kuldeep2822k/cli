import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../src/storage/frontmatter';

/**
 * Counts the line terminators in a rewritten note so tests can assert on bytes
 * rather than on parsed frontmatter, which is blind to them.
 *
 * @param text - Note content
 * @returns Number of CRLF breaks and of lone LF breaks (an LF not preceded by a CR)
 */
function terminatorCensus(text: string): { crlf: number; loneLf: number } {
  return {
    crlf: (text.match(/\r\n/g) ?? []).length,
    loneLf: (text.match(/(?<!\r)\n/g) ?? []).length,
  };
}

describe('Frontmatter Parser', () => {
  test('parses valid frontmatter and body', () => {
    const content = `---
title: Test Note
tags: [test, example]
---
# Test Content

This is the body.`;

    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter!.title, 'Test Note');
    assert.deepStrictEqual(result.frontmatter!.tags, ['test', 'example']);
    assert.strictEqual(result.body, '# Test Content\n\nThis is the body.');
  });

  test('handles content with no frontmatter', () => {
    const content = '# Just a heading\n\nSome text.';
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, content);
  });

  test('strips leading BOM (U+FEFF) before parsing frontmatter', () => {
    // Windows editors emit a leading BOM; the spec for #26 requires
    // BOM stripping. Without it the `^---` regex fails and the note
    // silently vanishes from the topic snapshot with no finding.
    const content = '\uFEFF---\npalee_id: T-bom\ntitle: BOM test\n---\n# body';
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter!.palee_id, 'T-bom');
    assert.strictEqual(result.frontmatter!.title, 'BOM test');
    assert.strictEqual(result.body, '# body');
    assert.strictEqual(result.body.startsWith('\uFEFF'), false);
    assert.strictEqual(result.error, undefined);
  });

  test('handles malformed YAML gracefully', () => {
    // YAML parser is forgiving - use truly invalid syntax
    const content = `---
title: Test
invalid: >>>malformed
completely broken: {{{
---
Body content`;

    const result = parseFrontmatter(content);
    // Contract for malformed frontmatter YAML: the parse error is surfaced,
    // frontmatter is null (never a half-parsed mapping), and the body is still
    // split out verbatim. A regression that silently swallowed the YAML error
    // and returned a recovered mapping would fail here.
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(typeof result.error, 'string');
    assert.ok(result.error!.length > 0, 'malformed YAML must surface an error message');
    assert.strictEqual(result.body, 'Body content');
  });
});

describe('Frontmatter Updater', () => {
  test('preserves body byte-for-byte', () => {
    const originalBody = '# Heading\n\nBody with **markdown**.\n\n```yaml\nkey: value\n```';
    const content = `---
title: Original
---
${originalBody}`;

    const updated = updateFrontmatter(content, { title: 'Updated' });
    const parsed = parseFrontmatter(updated);

    assert.strictEqual(parsed.body, originalBody);
  });

  test('preserves unknown frontmatter keys', () => {
    const content = `---
title: Test
obsidian_plugin_data: special-value
cssclass: custom-class
palee_id: T-test
---
Body`;

    const updated = updateFrontmatter(content, { palee_id: 'T-updated' });
    const parsed = parseFrontmatter(updated);

    assert.strictEqual(parsed.frontmatter!.title, 'Test');
    assert.strictEqual(parsed.frontmatter!.obsidian_plugin_data, 'special-value');
    assert.strictEqual(parsed.frontmatter!.cssclass, 'custom-class');
    assert.strictEqual(parsed.frontmatter!.palee_id, 'T-updated');
  });

  test('preserves YAML comments', () => {
    const content = `---
# This is a comment
title: Test
# Another comment
tags: [a, b]
---
Body`;

    const updated = updateFrontmatter(content, { title: 'Updated' });

    // Comments should be preserved in raw YAML
    assert.ok(updated.includes('# This is a comment'));
    assert.ok(updated.includes('# Another comment'));
  });

  test('creates frontmatter when none exists', () => {
    const content = '# Just body content';
    const updated = updateFrontmatter(content, { palee_id: 'T-123', title: 'New' });
    const parsed = parseFrontmatter(updated);

    assert.strictEqual(parsed.frontmatter!.palee_id, 'T-123');
    assert.strictEqual(parsed.frontmatter!.title, 'New');
    assert.ok(parsed.body.includes('# Just body content'));
  });

  test('creates frontmatter when none exists with clean YAML block lists for arrays', () => {
    const content = '# Just body content';
    const updated = updateFrontmatter(content, { palee_id: 'T-123', depends_on: ['T-a', 'T-b'] });
    const parsed = parseFrontmatter(updated);

    assert.strictEqual(parsed.frontmatter!.palee_id, 'T-123');
    assert.deepStrictEqual(parsed.frontmatter!.depends_on, ['T-a', 'T-b']);
    assert.ok(updated.includes('depends_on:'));
    assert.ok(updated.includes('T-a'));
    assert.ok(updated.includes('T-b'));
  });

  test('handles block scalar body with YAML-like text', () => {
    const bodyWithYaml = `# Example

\`\`\`yaml
title: Not Frontmatter
key: value
\`\`\`

Regular text.`;

    const content = `---
title: Real Title
---
${bodyWithYaml}`;

    const updated = updateFrontmatter(content, { title: 'Updated Title' });
    const parsed = parseFrontmatter(updated);

    assert.strictEqual(parsed.body, bodyWithYaml);
    assert.strictEqual(parsed.frontmatter!.title, 'Updated Title');
  });

  test('updates empty frontmatter block without creating duplicate double fences', () => {
    const content = '---\n---\n# Body after empty fence';
    const updated = updateFrontmatter(content, { title: 'Updated Title' });
    assert.ok(!updated.includes('---\n---'));
    const parsed = parseFrontmatter(updated);
    assert.strictEqual(parsed.frontmatter?.title, 'Updated Title');
    assert.strictEqual(parsed.body, '# Body after empty fence');
  });

  test('updates whitespace-only frontmatter block without creating duplicate double fences', () => {
    const content = '---\n\n---\n# Body after whitespace fence';
    const updated = updateFrontmatter(content, { title: 'Updated Title' });
    assert.ok(!updated.includes('---\n\n---'));
    assert.ok(!updated.includes('---\n---'));
    const parsed = parseFrontmatter(updated);
    assert.strictEqual(parsed.frontmatter?.title, 'Updated Title');
    assert.strictEqual(parsed.body, '# Body after whitespace fence');
  });

  test('correctly parses and updates frontmatter containing mid-line triple dashes', () => {
    const content = '---\ntitle: a --- b\nkey: c\n---\n# Body Content';
    const parsed = parseFrontmatter(content);
    assert.ok(parsed.frontmatter);
    assert.strictEqual(parsed.frontmatter.title, 'a --- b');
    assert.strictEqual(parsed.frontmatter.key, 'c');
    assert.strictEqual(parsed.body, '# Body Content');

    const updated = updateFrontmatter(content, { key: 'd' });
    const parsedUpdated = parseFrontmatter(updated);
    assert.ok(parsedUpdated.frontmatter);
    assert.strictEqual(parsedUpdated.frontmatter.title, 'a --- b');
    assert.strictEqual(parsedUpdated.frontmatter.key, 'd');
    assert.strictEqual(parsedUpdated.body, '# Body Content');
  });

  test('parses CRLF empty frontmatter blocks accurately', () => {
    const content = '---\r\n---\r\n# CRLF Body';
    const parsed = parseFrontmatter(content);
    assert.strictEqual(parsed.raw, '');
    assert.strictEqual(parsed.body, '# CRLF Body');

    const updated = updateFrontmatter(content, { title: 'CRLF Title' });
    assert.ok(!updated.includes('---\n---') && !updated.includes('---\r\n---'));
    const parsedUpdated = parseFrontmatter(updated);
    assert.strictEqual(parsedUpdated.frontmatter?.title, 'CRLF Title');
    assert.strictEqual(parsedUpdated.body, '# CRLF Body');
  });

  test('keeps a CRLF frontmatter block CRLF when one key changes', () => {
    // Obsidian on Windows and `core.autocrlf=true` write whole notes as CRLF.
    // The rebuilt head came back with hard-coded LF while the untouched body
    // stayed CRLF, so changing one key read as a whole-file diff (#259).
    const content = '---\r\npalee_id: T-crlf\r\ntitle: CRLF Note\r\n---\r\n# CRLF Note\r\n\r\nBody line.\r\n';

    const updated = updateFrontmatter(content, { title: 'Renamed' });
    const census = terminatorCensus(updated);

    assert.strictEqual(census.loneLf, 0, `mixed terminators: ${census.loneLf} lone LF break(s)`);
    assert.ok(census.crlf > 0, 'a note written with CRLF must come back with CRLF');
    assert.ok(updated.includes('palee_id: T-crlf\r\ntitle: Renamed\r\n'));
    assert.ok(updated.includes('---\r\n# CRLF Note\r\n'));
    assert.strictEqual(parseFrontmatter(updated).body, '# CRLF Note\r\n\r\nBody line.\r\n');
  });

  test('restores a leading BOM (U+FEFF) through both rewrite branches', () => {
    // parseFrontmatter drops the BOM so its `^---` anchor can match; nothing
    // put it back, so every note the CLI rewrote lost its first three bytes.
    const withFrontmatter = updateFrontmatter(
      '\uFEFF---\r\npalee_id: T-bom\r\n---\r\n# body\r\n',
      { title: 'BOM kept' }
    );
    assert.strictEqual(withFrontmatter.charCodeAt(0), 0xfeff);
    assert.strictEqual(parseFrontmatter(withFrontmatter).frontmatter!.title, 'BOM kept');

    const withoutFrontmatter = updateFrontmatter('\uFEFF# Body only\r\n', { palee_id: 'T-bom2' });
    assert.strictEqual(withoutFrontmatter.charCodeAt(0), 0xfeff);
    // The old code prepended the head *before* the BOM, moving it into the file.
    assert.strictEqual(withoutFrontmatter.lastIndexOf('\uFEFF'), 0, 'the BOM must stay at byte 0');
  });

  test('leaves an LF note LF-only', () => {
    // The convention is read off the note, never off the platform, so a
    // Linux-authored note must not be converted to CRLF by the fix above.
    const content = '---\npalee_id: T-lf\ntitle: LF Note\n---\n# LF Note\n\nBody line.\n';

    const updated = updateFrontmatter(content, { title: 'Renamed' });

    assert.strictEqual(updated.includes('\r\n'), false);
    assert.ok(terminatorCensus(updated).loneLf > 0, 'the head must still be written with LF');
    assert.strictEqual(updated, '---\npalee_id: T-lf\ntitle: Renamed\n---\n# LF Note\n\nBody line.\n');
  });

  test('matches a CRLF body when inserting a head into a note with no frontmatter', () => {
    // No existing block to sample, so the file decides — and the head is glued
    // directly onto that body, so the two halves have to agree from byte 0.
    const content = '# Heading\r\n\r\nBody line.\r\n';

    const updated = updateFrontmatter(content, { palee_id: 'T-new' });

    assert.strictEqual(updated, '---\r\npalee_id: T-new\r\n---\r\n# Heading\r\n\r\nBody line.\r\n');
    assert.strictEqual(terminatorCensus(updated).loneLf, 0);
  });
});

describe('Fingerprinting', () => {
  test('computes consistent SHA-256 hash', () => {
    const content = 'test content';
    const fp1 = computeFingerprint(content);
    const fp2 = computeFingerprint(content);

    assert.strictEqual(fp1, fp2);
    assert.strictEqual(fp1.length, 64); // SHA-256 hex = 64 chars
  });

  test('different content produces different fingerprint', () => {
    const fp1 = computeFingerprint('content A');
    const fp2 = computeFingerprint('content B');

    assert.notStrictEqual(fp1, fp2);
  });

  test('detects fingerprint mismatch for OCC', () => {
    const original = '---\ntitle: Original\n---\nBody';
    const modified = '---\ntitle: Modified\n---\nBody';

    const fp1 = computeFingerprint(original);
    const fp2 = computeFingerprint(modified);

    assert.notStrictEqual(fp1, fp2);
  });
});
