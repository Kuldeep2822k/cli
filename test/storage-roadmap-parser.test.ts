import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseRoadmapContent } from '../src/storage/roadmap-parser';

describe('Roadmap Multi-Format Parser', () => {
  test('parses pure YAML content correctly', () => {
    const rawYaml = `
title: DevOps Path
topics:
  - id: T-01
    title: Linux Basics
    path: linux.md
    difficulty: beginner
  - id: T-02
    title: Docker Fundamentals
    path: docker.md
    difficulty: intermediate
    depends_on: [T-01]
`;
    const result = parseRoadmapContent(rawYaml, 'roadmap.yaml');
    assert.strictEqual(result.format, 'yaml');
    assert.ok(result.roadmap);
    assert.strictEqual(result.roadmap.topics.length, 2);
    assert.strictEqual(result.roadmap.topics[0].id, 'T-01');
    assert.strictEqual(result.roadmap.topics[1].title, 'Docker Fundamentals');
    assert.deepStrictEqual(result.roadmap.topics[1].depends_on, ['T-01']);
  });

  test('normalizes dependency aliases at the parse boundary', () => {
    const result = parseRoadmapContent(`topics:
  - id: T-01
    title: Foundations
    path: foundations.md
    depends_on: "T-a, T-b"
    dependencies: [T-b, T-c]
  - id: T-02
    title: Independent
    path: independent.md
`, 'roadmap.yaml');

    assert.ok(result.roadmap);
    assert.deepStrictEqual(result.roadmap.topics[0].depends_on, ['T-a', 'T-b', 'T-c']);
    assert.ok(!('dependencies' in result.roadmap.topics[0]));
    assert.strictEqual(result.roadmap.topics[1].depends_on, undefined);
  });

  test('parses YAML frontmatter in Markdown files', () => {
    const mdFrontmatter = `---
roadmap_id: R-k8s
title: Kubernetes 30-Day Guide
topics:
  - id: T-k8s-01
    title: Pod Lifecycle
    path: k8s/pod.md
    difficulty: beginner
  - id: T-k8s-02
    title: Deployments
    path: k8s/deploy.md
    difficulty: intermediate
    depends_on: [T-k8s-01]
---

# Kubernetes Architecture Guide

This is an introduction to Kubernetes.
`;
    const result = parseRoadmapContent(mdFrontmatter, 'guide.md');
    assert.strictEqual(result.format, 'frontmatter');
    assert.ok(result.roadmap);
    assert.strictEqual(result.roadmap.topics.length, 2);
    assert.strictEqual(result.roadmap.topics[0].id, 'T-k8s-01');
    assert.strictEqual(result.roadmap.topics[1].title, 'Deployments');
  });

  test('parses embedded YAML code block in Markdown files', () => {
    const mdCodeBlock = `# Rust Systems Programming Roadmap

Here is the learning roadmap:

\`\`\`yaml
roadmap_id: R-rust
topics:
  - id: T-rust-01
    title: Ownership and Borrowing
    path: rust/ownership.md
    difficulty: intermediate
  - id: T-rust-02
    title: Lifetimes
    path: rust/lifetimes.md
    difficulty: advanced
    depends_on: [T-rust-01]
\`\`\`

## Notes
Remember to practice each concept!
`;
    const result = parseRoadmapContent(mdCodeBlock, 'rust-roadmap.md');
    assert.strictEqual(result.format, 'codeblock');
    assert.ok(result.roadmap);
    assert.strictEqual(result.roadmap.topics.length, 2);
    assert.strictEqual(result.roadmap.topics[0].id, 'T-rust-01');
    assert.strictEqual(result.roadmap.topics[1].title, 'Lifetimes');
  });

  test('extracts the correct code block when multiple code fences are present', () => {
    const multiFence = `# Multi-Block Roadmap

Example bash command:
\`\`\`bash
echo "hello world"
\`\`\`

Actual Curriculum:
\`\`\`yaml
topics:
  - id: T-py-01
    title: Python Generators
    path: python/generators.md
    difficulty: intermediate
\`\`\`
`;
    const result = parseRoadmapContent(multiFence, 'python.md');
    assert.strictEqual(result.format, 'codeblock');
    assert.ok(result.roadmap);
    assert.strictEqual(result.roadmap.topics.length, 1);
    assert.strictEqual(result.roadmap.topics[0].id, 'T-py-01');
  });

  test('returns clear error when no topics array is found in Markdown', () => {
    const invalidMd = `# Just a regular note without a roadmap
Some random content.
`;
    const result = parseRoadmapContent(invalidMd, 'note.md');
    assert.strictEqual(result.roadmap, null);
    assert.ok(result.error);
    assert.match(result.error, /Roadmap must have a "topics" array/);
    assert.match(result.error, /Markdown Frontmatter/);
    assert.match(result.error, /Markdown YAML Code Block/);
  });

  test('parses code blocks with trailing whitespace and info-strings', () => {
    const mdWithExtra = `# Info String Roadmap

\`\`\`yaml   title="DevOps"
topics:
  - id: T-info-01
    title: Info String Parsing
    path: info.md
\`\`\`
`;
    const result = parseRoadmapContent(mdWithExtra, 'info.md');
    assert.strictEqual(result.format, 'codeblock');
    assert.ok(result.roadmap);
    assert.strictEqual(result.roadmap.topics.length, 1);
    assert.strictEqual(result.roadmap.topics[0].id, 'T-info-01');
  });

  test('returns clear error when frontmatter has invalid YAML syntax', () => {
    const invalidFm = `---
topics: [broken yaml
---

# Title
`;
    const result = parseRoadmapContent(invalidFm, 'broken-fm.md');
    assert.strictEqual(result.roadmap, null);
    assert.ok(result.error);
    assert.match(result.error, /Invalid frontmatter YAML/);
  });

  test('returns clear error for invalid pure YAML syntax', () => {
    const brokenYaml = `
topics:
  - id: T-01
    title: [broken indentation
`;
    const result = parseRoadmapContent(brokenYaml, 'broken.yaml');
    assert.strictEqual(result.roadmap, null);
    assert.ok(result.error);
    assert.match(result.error, /Invalid YAML/);
  });

  test('returns structured error diagnostic when frontmatter topic entry is null or non-object', () => {
    const nullTopicFm = `---
topics:
  -
  - id: T-valid
    title: Valid
---
# Notes
`;
    const result = parseRoadmapContent(nullTopicFm, 'null-topic.md');
    assert.strictEqual(result.roadmap, null);
    assert.ok(result.error);
    assert.match(result.error, /Invalid topic at index 0: expected topic object, received null/);
  });

  test('returns structured error diagnostic when YAML topic entry is primitive or array', () => {
    const primitiveResult = parseRoadmapContent(`
topics:
  - "string-instead-of-object"
`, 'primitive.yaml');
    assert.strictEqual(primitiveResult.roadmap, null);
    assert.match(primitiveResult.error ?? '', /Invalid topic at index 0: expected topic object, received string/);

    const arrayResult = parseRoadmapContent(`
topics:
  - [nested, array]
`, 'array.yaml');
    assert.strictEqual(arrayResult.roadmap, null);
    assert.match(arrayResult.error ?? '', /Invalid topic at index 0: expected topic object, received array/);
  });

  test('returns a structured topic error from an invalid YAML code block', () => {
    const result = parseRoadmapContent(`# Invalid Roadmap

\`\`\`yaml
topics:
  - null
\`\`\`
`, 'invalid-codeblock.md');

    assert.strictEqual(result.roadmap, null);
    assert.match(result.error ?? '', /Invalid topic at index 0: expected topic object, received null/);
  });
});

describe('Roadmap Wikilink Format (Issue #73, INV-48)', () => {
  test('detects wikilink sections as the fourth format', () => {
    const result = parseRoadmapContent(
      '---\npalee_roadmap: true\n---\n# Study Roadmap\n\n## Foundations Track\n\n- [[MODULES/01-foundations/01-systems]]\n- [[Beta|Beta Alias]]\n\n## Advanced Track\n\n1. [[gamma#intro]]\n',
      'roadmap.md'
    );
    assert.strictEqual(result.format, 'wikilink');
    assert.strictEqual(result.roadmap, null);
    assert.ok(result.sections);
    assert.strictEqual(result.sections.length, 2);
    assert.strictEqual(result.sections[0].track, 'Foundations Track');
    assert.deepStrictEqual(
      result.sections[0].links.map((l) => l.target),
      ['MODULES/01-foundations/01-systems', 'Beta']
    );
    assert.strictEqual(result.sections[0].links[1].alias, 'Beta Alias');
    // Anchors are stripped at parse time
    assert.strictEqual(result.sections[1].links[0].target, 'gamma');
  });

  test('ignores wikilinks inside fenced code blocks', () => {
    const result = parseRoadmapContent(
      '---\npalee_roadmap: true\n---\n# Roadmap\n\n```md\n- [[not-a-link]]\n```\n\n## Real\n\n- [[actual]]\n',
      'roadmap.md'
    );
    assert.strictEqual(result.format, 'wikilink');
    assert.deepStrictEqual(
      (result.sections ?? []).flatMap((s) => s.links.map((l) => l.target)),
      ['actual']
    );
  });

  test('collects bullets before any heading and returns null without lists', () => {
    const noHeading = parseRoadmapContent('---\npalee_roadmap: true\n---\n- [[solo]]\n- [[duo]]\n', 'roadmap.md');
    assert.strictEqual(noHeading.format, 'wikilink');
    assert.strictEqual(noHeading.sections?.length, 1);
    assert.strictEqual(noHeading.sections?.[0].track, '');

    const noLists = parseRoadmapContent('# Just prose\n\nNothing to see here.\n', 'roadmap.md');
    assert.strictEqual(noLists.format, undefined);
    assert.strictEqual(noLists.roadmap, null);
    assert.match(noLists.error ?? '', /Roadmap must have a "topics" array/);
  });

  test('does not claim the wikilink format for YAML files', () => {
    const result = parseRoadmapContent('- [[solo]]\n', 'roadmap.yaml');
    assert.notStrictEqual(result.format, 'wikilink');
  });

  // Regression for #73 auto-fix: the wikilink format must be opt-in. An ordinary
  // Obsidian note has a heading and `[[links]]` too, and importing one rewrote
  // depends_on on every note it pointed at.
  test('rejects an ordinary note that has a heading and wikilink bullets', () => {
    const result = parseRoadmapContent(
      '# Daily log\n\n- reviewed [[MODULES/beta]] today\n- recap [[MODULES/alpha]]\n',
      'daily-log.md'
    );
    assert.strictEqual(result.format, undefined);
    assert.strictEqual(result.sections, undefined);
    assert.strictEqual(typeof result.error, 'string');
    assert.ok((result.error ?? '').length > 0, 'expected a non-empty error diagnostic');
  });

  test('detects the wikilink format when the document declares palee_roadmap: true', () => {
    const result = parseRoadmapContent(
      '---\npalee_roadmap: true\n---\n# Daily log\n\n- reviewed [[MODULES/beta]] today\n- recap [[MODULES/alpha]]\n',
      'daily-log.md'
    );
    assert.strictEqual(result.format, 'wikilink');
    assert.deepStrictEqual(
      (result.sections ?? []).flatMap((s) => s.links.map((l) => l.target)),
      ['MODULES/beta', 'MODULES/alpha']
    );
  });

  test('names the marker when a marked document has no wikilink list items', () => {
    const result = parseRoadmapContent('---\npalee_roadmap: true\n---\n# Notes\n\nprose only\n', 'notes.md');
    assert.notStrictEqual(result.format, 'wikilink');
    assert.strictEqual(result.sections, undefined);
    assert.match(result.error ?? '', /palee_roadmap: true/);
    assert.match(result.error ?? '', /no wikilink list items/);
  });

  test('frontmatter topics: still wins over the palee_roadmap marker', () => {
    const result = parseRoadmapContent(
      '---\npalee_roadmap: true\ntopics:\n  - id: T-1\n    title: One\n    path: one.md\n---\n',
      'roadmap.md'
    );
    assert.strictEqual(result.format, 'frontmatter');
    assert.strictEqual(result.roadmap?.topics.length, 1);
    assert.strictEqual(result.roadmap?.topics[0].id, 'T-1');
  });
});
