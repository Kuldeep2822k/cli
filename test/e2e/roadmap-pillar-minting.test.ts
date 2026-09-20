/**
 * Roadmap import must not mint assessment pillar scores (#191)
 *
 * `valid-topic-mastery` (#37) skips a topic whose four pillar keys are all
 * absent, because stored mastery predating the assessment formula is not drift
 * against it. `resolveTopicUpdates` used to resolve an absent pillar to `0.0`,
 * so a roadmap import created those keys and flipped the rule from skipping to
 * reporting — manufacturing a finding about assessment data no writer ever
 * produced, which `validate --strict` then escalated to exit 3.
 *
 * Contracts under test:
 * - Importing over a note with no pillar keys leaves them absent.
 * - Importing over a note that HAS pillars preserves their values.
 * - `validate --strict` stays clean across a roadmap import.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createTestVault } from './test-env';

describe('roadmap import does not mint assessment pillar scores (#191)', () => {
  let env: ReturnType<typeof createTestVault>;

  beforeEach(() => {
    env = createTestVault('palee-pillar-mint-');
  });

  afterEach(() => {
    env.cleanup();
  });

  const PILLARS = ['conceptual', 'practical', 'debug', 'feynman'] as const;

  /** Writes a raw note so the test controls exactly which keys exist. */
  function writeNote(
    filename: string,
    frontmatterLines: string[],
    body = 'Notes.'
  ): string {
    const fullPath = path.join(env.vaultDir, filename);
    fs.writeFileSync(
      fullPath,
      `---\n${frontmatterLines.join('\n')}\n---\n${body}\n`,
      'utf8'
    );
    return fullPath;
  }

  /** Imports a one-topic roadmap targeting `filename`. */
  function importRoadmap(id: string, filename: string, extraLines: string[] = []): void {
    const roadmapFile = path.join(env.tempDir, `${filename}-roadmap.yaml`);
    fs.writeFileSync(
      roadmapFile,
      'topics:\n' +
        `  - id: ${id}\n` +
        `    title: Curriculum Title\n` +
        `    path: ${filename}\n` +
        extraLines.join(''),
      'utf8'
    );
    const res = env.run(['roadmap', '--from', roadmapFile, '--yes']);
    assert.strictEqual(res.status, 0, `roadmap import failed: ${res.stderr}`);
  }

  test('import over a pillar-less note writes the curriculum fields and no pillars', () => {
    writeNote('legacy.md', [
      'palee_schema: 1',
      'palee_id: T-legacy',
      'title: Legacy Note',
      'topic_mastery: 0.55',
    ]);

    importRoadmap('T-legacy', 'legacy.md');

    const fm = env.readTopic('legacy.md').frontmatter as Record<string, unknown>;
    for (const pillar of PILLARS) {
      assert.ok(
        !(pillar in fm),
        `${pillar} must stay absent: the import has no assessment data to write`
      );
    }
    // The import still did its actual job.
    assert.strictEqual(fm.title, 'Curriculum Title');
    assert.strictEqual(fm.topic_mastery, 0.55, 'pre-existing mastery must be preserved');
  });

  test('import preserves pillar scores the note already carries', () => {
    writeNote('assessed.md', [
      'palee_schema: 1',
      'palee_id: T-assessed',
      'title: Assessed Note',
      'conceptual: 0.8',
      'practical: 0.7',
      'debug: 0.6',
      'feynman: 0.9',
      'assessed_at: 2026-09-01',
      'topic_mastery: 0.76',
    ]);

    importRoadmap('T-assessed', 'assessed.md');

    const fm = env.readTopic('assessed.md').frontmatter as Record<string, unknown>;
    assert.strictEqual(fm.conceptual, 0.8);
    assert.strictEqual(fm.practical, 0.7);
    assert.strictEqual(fm.debug, 0.6);
    assert.strictEqual(fm.feynman, 0.9);
    assert.strictEqual(fm.topic_mastery, 0.76);
  });

  test('importing a brand-new note leaves it pillar-less', () => {
    importRoadmap('T-fresh', 'fresh.md');

    const fm = env.readTopic('fresh.md').frontmatter as Record<string, unknown>;
    for (const pillar of PILLARS) {
      assert.ok(!(pillar in fm), `new note must not gain ${pillar}`);
    }
    // topic_mastery is still minted at 0: F8.1 pins that, and a zero default is
    // not a claim about assessment.
    assert.strictEqual(fm.topic_mastery, 0);
  });

  test('validate --strict stays clean across a roadmap import', () => {
    writeNote('strict.md', [
      'palee_schema: 1',
      'palee_id: T-strict',
      'title: Strict Note',
      'topic_mastery: 0.55',
    ]);

    importRoadmap('T-strict', 'strict.md');

    const res = env.run(['validate', '--strict', '--json']);
    const report = JSON.parse(res.stdout) as {
      valid: boolean;
      error_count: number;
      warning_count: number;
    };
    assert.strictEqual(
      res.status,
      0,
      `validate --strict exited ${res.status} on an untouched import: ${res.stdout}`
    );
    assert.strictEqual(report.warning_count, 0);
    assert.strictEqual(report.error_count, 0);
    assert.strictEqual(report.valid, true);
  });
});
