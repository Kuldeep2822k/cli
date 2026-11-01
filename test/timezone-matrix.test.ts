import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeDueDate, formatLocalDateOnly } from '../src/engine/sm2';
import { formatDateOnly } from '../src/storage/memory';
import { withoutCoverage, CLI_SPAWN_TIMEOUT_MS } from './cli-spawn-env';

const root = path.resolve(__dirname, '..');

/**
 * Runs one due-date computation in a child process under `tz`.
 *
 * @param tz - IANA zone name handed to the child through `TZ`
 * @param from - Baseline handed to `computeDueDate`: a `YYYY-MM-DD` date-only
 *   string, or a full ISO instant. Both documented input branches are covered.
 * @param days - Calendar days the engine must advance
 * @param expectedOffsetMinutes - The `getTimezoneOffset()` the child must report
 *   for `from`; asserting it is what proves `TZ` was honoured at all
 * @returns The `due_at` the child computed, as `YYYY-MM-DD`
 *
 * @remarks
 * #565 P1-11: every case in this file ran in the zone the test process happened to
 * inherit — UTC on CI — so a `getUTC*`/`toISOString` regression in the local-calendar
 * arithmetic would have passed in the one suite named for timezones. A child process is
 * used rather than mutating `process.env.TZ`, because that is process-global state this
 * file's other twenty cases share, and `--test-concurrency=4` gives each *file* a process.
 *
 * The child loads `src` through tsx rather than the built `dist` copy: a `dist` spawn
 * silently asserts against the previous build when the suite is run without `npm test`'s
 * `pretest` hook, which is a green that proves nothing. `withoutCoverage()` keeps the
 * spawn from writing coverage for a module it never instrumented (#451).
 */
function dueDateInZone(
  tz: string,
  from: string,
  days: number,
  expectedOffsetMinutes: number,
): string {
  const engine = path.join(root, 'src', 'engine', 'sm2.ts');
  const script = [
    `const { computeDueDate, formatLocalDateOnly } = require(${JSON.stringify(engine)});`,
    `const from = ${JSON.stringify(from)};`,
    `process.stdout.write(formatLocalDateOnly(computeDueDate(from, ${days})) + '|' + new Date(from).getTimezoneOffset());`,
  ].join('\n');

  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: root,
    env: { ...withoutCoverage(), TZ: tz },
    encoding: 'utf8',
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
  assert.ifError(child.error);
  assert.strictEqual(child.status, 0, child.stderr);

  // A zone name the runtime cannot resolve falls back to UTC and exits 0, so a
  // failed spawn check cannot tell "honoured" from "ignored". The offset can.
  const parts = child.stdout.trim().split('|');
  assert.strictEqual(parts.length, 2, `child output was not "<date>|<offset>": ${child.stdout}`);
  assert.strictEqual(
    Number(parts[1]),
    expectedOffsetMinutes,
    `TZ=${tz} was not honoured: the child reported a UTC offset of ${parts[1]} minutes`,
  );
  return parts[0] ?? '';
}

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

  // #565 P1-11: the suite above varies the calendar, not the zone. Each case below is one
  // input read by an engine in a different zone, so the expected string is a fact about
  // local-calendar arithmetic rather than about the runner's clock.
  //
  // The three instant cases separate local formatting from UTC formatting. The DST-jump
  // case additionally separates local *arithmetic* from UTC arithmetic; the other two do
  // not, because a 24-hour step and a calendar step agree everywhere except across a zone
  // transition. The date-only row pins the other input branch instead, and is the only one
  // that catches a `Date.UTC` construction there. Saying which row proves which class keeps
  // none of them reading as a duplicate of another.
  describe('A foreign timezone changes the answer (#565 P1-11)', () => {
    test('west of UTC: 03:30Z on 2026-03-08 is still Mar 7 locally, so +1 day is Mar 8', () => {
      // Formatting the result through UTC getters would answer 2026-03-09.
      assert.strictEqual(
        dueDateInZone('America/Los_Angeles', '2026-03-08T03:30:00Z', 1, 480),
        '2026-03-08',
      );
    });

    test('west of UTC across the DST jump: 07:30Z is 23:30 locally, so +1 calendar day is still Mar 8', () => {
      // The one case that also indicts the arithmetic: the local day it advances across is
      // 23 hours long, so `setUTCDate` and `getTime() + days*86400000` both answer
      // 2026-03-09 while the local calendar answers 2026-03-08.
      assert.strictEqual(
        dueDateInZone('America/Los_Angeles', '2026-03-08T07:30:00Z', 1, 480),
        '2026-03-08',
      );
    });

    test('east of UTC: 18:30Z on 2026-08-20 is already Aug 21 locally, so +1 day is Aug 22', () => {
      // Formatting the result through UTC getters would answer 2026-08-21.
      assert.strictEqual(
        dueDateInZone('Asia/Kolkata', '2026-08-20T18:30:00Z', 1, -330),
        '2026-08-22',
      );
    });

    test('the date-only baseline is built on the local calendar, not at UTC midnight', () => {
      // `computeDueDate` has two input branches; the date-only one is what `palee review`
      // and `--fix` reach for. Building it with `Date.UTC` instead of the local constructor
      // shifts it one day west of UTC, and on a UTC runner that is invisible.
      assert.strictEqual(dueDateInZone('America/Los_Angeles', '2028-02-28', 1, 480), '2028-02-29');
    });

    test('the same instant in UTC answers the UTC day', () => {
      // The control: same input, no shift, and the offset assertion pins that this child
      // really was in UTC. A child that ignored `TZ` would answer its own zone's day here.
      assert.strictEqual(
        dueDateInZone('UTC', '2026-08-20T18:30:00Z', 1, 0),
        '2026-08-21',
      );
    });
  });
});
