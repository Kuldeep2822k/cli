/**
 * safe-vault-paths rule (#45)
 *
 * @remarks
 * PALEE writes into a user-owned Obsidian vault; any path-boundary
 * mistake can touch files outside the configured vault. This rule
 * audits the collected snapshot's path surface with the SAME
 * normalization policy the vault walker and roadmap import use
 * (resolve against the vault root, reject `..` traversal and absolute
 * escapes; Windows backslash separators normalize before validation).
 *
 * Checkable surface:
 * - `context.files` / `context.notes`: the scanned note set. The
 *   walker already excludes dot-directories and symlink escapes, so
 *   every scanned path SHOULD resolve inside the vault — a scanned
 *   path that escapes is either a symlinked-root edge case the
 *   walker tolerates or genuinely foreign data, and reporting it
 *   keeps the boundary explicit instead of implicit.
 * - `context.topics[].path`: the loader's vault-relative paths
 *   (`relativeVaultPath`, POSIX-normalized). An escaped `../` result
 *   means the note lives outside the vault while claiming to be in
 *   it — exactly the boundary violation #45 exists to surface.
 * - `context.sessions[].path`: same contract for session notes
 *   (`.palee/sessions/…` derived from the filename).
 *
 * Severity: `error` — a path escape is a write-boundary risk, not a
 * data-quality warning. The rule is pure: it only reads paths
 * already collected; it never touches the filesystem (no realpath —
 * that would race with concurrent writes and re-do the walker's
 * job). Symlink resolution itself stays owned by the walker, whose
 * policy (`walkVault` with `followSymlinks`) decides which files
 * enter the snapshot at all.
 *
 * What this rule does NOT re-check: managed note CONTENT (wikilink
 * targets, depends_on IDs are topic IDs, not paths), roadmap files
 * (validated at import by `roadmap.ts`'s boundary pass — a different
 * lifecycle), and `.palee` internals already validated by the memory
 * rules. The remaining runtime write paths all go through
 * `ensureVaultDirectory`, which enforces the same boundary
 * synchronously.
 */

import type { ValidationRule, ValidationIssue } from '../types';

/**
 * True when a vault-relative path is genuinely inside the vault.
 *
 * @remarks POSIX-normalized (`\` → `/`) before the checks so Windows
 * separators validate identically. An empty result is the vault root
 * itself (in-vault by definition). This mirrors the containment test
 * in `roadmap.ts`'s import pass and the walker's symlink filter —
 * one boundary policy everywhere.
 */
function isInsideVault(relative: string): boolean {
  const posix = relative.replace(/\\/g, '/');
  if (posix === '' ) return true; // the vault root itself
  return (
    !posix.startsWith('../') &&
    posix !== '..' &&
    !posix.startsWith('/') &&
    !/^([a-zA-Z]:)?\//.test(posix) && // absolute POSIX or Windows drive path
    !posix.split('/').includes('..')
  );
}

/**
 * Reports scanned or loaded paths that escape the configured vault.
 */
export const safeVaultPathsRule: ValidationRule = {
  id: 'safe-vault-paths',
  description:
    'Every PALEE-managed path must resolve inside the configured vault (normalized, no traversal or absolute escapes)',
  severity: 'error',
  fixable: 'manual', // deciding where a foreign note belongs is a human call
  run(context): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Loader-produced vault-relative paths (topics): relativeVaultPath
    // keeps a truthful escaping path when a file truly lives outside
    // the vault, so the check below is meaningful, not vacuous.
    for (const topic of context.topics) {
      if (!isInsideVault(topic.path)) {
        issues.push({
          ruleId: 'safe-vault-paths',
          severity: 'error',
          message: `Topic ${topic.palee_id} path escapes the vault boundary: ${JSON.stringify(topic.path)}`,
          file: topic.path,
          topicId: topic.palee_id,
          field: 'path',
          details: { path: topic.path },
        });
      }
    }

    // Scanned note set (per-file outcomes): the relative path as the
    // scanner derived it. The walker excludes escapes by construction,
    // so a finding here indicates data the walker could not classify
    // — the boundary stays explicit.
    for (const note of context.notes) {
      if (!isInsideVault(note.relativePath)) {
        issues.push({
          ruleId: 'safe-vault-paths',
          severity: 'error',
          message: `Scanned note path escapes the vault boundary: ${JSON.stringify(note.relativePath)}`,
          file: note.relativePath,
          field: 'path',
          details: { path: note.relativePath },
        });
      }
    }

    // Session-note paths (`.palee/sessions/<stem>.md`): the loader
    // derives these from filenames inside the sessions dir — an escape
    // here means the sessions dir itself resolved outside the vault.
    for (const session of context.sessions) {
      if (!isInsideVault(session.path)) {
        issues.push({
          ruleId: 'safe-vault-paths',
          severity: 'error',
          message: `Session note path escapes the vault boundary: ${JSON.stringify(session.path)}`,
          file: session.path,
          sessionId: session.sessionId,
          field: 'path',
          details: { path: session.path },
        });
      }
    }

    return issues.sort((a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.topicId ?? '').localeCompare(b.topicId ?? '')
    );
  },
};
