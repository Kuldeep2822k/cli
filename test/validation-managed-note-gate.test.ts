/**
 * Cross-rule managed-note eligibility gate (#324)
 *
 * Contracts under test (behavioural — exercises only the three rules, so the
 * bug reproduces against a pre-fix tree as a named assertion failure):
 * - A `palee_schema`-only note (no identity key) is NOT judged a malformed
 *   topic ID: it produces NO `valid-topic-id-format` error (INV-11 — a
 *   malformed managed note is a warning, never a vault-aborting error), yet it
 *   is surfaced EXACTLY once by `valid-managed-note-kind` as the kind warning,
 *   and it never escapes all three checks.
 * - The three "is this managed / is this a topic note?" gates agree because
 *   they share one predicate keyed on the identity key being present: normal
 *   topic notes, session notes, and index notes are classified identically.
 * - A malformed `palee_id` VALUE on an eligible topic note is STILL an error
 *   (#29 real catch — the fix removed only the schema-only false positive).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runRules } from '../src/validation/run-rules';
import { validManagedNoteKindRule } from '../src/validation/rules/valid-managed-note-kind';
import { validPaleeSchemaRule } from '../src/validation/rules/valid-palee-schema';
import { validTopicIdFormatRule } from '../src/validation/rules/valid-topic-id-format';
import type { ValidationContext } from '../src/validation/types';
import type { ScannedNote } from '../src/types';

/**
 * The three managed-note gates in catalog order (kind -> schema -> id-format).
 * Running them together is what proves they can no longer disagree.
 */
const GATE_RULES = [validManagedNoteKindRule, validPaleeSchemaRule, validTopicIdFormatRule];

function makeNote(frontmatter: Record<string, unknown> | null): ScannedNote {
  return { absolutePath: '/vault/n.md', relativePath: 'n.md', frontmatter };
}

function makeContext(notes: ScannedNote[]): ValidationContext {
  return {
    vaultPath: '/vault',
    files: [],
    topics: [],
    notes,
    memoryReadErrors: [],
    readIncomplete: false,
    sessions: [],
    sessionIndex: { state: 'missing', refs: null },
    hotMemory: { state: 'missing', frontmatter: null, body: '' },
  };
}

/** Runs all three gates over one frontmatter snapshot and returns the issues. */
function gateIssues(frontmatter: Record<string, unknown>) {
  return runRules(makeContext([makeNote(frontmatter)]), GATE_RULES);
}

describe('palee_schema-only note: the #324 cross-rule contract', () => {
  test('surfaces exactly once — kind warning only, NO id-format error, nothing missing', () => {
    const issues = gateIssues({ palee_schema: 1, title: 'No ID' });

    // The exact issue set: one warning from the kind rule and nothing else.
    // In a pre-fix tree the id-format gate adds an error, so this is the
    // named assertion that goes red on #324.
    assert.strictEqual(issues.length, 1, 'a schema-only note must be surfaced exactly once');

    const [issue] = issues;
    assert.strictEqual(issue.ruleId, 'valid-managed-note-kind');
    assert.strictEqual(issue.severity, 'warning', 'the false-positive error must not remain');
    assert.strictEqual(issue.field, 'palee_schema');

    // Explicit negative: the id-format false positive is gone (INV-11 — a
    // malformed managed note is a warning, never a vault-aborting error).
    assert.ok(
      !issues.some((i) => i.ruleId === 'valid-topic-id-format'),
      'a schema-only note must never raise the topic-id-format error'
    );
    assert.ok(
      !issues.some((i) => i.severity === 'error'),
      'no gate may emit an error for a note with no identity key'
    );
  });

  test('no note escapes all three gates, but a user note is not managed', () => {
    // A schema-only note IS in scope (the kind warning above); a plain user
    // note with no schema marker and no identity is correctly reported by
    // NONE of the three gates.
    assert.strictEqual(gateIssues({ title: 'just a note' }).length, 0);
    assert.strictEqual(gateIssues({ palee_schema: 1 }).length, 1);
  });
});

describe('the three gates agree on eligibility', () => {
  test('normal topic note: every gate treats it as a clean topic — no findings', () => {
    assert.deepStrictEqual(gateIssues({ palee_schema: 1, palee_id: 'T-git-rebase' }), []);
  });

  test('session note: managed, but never judged a topic ID — no findings', () => {
    assert.deepStrictEqual(gateIssues({ palee_schema: 1, session_id: 'S-20260912T100000-abcd' }), []);
  });

  test('index note: managed, but never judged a topic ID — no findings', () => {
    assert.deepStrictEqual(gateIssues({ palee_schema: 1, type: 'session_index' }), []);
  });

  test('schema-only note: the kind gate owns it, schema and id-format stay silent', () => {
    const fm = { palee_schema: 1, title: 'No ID' };
    // Only the kind rule reports (a warning); the schema and id-format rules
    // stay silent because there is no identity key to validate. In a pre-fix
    // tree the id-format rule breaks this named assertion.
    assert.deepStrictEqual(validPaleeSchemaRule.run(makeContext([makeNote(fm)])), []);
    assert.deepStrictEqual(validTopicIdFormatRule.run(makeContext([makeNote(fm)])), []);
    const kind = validManagedNoteKindRule.run(makeContext([makeNote(fm)]));
    assert.strictEqual(kind.length, 1);
    assert.strictEqual(kind[0].ruleId, 'valid-managed-note-kind');
    assert.strictEqual(kind[0].severity, 'warning');
  });
});

describe('#324 did not weaken the real #29 catch', () => {
  test('malformed palee_id on an eligible topic note is STILL an error', () => {
    const issues = gateIssues({ palee_schema: 1, palee_id: 'git_rebase' });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].ruleId, 'valid-topic-id-format');
    assert.strictEqual(issues[0].severity, 'error');
  });

  test('conflicting identities report ONE kind warning, never a topic-id error', () => {
    // palee_id + session_id claims two kinds: not a clean topic note, so the
    // id-format rule stays silent and the kind rule owns the ambiguity.
    const issues = gateIssues({ palee_schema: 1, palee_id: 'bad_id', session_id: 'S-1' });
    assert.ok(!issues.some((i) => i.ruleId === 'valid-topic-id-format'));
    assert.strictEqual(issues.filter((i) => i.ruleId === 'valid-managed-note-kind').length, 1);
  });
});
