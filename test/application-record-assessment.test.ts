import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  buildAssessmentUpdate,
  assessmentAvailabilityDiff,
  Pillar,
} from '../src/application/record-assessment';
import type { TopicNode } from '../src/types';

const assessedAt = new Date('2026-05-01T12:00:00.000Z');
const parsed = (entries: Partial<Record<Pillar, number>>) =>
  new Map(Object.entries(entries) as [Pillar, number][]);

describe('buildAssessmentUpdate', () => {
  test('supplied pillars drive mastery and only they are written back', () => {
    const r = buildAssessmentUpdate({}, parsed({ conceptual: 0.8 }), assessedAt);
    assert.ok(r.ok);
    assert.strictEqual(r.value.scores.conceptual, 0.8);
    assert.strictEqual(r.value.scores.practical, 0);
    assert.strictEqual(r.value.updates.conceptual, 0.8);
    assert.strictEqual(r.value.updates.assessed_at, assessedAt.toISOString());
    assert.ok(!('practical' in r.value.updates));
    assert.strictEqual(typeof r.value.updates.topic_mastery, 'number');
  });

  test('a stored pillar feeds mastery but is not rewritten', () => {
    const r = buildAssessmentUpdate({ practical: 0.5 }, parsed({}), assessedAt);
    assert.ok(r.ok);
    assert.strictEqual(r.value.scores.practical, 0.5);
    assert.ok(!('practical' in r.value.updates));
  });

  test('an out-of-range stored pillar is an error, not a clamp', () => {
    const r = buildAssessmentUpdate({ debug: 2 }, parsed({}), assessedAt);
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.match(r.error, /debug/);
  });

  test('a supplied pillar overrides a corrupt stored value without erroring', () => {
    const r = buildAssessmentUpdate({ debug: 2 }, parsed({ debug: 0.9 }), assessedAt);
    assert.ok(r.ok);
    assert.strictEqual(r.value.scores.debug, 0.9);
  });

  test('previousMastery is read from the stored topic_mastery', () => {
    const r = buildAssessmentUpdate({ topic_mastery: 0.42 }, parsed({ feynman: 1 }), assessedAt);
    assert.ok(r.ok);
    assert.strictEqual(r.value.previousMastery, 0.42);
  });
});

describe('assessmentAvailabilityDiff', () => {
  const topic = (p: Partial<TopicNode> & { palee_id: string }): TopicNode =>
    ({ topic_mastery: 0, status: 'not_started', ...p }) as TopicNode;

  test('mastering a prerequisite unlocks its dependent and excludes the assessed topic', () => {
    const topics = [
      topic({ palee_id: 'A' }),
      topic({ palee_id: 'B', depends_on: ['A'] }),
    ];
    const { unlocked, newlyBlocked } = assessmentAvailabilityDiff(topics, 'A', 0, 0.9);
    assert.deepStrictEqual(unlocked, ['B']);
    assert.deepStrictEqual(newlyBlocked, []);
    assert.ok(!unlocked.includes('A'));
  });
});
