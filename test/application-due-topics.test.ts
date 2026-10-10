import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeDueDate, compareDue, partitionDue } from '../src/application/due-topics';

describe('normalizeDueDate', () => {
  test('returns null for absent/empty values', () => {
    assert.strictEqual(normalizeDueDate(null), null);
    assert.strictEqual(normalizeDueDate(undefined), null);
    assert.strictEqual(normalizeDueDate(''), null);
  });

  test('returns null for unparseable date strings', () => {
    assert.strictEqual(normalizeDueDate('not-a-date'), null);
  });

  test('parses an ISO string to the matching instant', () => {
    const d = normalizeDueDate('2026-01-15');
    assert.ok(d instanceof Date);
    assert.strictEqual(d!.toISOString(), new Date('2026-01-15').toISOString());
  });

  test('passes a valid Date through, rejects an Invalid Date', () => {
    const valid = new Date('2026-03-01');
    assert.strictEqual(normalizeDueDate(valid), valid);
    assert.strictEqual(normalizeDueDate(new Date('garbage')), null);
  });
});

describe('compareDue', () => {
  const early = new Date('2026-01-01');
  const late = new Date('2026-06-01');

  test('orders never-scheduled (null) ahead of any date', () => {
    assert.ok(compareDue(null, early) < 0);
    assert.ok(compareDue(early, null) > 0);
    assert.strictEqual(compareDue(null, null), 0);
  });

  test('orders by oldest date first', () => {
    assert.ok(compareDue(early, late) < 0);
    assert.ok(compareDue(late, early) > 0);
    assert.strictEqual(compareDue(early, new Date(early.getTime())), 0);
  });

  test('sorts a mixed list null-first then ascending', () => {
    const dates = [late, null, early];
    const sorted = dates.slice().sort(compareDue);
    assert.deepStrictEqual(sorted, [null, early, late]);
  });
});

describe('partitionDue', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const id = (x: { id: string }) => x.id;
  const mk = (idv: string, due: Date | null) => ({ id: idv, due });

  test('splits elapsed reviews from never-reviewed, dropping future-due', () => {
    const items = [
      mk('past', new Date('2026-04-01')),
      mk('new', null),
      mk('future', new Date('2026-12-01')),
      mk('today', now),
    ];
    const { dueReviews, neverReviewed } = partitionDue(items, now, (i) => i.due);
    assert.deepStrictEqual(dueReviews.map(id), ['past', 'today']);
    assert.deepStrictEqual(neverReviewed.map(id), ['new']);
  });

  test('preserves input order within each bucket', () => {
    const items = [
      mk('a', null),
      mk('b', new Date('2026-04-10')),
      mk('c', null),
      mk('d', new Date('2026-04-05')),
    ];
    const { dueReviews, neverReviewed } = partitionDue(items, now, (i) => i.due);
    assert.deepStrictEqual(neverReviewed.map(id), ['a', 'c']);
    assert.deepStrictEqual(dueReviews.map(id), ['b', 'd']);
  });

  test('a due date exactly equal to now counts as due', () => {
    const { dueReviews } = partitionDue([mk('x', now)], now, (i) => i.due);
    assert.deepStrictEqual(dueReviews.map(id), ['x']);
  });

  test('empty input yields empty buckets', () => {
    const { dueReviews, neverReviewed } = partitionDue([], now, (i: { due: Date | null }) => i.due);
    assert.deepStrictEqual(dueReviews, []);
    assert.deepStrictEqual(neverReviewed, []);
  });
});
