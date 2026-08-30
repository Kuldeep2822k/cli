import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeDueDate, formatLocalDateOnly } from '../src/engine/sm2';
import { formatDateOnly } from '../src/storage/memory';

describe('Timezone & Calendar Boundary Test Suite', () => {
  describe('Calendar Arithmetic & Leap Years', () => {
    test('leap day transition: 2028-02-28 + 1 day = 2028-02-29', () => {
      const due = computeDueDate('2028-02-28', 1);
      assert.strictEqual(due.getFullYear(), 2028);
      assert.strictEqual(due.getMonth(), 1); // February = index 1
      assert.strictEqual(due.getDate(), 29);
    });

    test('leap day rollover: 2028-02-29 + 1 day = 2028-03-01', () => {
      const due = computeDueDate('2028-02-29', 1);
      assert.strictEqual(due.getFullYear(), 2028);
      assert.strictEqual(due.getMonth(), 2); // March = index 2
      assert.strictEqual(due.getDate(), 1);
    });

    test('non-leap year transition: 2025-02-28 + 1 day = 2025-03-01', () => {
      const due = computeDueDate('2025-02-28', 1);
      assert.strictEqual(due.getFullYear(), 2025);
      assert.strictEqual(due.getMonth(), 2); // March
      assert.strictEqual(due.getDate(), 1);
    });

    test('end-of-year transition: 2026-12-31 + 1 day = 2027-01-01', () => {
      const due = computeDueDate('2026-12-31', 1);
      assert.strictEqual(due.getFullYear(), 2027);
      assert.strictEqual(due.getMonth(), 0); // January
      assert.strictEqual(due.getDate(), 1);
    });

    test('end-of-month 30-day transition: 2026-04-30 + 1 day = 2026-05-01', () => {
      const due = computeDueDate('2026-04-30', 1);
      assert.strictEqual(due.getFullYear(), 2026);
      assert.strictEqual(due.getMonth(), 4); // May
      assert.strictEqual(due.getDate(), 1);
    });
  });

  describe('Century & 2-Digit Year Boundaries', () => {
    test('preserves year 0001 without 1900 offset', () => {
      const due = computeDueDate('0001-01-01', 0);
      assert.strictEqual(due.getFullYear(), 1);
      assert.strictEqual(due.getMonth(), 0);
      assert.strictEqual(due.getDate(), 1);
    });

    test('preserves year 0099 without 1900 offset', () => {
      const due = computeDueDate('0099-12-31', 1);
      assert.strictEqual(due.getFullYear(), 100);
      assert.strictEqual(due.getMonth(), 0);
      assert.strictEqual(due.getDate(), 1);
    });

    test('handles year 1999 to 2000 millennium boundary', () => {
      const due = computeDueDate('1999-12-31', 1);
      assert.strictEqual(due.getFullYear(), 2000);
      assert.strictEqual(due.getMonth(), 0);
      assert.strictEqual(due.getDate(), 1);
    });
  });

  describe('Date String Formatting Invariants', () => {
    test('formatLocalDateOnly formats local date object as YYYY-MM-DD', () => {
      const d = new Date(2026, 7, 20); // August 20, 2026
      const formatted = formatLocalDateOnly(d);
      assert.strictEqual(formatted, '2026-08-20');
    });

    test('formatDateOnly formats date object as zero-padded YYYY-MM-DD', () => {
      const d = new Date(2026, 0, 5); // January 5, 2026
      const formatted = formatDateOnly(d);
      assert.strictEqual(formatted, '2026-01-05');
    });
  });
});
