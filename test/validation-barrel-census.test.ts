/**
 * Validation barrel census & public surface (#25)
 *
 * Contracts under test:
 * - The `src/validation` barrel exports the full framework surface: rules,
 *   collector, runner, and formatters, plus the shared types.
 * - The root package index re-exports the barrel (`export * from
 *   './validation'`), so npm consumers can import the module.
 * - Modeled on test/storage-barrel-census.test.ts (Issue #131).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as validation from '../src/validation';
import * as index from '../src/index';

describe('Validation Barrel Census & Public Surface (#25)', () => {
  describe('Public Exports Presence', () => {
    it('exports the core framework functions', () => {
      assert.strictEqual(typeof validation.collectVault, 'function');
      assert.strictEqual(typeof validation.runRules, 'function');
      assert.strictEqual(typeof validation.formatHuman, 'function');
      assert.strictEqual(typeof validation.formatJson, 'function');
    });

    it('exports all seventeen registered rules as ValidationRule objects', () => {
      const rules: unknown[] = [
        validation.parseFrontmatterRule,
        validation.readFailureRule,
        validation.validPaleeSchemaRule,
        validation.validTopicIdFormatRule,
        validation.validTopicStatusRule,
        validation.noDuplicateTopicIdRule,
        validation.validDependencyListRule,
        validation.noMissingDependencyRule,
        validation.noDependencyCycleRule,
        validation.validAssessmentFieldsRule,
        validation.validTopicMasteryRule,
        validation.validReviewFieldsRule,
        validation.validReviewDatesRule,
        validation.validManagedNoteKindRule,
        validation.validSessionSchemaRule,
        validation.noSessionUnknownTopicRule,
        validation.validSessionIndexRule,
      ];
      // Rules are object literals implementing ValidationRule — assert
      // presence (not undefined) and let the contract-shape test pin the rest.
      for (const rule of rules) {
        assert.ok(rule !== undefined && rule !== null);
      }
    });

    it('pins the ValidationRule contract shape on every exported rule', () => {
      // A rule is an object literal with id/description/severity/run — the
      // typeof check above confirms presence; here we pin the contract shape
      // on one representative rule per source module.
      const rules = [
        validation.parseFrontmatterRule,
        validation.readFailureRule,
        validation.validPaleeSchemaRule,
        validation.validTopicIdFormatRule,
        validation.validTopicStatusRule,
        validation.noDuplicateTopicIdRule,
        validation.validDependencyListRule,
        validation.noMissingDependencyRule,
        validation.noDependencyCycleRule,
        validation.validAssessmentFieldsRule,
        validation.validTopicMasteryRule,
        validation.validReviewFieldsRule,
        validation.validReviewDatesRule,
        validation.validManagedNoteKindRule,
        validation.validSessionSchemaRule,
        validation.noSessionUnknownTopicRule,
        validation.validSessionIndexRule,
      ];
      for (const rule of rules) {
        assert.strictEqual(typeof rule.id, 'string');
        assert.strictEqual(typeof rule.description, 'string');
        assert.ok(rule.severity === 'error' || rule.severity === 'warning');
        assert.strictEqual(typeof rule.run, 'function');
      }
    });
  });

  describe('Root Re-export Chain', () => {
    it('re-exports validation symbols via the root package index', () => {
      assert.strictEqual(index.collectVault, validation.collectVault);
      assert.strictEqual(index.runRules, validation.runRules);
      assert.strictEqual(index.formatHuman, validation.formatHuman);
      assert.strictEqual(index.formatJson, validation.formatJson);
      assert.strictEqual(
        index.noDependencyCycleRule,
        validation.noDependencyCycleRule
      );
      assert.strictEqual(
        index.validTopicIdFormatRule,
        validation.validTopicIdFormatRule
      );
    });
  });
});
