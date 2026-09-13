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
 * Covers every layer of the snapshot: walked notes, session notes
 * (`.palee/sessions/`), and memory-subsystem components (the sessions
 * directory itself, `index.md`, `hot.md`) — a partial snapshot is
 * reported wherever it was discovered, never silently passed over.
 */
export const readFailureRule: ValidationRule = {
  id: 'read-failure',
  description: 'Reports files that could not be read during collection',
  severity: 'warning',
  fixable: false,
  run(context) {
    const noteFailures = context.notes
      .filter((note) => note.readError !== undefined)
      .map((note) => ({
        ruleId: 'read-failure',
        severity: 'warning' as const,
        message: `Could not read ${note.relativePath}: ${note.readError} (validation ran on an incomplete snapshot)`,
        file: note.relativePath,
        details: { readError: note.readError },
      }));
    const sessionFailures = context.sessions
      .filter((session) => session.readError !== undefined)
      .map((session) => ({
        ruleId: 'read-failure',
        severity: 'warning' as const,
        message: `Could not read ${session.path}: ${session.readError} (validation ran on an incomplete snapshot)`,
        file: session.path,
        details: { readError: session.readError },
      }));
    const componentFailures = context.memoryReadErrors.map((error) => ({
      ruleId: 'read-failure',
      severity: 'warning' as const,
      message: `Could not read ${error.path}: ${error.readError} (validation ran on an incomplete snapshot)`,
      file: error.path,
      details: { readError: error.readError },
    }));
    return [...noteFailures, ...sessionFailures, ...componentFailures].sort((a, b) =>
      a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0
    );
  },
};
