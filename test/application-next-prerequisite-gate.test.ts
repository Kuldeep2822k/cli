import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getNextTopics } from '../src/application/get-next-topics';
import type { LoadedTopic } from '../src/storage';

/**
 * Unit surface for the prerequisite gate inside the `next` use-case (#305), the
 * set `plan` must dedupe against (#306) and the set `dashboard` must draw
 * `next_review` from (#307 residue). `getNextTopics` is the only place the gate
 * is computed, so every rule below is asserted through its result.
 */
function topic(partial: Partial<LoadedTopic> & { palee_id: string }): LoadedTopic {
  return {
    palee_id: partial.palee_id,
    title: partial.title ?? partial.palee_id,
    path: partial.path ?? `${partial.palee_id}.md`,
    topic_mastery: partial.topic_mastery ?? 0,
    repetition: partial.repetition ?? 0,
    difficulty: partial.difficulty ?? 'intermediate',
    due_at: partial.due_at ?? null,
    depends_on: partial.depends_on ?? [],
    depends_on_source: partial.depends_on_source,
    status: partial.status ?? 'not_started',
  } as LoadedTopic;
}

const now = new Date('2026-05-01T00:00:00.000Z');

describe('getNextTopics prerequisite gate (#305)', () => {
  test('a topic behind an unmet prerequisite is not actionable but is reported blocked', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-aa', title: 'BlockedChild', depends_on: ['T-bb'] }),
        topic({ palee_id: 'T-bb', title: 'RootPrereq' }),
      ],
      now
    );

    assert.ok(Array.isArray(result.blockedTopics), 'the result must expose the gated topics as blockedTopics');
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-bb']);
    assert.strictEqual(result.totalTopics, 2, 'blocked topics are still loaded topics');
    assert.deepStrictEqual(result.blockedTopics.map((b) => b.id), ['T-aa']);
    assert.deepStrictEqual(result.blockedTopics[0].waiting_on, [
      'RootPrereq (T-bb) at mastery 0.0000, needs 0.70',
    ], 'the blocker is named with its mastery against the single-source threshold');
    assert.strictEqual(result.blockedTopics[0].mastery, 0);
    assert.strictEqual(result.blockedTopics[0].path, 'T-aa.md');
  });

  test('never-reviewed-first then oldest-due ordering survives inside the ready set', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-dated', due_at: '2026-04-15' }),
        topic({ palee_id: 'T-new' }),
        topic({ palee_id: 'T-older', due_at: '2026-03-01' }),
        topic({ palee_id: 'T-gated', depends_on: ['T-dated'] }),
      ],
      now
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-new', 'T-older', 'T-dated']);
    assert.deepStrictEqual(result.blockedTopics.map((b) => b.id), ['T-gated']);
  });

  test('a topic already at or above the threshold is never gated — reviews of learned notes still run', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-mastered', topic_mastery: 0.9, due_at: '2026-04-01', depends_on: ['T-weak'] }),
        topic({ palee_id: 'T-weak', topic_mastery: 0.1, due_at: '2099-01-01' }),
      ],
      now
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-mastered']);
    assert.deepStrictEqual(result.blockedTopics, []);
  });

  test('a missing prerequisite blocks and is worded as a dangling reference (INV-24)', () => {
    const result = getNextTopics([topic({ palee_id: 'T-aa', depends_on: ['T-ghost'] })], now);
    assert.deepStrictEqual(result.dueTopics, []);
    assert.deepStrictEqual(result.blockedTopics[0].waiting_on, [
      'T-ghost is not in the vault (run palee validate)',
    ]);
  });

  test('advisory edges (toc/tie) never gate, exactly as in the engine (INV-47)', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-child', depends_on: ['T-parent'], depends_on_source: 'toc' }),
        topic({ palee_id: 'T-parent', topic_mastery: 0 }),
      ],
      now
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-child', 'T-parent']);
    assert.deepStrictEqual(result.blockedTopics, []);
  });

  test('the gate reads the whole graph, so a mastered archived prerequisite still satisfies its dependents', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-arch', topic_mastery: 0.9, status: 'archived' }),
        topic({ palee_id: 'T-child', topic_mastery: 0.1, depends_on: ['T-arch'] }),
      ],
      now
    );
    assert.ok(result.dueTopics.some((t) => t.id === 'T-child'), 'dropping the archived node would read as a missing dependency');
    assert.deepStrictEqual(result.blockedTopics, []);
  });

  test('quarantined cycle members are not reported as prerequisite-blocked (INV-25)', () => {
    // A topic on a cycle has no defined learning order, so the gate is
    // undefined: `plan` keeps such a note in Reviews Due (its SM-2 state is
    // real) and reports it under Quarantined Cycles instead. `next` must not
    // disagree by silently withholding it.
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-a', depends_on: ['T-b'] }),
        topic({ palee_id: 'T-b', depends_on: ['T-a'] }),
        topic({ palee_id: 'T-free' }),
      ],
      now
    );
    // Insertion order survives: all three are never-reviewed, so the comparator
    // is a tie and the stable sort keeps the loaded order.
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-a', 'T-b', 'T-free']);
    assert.deepStrictEqual(result.blockedTopics, []);
  });

  test('an archived dependent of an unmastered prerequisite is not reported blocked', () => {
    const result = getNextTopics(
      [
        topic({ palee_id: 'T-root' }),
        topic({ palee_id: 'T-arch', status: 'archived', depends_on: ['T-root'] }),
      ],
      now
    );
    assert.deepStrictEqual(result.blockedTopics, []);
  });

  test('topics scheduled in the future are neither actionable nor blocked', () => {
    const result = getNextTopics(
      [topic({ palee_id: 'T-later', due_at: '2099-01-01', depends_on: ['T-root'] }), topic({ palee_id: 'T-root' })],
      now
    );
    assert.deepStrictEqual(result.dueTopics.map((t) => t.id), ['T-root']);
    assert.deepStrictEqual(result.blockedTopics, [], 'nothing is due for T-later, so nothing is withheld');
  });

  test('an empty vault reports both lists empty', () => {
    const result = getNextTopics([], now);
    assert.deepStrictEqual(result.dueTopics, []);
    assert.deepStrictEqual(result.blockedTopics, []);
    assert.strictEqual(result.totalTopics, 0);
  });
});
