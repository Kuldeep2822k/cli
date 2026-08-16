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
});
