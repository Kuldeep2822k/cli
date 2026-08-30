import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseFrontmatter, updateFrontmatter, computeFingerprint } from '../src/storage/frontmatter';

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

  test('handles malformed YAML gracefully', () => {
    // YAML parser is forgiving - use truly invalid syntax
    const content = `---
title: Test
invalid: >>>malformed
completely broken: {{{
---
Body content`;

    const result = parseFrontmatter(content);
    // Parser may recover - just ensure it doesn't crash
    assert.ok(result);
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
