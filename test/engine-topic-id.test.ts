import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isValidTopicId,
  generateTopicId,
  SUPPORTED_SCHEMA_VERSION,
  ALLOWED_TOPIC_STATUSES,
} from '../src/engine/topic-id';

describe('topic-id policy constants (Issue #382)', () => {
  test('SUPPORTED_SCHEMA_VERSION is Phase 1 schema version 1', () => {
    assert.strictEqual(SUPPORTED_SCHEMA_VERSION, 1);
  });

  test('ALLOWED_TOPIC_STATUSES enumerates the four lifecycle statuses', () => {
    assert.deepStrictEqual(
      [...ALLOWED_TOPIC_STATUSES],
      ['not_started', 'learning', 'paused', 'archived']
    );
  });
});

describe('isValidTopicId (Issue #382)', () => {
  const valid: string[] = [
    'T-git-rebase',
    'T-20260830-120000-a1b2c3d4', // adopt's canonical format
    'T-a',
    'T-topic-1',
    'T-20260830T120000-a1b2c3d4', // legacy adopt format
  ];
  for (const id of valid) {
    test(`accepts ${id}`, () => {
      assert.strictEqual(isValidTopicId(id), true);
    });
  }

  const invalid: Array<{ value: unknown; why: string }> = [
    { value: 'git_rebase', why: 'no T- prefix and uses underscore' },
    { value: 'T-', why: 'empty slug' },
    { value: 'T-Git-Rebase', why: 'uppercase letters are not allowed' },
    { value: 'T-git--rebase', why: 'empty kebab segment' },
    { value: 'T-git-', why: 'trailing hyphen leaves empty segment' },
    { value: 'topic-1', why: 'missing T- prefix' },
    { value: 'T-20260830T120000-A1B2C3D4', why: 'legacy hex must be lowercase' },
    { value: '', why: 'empty string' },
    { value: 42, why: 'non-string input' },
    { value: null, why: 'null input' },
    { value: undefined, why: 'undefined input' },
  ];
  for (const { value, why } of invalid) {
    test(`rejects ${JSON.stringify(value)} (${why})`, () => {
      assert.strictEqual(isValidTopicId(value), false);
    });
  }
});

describe('generateTopicId (Issue #382)', () => {
  test('produces an ID the policy accepts', () => {
    const id = generateTopicId();
    assert.strictEqual(isValidTopicId(id), true);
  });

  test('matches the T-YYYYMMDD-HHMMSS-XXXXXXXX shape with an 8-hex suffix', () => {
    const id = generateTopicId();
    assert.match(id, /^T-\d{8}-\d{6}-[a-f0-9]{8}$/);
  });

  test('generates distinct IDs across calls (random suffix)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTopicId()));
    // The 32-bit random suffix makes collisions within a tiny batch effectively impossible.
    assert.strictEqual(ids.size, 50);
  });
});
