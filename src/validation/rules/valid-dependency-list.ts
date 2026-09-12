/**
 * valid-dependency-list rule (#33)
 *
 * @remarks
 * Schema-level shape validation for the canonical `depends_on` field
 * on topic notes — the gate that runs BEFORE the graph rules so they
 * receive normalized, unambiguous data. The loader's
 * `normalizeDependencies` silently coerces (string lists are
 * comma-split, non-string items are `String()`-ed, duplicates are
 * deduped), so this rule reads the RAW frontmatter value to expose
 * real defects the loader would paper over — the same
 * pre-normalization rationale as #36/#38.
 *
 * Policy (issue #33 + VERDICT Rule 8):
 * - Missing `depends_on`: treated as the empty list (adopt-default
 *   policy — adopt always writes the key, but pre-adoption notes are
 *   valid) — never reported.
 * - Explicit `null`: an empty list by the same policy — never
 *   reported. (Hand-authored `depends_on:` with no value is an
 *   explicit null; treating it as an error would fail
 *   incrementally-written vaults for no scheduling benefit.)
 * - Not an array (string, number, object, boolean): `error` — the
 *   string form especially, because the loader's comma-split makes
 *   `depends_on: T-a, T-b` indistinguishable from a single ID
 *   containing a comma.
 * - Non-string/null array items: `error` — `String(item)` coercion
 *   can silently mint dependency IDs (numbers, booleans).
 * - Empty-string items (after trim): `error` — a slot that denotes
 *   nothing but survives normalization's filter.
 * - Self-dependency: `error` — a one-node cycle the engine reports
 *   as a cycle, so the shape contract says the author made a
 *   structural mistake; the cycle rule reports the same fact as a
 *   graph finding (no double-reporting suppression: the two findings
 *   carry different rule IDs and different locator detail).
 * - Duplicate entries: `warning` (dedup is the safe fix — the loader
 *   already dedupes, so scheduling is unaffected; the note is just
 *   noisier than its meaning). Reported once per duplicated ID with the
 *   offending list. Rule-level fixability stays `manual` because only
 *   the duplicate findings are safely fixable — shape errors and
 *   self-references need a human decision.
 *
 * The legacy `dependencies` alias is NOT consulted: storage parsing
 * tolerates it defensively (normalized since #126), but the
 * canonical key is `depends_on` (#140) and the validation contract
 * checks what PALEE writes, not what it tolerates. Roadmap import
 * strips the alias on write.
 */

import type { ValidationRule, ValidationIssue } from '../types';

/**
 * Reports `depends_on` fields that are not a clean array of distinct
 * non-empty string IDs.
 */
export const validDependencyListRule: ValidationRule = {
  id: 'valid-dependency-list',
  description:
    'depends_on must be an array of non-empty string IDs without self-references or duplicates',
  severity: 'error',
  // `manual`, not `safe`: only the duplicate-entry findings are safely
  // dedupable; shape errors and self-references need a human decision
  // (what the author MEANT cannot be derived). VERDICT scopes safe-fix
  // to "safe (dedup)" — the rule-level flag must stay conservative
  // because it classifies every finding the rule reports.
  fixable: 'manual',
  run(context) {
    const issues: ValidationIssue[] = [];

    for (const topic of context.topics) {
      const raw = topic.frontmatter.depends_on;

      // Adopt-default policy: missing or null = empty list, valid.
      if (raw === undefined || raw === null) continue;

      if (!Array.isArray(raw)) {
        issues.push({
          ruleId: 'valid-dependency-list',
          severity: 'error',
          message: `Topic ${topic.palee_id}: depends_on must be an array of topic IDs, got ${JSON.stringify(raw)}`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'depends_on',
          details: { actual: raw },
        });
        continue;
      }

      // Item-level errors: non-string, null, and empty-string slots.
      for (const item of raw) {
        if (typeof item !== 'string' || item.trim() === '') {
          issues.push({
            ruleId: 'valid-dependency-list',
            severity: 'error',
            message: `Topic ${topic.palee_id}: every depends_on entry must be a non-empty topic ID string, got ${JSON.stringify(item)}`,
            file: topic.path,
            topicId: topic.palee_id,
            field: 'depends_on',
            details: { actual: item },
          });
        }
      }

      // Self-reference: structural error (one-node cycle in the graph).
      // Trim before comparing: the loader trims each entry during
      // normalization, so a padded `' T-x '` IS a self-reference the
      // engine would act on — `Array.includes` alone (strict equality)
      // would miss it.
      if (raw.some((item) => typeof item === 'string' && item.trim() === topic.palee_id)) {
        issues.push({
          ruleId: 'valid-dependency-list',
          severity: 'error',
          message: `Topic ${topic.palee_id}: depends_on must not reference the topic itself`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'depends_on',
          details: { actual: topic.palee_id },
        });
      }

      // Duplicates: warning only — normalization dedupes, so the
      // graph sees the intended list; the note is just redundant.
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const item of raw) {
        if (typeof item !== 'string') continue;
        const id = item.trim();
        if (id === '') continue;
        if (seen.has(id)) dupes.add(id);
        else seen.add(id);
      }
      for (const dup of dupes) {
        issues.push({
          ruleId: 'valid-dependency-list',
          severity: 'warning',
          message: `Topic ${topic.palee_id}: duplicate dependency entry ${dup} in depends_on`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'depends_on',
          details: { actual: dup },
        });
      }
    }

    return issues;
  },
};
