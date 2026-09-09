/**
 * parse-frontmatter rule (#26)
 *
 * @remarks
 * Reports malformed YAML frontmatter as a warning per file and never aborts
 * a vault scan — one bad note is a finding, not a dead validation. The rule
 * consumes the per-file parse outcomes collected by `scanNotes`.
 */

import { ValidationRule } from '../types';

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
