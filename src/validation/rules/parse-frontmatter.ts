/**
 * parse-frontmatter rule (#26)
 *
 * @remarks
 * Reports malformed YAML frontmatter as a warning per file and never aborts
 * a vault scan — one bad note is a finding, not a dead validation. The rule
 * consumes the per-file parse outcomes collected by `scanNotes`.
 */

import type { ValidationRule } from '../types';

/** Reports every note whose frontmatter could not be parsed. */
export const parseFrontmatterRule: ValidationRule = {
  id: 'parse-frontmatter',
  description: 'Malformed YAML frontmatter becomes a warning; scanning continues',
  severity: 'warning',
  fixable: 'manual',
  run(context) {
    return context.notes
      .filter((note) => note.parseError !== undefined)
      .map((note) => ({
        ruleId: 'parse-frontmatter',
        severity: 'warning' as const,
        message: `Malformed frontmatter in ${note.relativePath}: ${note.parseError}`,
        file: note.relativePath,
        details: { parserMessage: note.parseError },
      }))
      .sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};

/**
 * Reports files that could not be read during collection.
 *
 * @remarks Distinct from parse failures: a read failure means validation
 * ran on an incomplete snapshot — the note might be perfectly healthy but
 * locked or deleted mid-scan. Warning-only, never gates the exit code.
 */
export const readFailureRule: ValidationRule = {
  id: 'read-failure',
  description: 'Reports files that could not be read during collection',
  severity: 'warning',
  fixable: false,
  run(context) {
    return context.notes
      .filter((note) => note.readError !== undefined)
      .map((note) => ({
        ruleId: 'read-failure',
        severity: 'warning' as const,
        message: `Could not read ${note.relativePath}: ${note.readError} (validation ran on an incomplete snapshot)`,
        file: note.relativePath,
        details: { readError: note.readError },
      }))
      .sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  },
};
