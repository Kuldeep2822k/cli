import { test, describe } from 'node:test';
import assert from 'node:assert';
import { processReview, computeDueDate, calculateEaseFactorDelta } from '../src/engine/sm2';

describe('SM-2 Algorithm', () => {
  test('quality must be integer 0-5', () => {
    assert.throws(
      () => processReview({ ease_factor: 2.5, interval_days: 1, repetition: 0 }, 6),
      /Invalid quality/
    );
    assert.throws(
      () => processReview({ ease_factor: 2.5, interval_days: 1, repetition: 0 }, -1),
      /Invalid quality/
    );
    assert.throws(
      () => processReview({ ease_factor: 2.5, interval_days: 1, repetition: 0 }, 3.5),
      /Invalid quality/
    );
  });

  test('ease_factor must be >= 1.3', () => {
    assert.throws(
      () => processReview({ ease_factor: 1.2, interval_days: 1, repetition: 0 }, 3),
      /Invalid ease_factor/
    );
  });

  test('interval_days must be >= 1', () => {
    assert.throws(
      () => processReview({ ease_factor: 2.5, interval_days: 0, repetition: 0 }, 3),
      /Invalid interval_days/
    );
  });

  test('repetition must be >= 0', () => {
    assert.throws(
      () => processReview({ ease_factor: 2.5, interval_days: 1, repetition: -1 }, 3),
      /Invalid repetition/
    );
  });

  test('quality < 3 resets repetition and interval to 1', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 10, repetition: 5 },
      2
    );
    assert.strictEqual(result.repetition, 0);
    assert.strictEqual(result.interval_days, 1);
  });

  test('first successful review (rep=0, q>=3) sets interval=1', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 1, repetition: 0 },
      3
    );
    assert.strictEqual(result.repetition, 1);
    assert.strictEqual(result.interval_days, 1);
  });

  test('second successful review (rep=1, q>=3) sets interval=6', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 1, repetition: 1 },
      4
    );
    assert.strictEqual(result.repetition, 2);
    assert.strictEqual(result.interval_days, 6);
  });

  test('third+ successful review uses interval * ease_factor', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 6, repetition: 2 },
      4
    );
    assert.strictEqual(result.repetition, 3);
    assert.strictEqual(result.interval_days, Math.round(6 * 2.5)); // 15
  });

  test('ease_factor is clamped to minimum 1.3', () => {
    // Quality 0 gives large negative delta
    const result = processReview(
      { ease_factor: 1.3, interval_days: 1, repetition: 0 },
      0
    );
    assert.ok(result.ease_factor! >= 1.3);
  });

  test('ease_factor is rounded to 4 decimals', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 1, repetition: 0 },
      4
    );
    const decimals = result.ease_factor!.toString().split('.')[1] || '';
    assert.ok(decimals.length <= 4);
  });

  test('ease_factor delta formula matches spec', () => {
    // delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
    assert.strictEqual(calculateEaseFactorDelta(5), 0.1);
    assert.strictEqual(calculateEaseFactorDelta(4), 0.0);
    // Quality 3: floating point precision issue, use closeTo
    const delta3 = calculateEaseFactorDelta(3);
    assert.ok(Math.abs(delta3 - (-0.14)) < 0.0001, `Expected close to -0.14, got ${delta3}`);
  });

  test('lapses increment on quality < 3 for established topics', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 10, repetition: 5, lapses: 2 },
      2
    );
    assert.strictEqual(result.lapses, 3);
  });

  test('lapses do not increment on first failure (repetition=0)', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 1, repetition: 0, lapses: 0 },
      2
    );
    assert.strictEqual(result.lapses, 0);
  });

  test('last_quality is recorded', () => {
    const result = processReview(
      { ease_factor: 2.5, interval_days: 1, repetition: 0 },
      4
    );
    assert.strictEqual(result.last_quality, 4);
  });

  test('computeDueDate adds calendar days', () => {
    const base = new Date('2026-01-01T12:00:00Z');
    const due = computeDueDate(base, 5);
    assert.strictEqual(due.getDate(), 6);
    assert.strictEqual(due.getMonth(), 0); // January
  });
});
