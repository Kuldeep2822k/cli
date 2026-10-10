import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getNextTopics } from '../src/application/get-next-topics';
import type { LoadedTopic } from '../src/storage';

function topic(partial: Partial<LoadedTopic> & { palee_id: string }): LoadedTopic {
  return {
    palee_id: partial.palee_id,
    title: partial.title ?? partial.palee_id,
    path: partial.path ?? `${partial.palee_id}.md`,
    topic_mastery: partial.topic_mastery ?? 0,
    repetition: partial.repetition ?? 0,
    difficulty: partial.difficulty ?? 'intermediate',
    due_at: partial.due_at ?? null,
  } as LoadedTopic;
}

const now = new Date('2026-05-01T00:00:00.000Z');

describe('getNextTopics', () => {
  test('empty vault yields no due topics and zero total', () => {
    const result = getNextTopics([], now);
    assert.deepStrictEqual(result.dueTopics, []);
    assert.strictEqual(result.totalTopics, 0);
  });

  test('counts every loaded topic in totalTopics, even future-due ones', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'a', due_at: '2026-04-01' }),
        topic({ palee_id: 'future', due_at: '2026-12-01' }),
      ],
      now,
    );
    assert.strictEqual(result.totalTopics, 2);
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['a']);
  });

  test('never-reviewed topics are actionable and sort ahead of dated ones', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'dated', due_at: '2026-04-15' }),
        topic({ palee_id: 'new' }),
      ],
      now,
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['new', 'dated']);
    assert.strictEqual(result.dueTopics[0].dueAt, null);
  });

  test('dated due topics are ordered oldest-first', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'mid', due_at: '2026-04-20' }),
        topic({ palee_id: 'old', due_at: '2026-03-01' }),
        topic({ palee_id: 'recent', due_at: '2026-04-30' }),
      ],
      now,
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['old', 'mid', 'recent']);
  });

  test('invalid due_at is treated as never-reviewed (due now)', () => {
    const result = getNextTopics([topic({ palee_id: 'bad', due_at: 'not-a-date' })], now);
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['bad']);
    assert.strictEqual(result.dueTopics[0].dueAt, null);
  });

  test('future-due topics are excluded from the due list', () => {
    const result = getNextTopics([topic({ palee_id: 'later', due_at: '2026-09-01' })], now);
    assert.deepStrictEqual(result.dueTopics, []);
  });
});
