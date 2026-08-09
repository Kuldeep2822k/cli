import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeMastery, isAnomalousAssessment } from '../src/engine/mastery';

describe('Mastery Calculation', () => {
  test('validates scores are numbers', () => {
    assert.throws(
      () => computeMastery({ conceptual: '0.5' as any, practical: 0.5, debug: 0.5, feynman: 0.5 }),
      /must be a number/
    );
  });

  test('validates scores are in range 0.0-1.0', () => {
    assert.throws(
      () => computeMastery({ conceptual: 1.5, practical: 0.5, debug: 0.5, feynman: 0.5 }),
      /between 0.0 and 1.0/
    );
    assert.throws(
      () => computeMastery({ conceptual: -0.1, practical: 0.5, debug: 0.5, feynman: 0.5 }),
      /between 0.0 and 1.0/
    );
  });

  test('uses feynman-weighted formula (c+p+d+f*2)/5', () => {
    const mastery = computeMastery({
      conceptual: 0.8,
      practical: 0.7,
      debug: 0.6,
      feynman: 0.9,
    });
    const expected = (0.8 + 0.7 + 0.6 + 0.9 * 2) / 5;
    assert.strictEqual(mastery, Number(expected.toFixed(4)));
  });

  test('rounds to 4 decimal places', () => {
    const mastery = computeMastery({
      conceptual: 0.33333,
      practical: 0.66666,
      debug: 0.12345,
      feynman: 0.98765,
    });
    const decimals = mastery.toString().split('.')[1] || '';
    assert.ok(decimals.length <= 4);
  });

  test('feynman weight doubles its contribution', () => {
    const mastery1 = computeMastery({
      conceptual: 1.0,
      practical: 1.0,
      debug: 1.0,
      feynman: 0.0,
    });
    // (1 + 1 + 1 + 0*2) / 5 = 3/5 = 0.6
    assert.strictEqual(mastery1, 0.6);

    const mastery2 = computeMastery({
      conceptual: 1.0,
      practical: 1.0,
      debug: 1.0,
      feynman: 1.0,
    });
    // (1 + 1 + 1 + 1*2) / 5 = 5/5 = 1.0
    assert.strictEqual(mastery2, 1.0);
  });
});

describe('Anomaly Detection', () => {
  test('first assessments are never anomalous', () => {
    const current = {
      assessed_at: new Date().toISOString(),
      conceptual: 0.9,
      practical: 0.9,
      debug: 0.9,
      feynman: 0.9,
    };
    const previous = null;

    assert.strictEqual(isAnomalousAssessment(current, previous), false);
  });

  test('assessments without prior assessed_at are never anomalous', () => {
    const current = {
      assessed_at: new Date().toISOString(),
      conceptual: 0.9,
      practical: 0.9,
      debug: 0.9,
      feynman: 0.9,
    };
    const previous = {
      conceptual: 0.1,
      practical: 0.1,
      debug: 0.1,
      feynman: 0.1,
      // No assessed_at field
    };

    assert.strictEqual(isAnomalousAssessment(current, previous), false);
  });

  test('flags not raised if previous scores <= 0.10 (not established)', () => {
    const now = new Date();
    const current = {
      assessed_at: now.toISOString(),
      conceptual: 0.9,
      practical: 0.9,
      debug: 0.9,
      feynman: 0.9,
    };
    const previous = {
      assessed_at: new Date(now.getTime() - 60000).toISOString(), // 1 min ago
      conceptual: 0.05, // Not established
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };

    assert.strictEqual(isAnomalousAssessment(current, previous), false);
  });

  test('flags not raised if time window > 10 minutes', () => {
    const now = new Date();
    const elevenMinutesAgo = new Date(now.getTime() - 11 * 60 * 1000);
    const current = {
      assessed_at: now.toISOString(),
      conceptual: 0.9,
      practical: 0.9,
      debug: 0.9,
      feynman: 0.9,
    };
    const previous = {
      assessed_at: elevenMinutesAgo.toISOString(),
      conceptual: 0.2,
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };

    assert.strictEqual(isAnomalousAssessment(current, previous), false);
  });

  test('flags raised if individual score increases > 0.40 within 10 minutes', () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const current = {
      assessed_at: now.toISOString(),
      conceptual: 0.95, // +0.75 jump
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };
    const previous = {
      assessed_at: fiveMinutesAgo.toISOString(),
      conceptual: 0.2,
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };

    assert.strictEqual(isAnomalousAssessment(current, previous), true);
  });

  test('flags raised if aggregate mastery increases > 0.35 within 10 minutes', () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const current = {
      assessed_at: now.toISOString(),
      conceptual: 0.6,
      practical: 0.6,
      debug: 0.6,
      feynman: 0.6,
    };
    const previous = {
      assessed_at: fiveMinutesAgo.toISOString(),
      conceptual: 0.2,
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };

    const prevMastery = computeMastery(previous); // 0.2
    const currMastery = computeMastery(current); // 0.6
    const delta = currMastery - prevMastery; // 0.4

    assert.ok(delta > 0.35);
    assert.strictEqual(isAnomalousAssessment(current, previous), true);
  });

  test('no flag if jump is moderate and within time window', () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const current = {
      assessed_at: now.toISOString(),
      conceptual: 0.5,
      practical: 0.5,
      debug: 0.5,
      feynman: 0.5,
    };
    const previous = {
      assessed_at: fiveMinutesAgo.toISOString(),
      conceptual: 0.2,
      practical: 0.2,
      debug: 0.2,
      feynman: 0.2,
    };

    // Individual deltas = 0.3 (< 0.40)
    // Aggregate delta = 0.3 (< 0.35)
    assert.strictEqual(isAnomalousAssessment(current, previous), false);
  });
});
