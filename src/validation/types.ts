/**
 * Validation Framework Types (#25)
 *
 * @remarks
 * Shared contract for the PALEE validation rule framework: the collected
 * {@link ValidationContext} rules inspect, the {@link ValidationRule} contract
 * every rule implements, and the structured {@link ValidationIssue} shape rules
 * report. Rules are pure: they receive a fully collected context and return
 * issues — no filesystem access, config reads, prompts, network calls, or
 * console output inside a rule.
 */

import type { LoadedTopic } from '../storage/loader';
import type { LoadedSession, SessionIndexRead } from '../storage/sessions';
import type { HotMemoryRead } from '../storage/memory';
import type { ScannedNote } from '../types';

/** Severity classification of a reported validation issue. */
export type ValidationSeverity = 'error' | 'warning';

/**
 * Fixability classification modeled ahead of the `--fix` engine.
 *
 * - `false` — the rule's findings can never be auto-fixed.
 * - `'safe'` — a future fix engine may repair the finding without data loss.
 * - `'manual'` — repairing requires a human decision the tool cannot make.
 */
export type ValidationFixability = false | 'safe' | 'manual';

/**
 * A single structured finding reported by a validation rule.
 *
 * @remarks
 * `ruleId` and `severity` identify the origin and class of the finding;
 * the optional locator fields (`file`, `topicId`, `sessionId`, `field`) point
 * at the affected vault entity, and `details` carries rule-specific payload
 * (for example the full file list behind a duplicate topic ID).
 */
export interface ValidationIssue {
  /** Reporting rule identifier (e.g. `parse-frontmatter`) */
  ruleId: string;
  /** Issue severity: errors gate the exit code, warnings do not */
  severity: ValidationSeverity;
  /** Human-readable explanation of the finding */
  message: string;
  /** Relative vault path of the affected note, POSIX-style */
  file?: string;
  /** Topic ID the finding relates to */
  topicId?: string;
  /** Session ID the finding relates to */
  sessionId?: string;
  /** Frontmatter field the finding relates to */
  field?: string;
  /** Rule-specific structured payload */
  details?: Record<string, unknown>;
}

/**
 * Fully collected, read-only snapshot of vault state handed to every rule.
 *
 * @remarks
 * Built once by the collector (see `collect-vault.ts`) so rules never touch
 * the filesystem. `notes` carries the raw per-file parse outcomes (including
 * parse errors for non-PALEE files); `topics` carries the normalized
 * `LoadedTopic` instances the engine consumes.
 */
export interface ValidationContext {
  /** Absolute path of the Obsidian vault root */
  vaultPath: string;
  /** Absolute paths of all scanned Markdown files, sorted by relative path */
  files: string[];
  /** Normalized PALEE topics loaded from the vault */
  topics: LoadedTopic[];
  /** Raw per-file frontmatter parse outcomes, sorted by relative path */
  notes: ScannedNote[];
  /**
   * True when at least one scanned file could not be read (deleted
   * mid-scan, locked by a concurrent writer).
   *
   * @remarks Graph rules must treat findings as provisional when set: the
   * missing-topic set is computed from an incomplete snapshot, so a
   * missing-dependency report could be a transient read failure, not a
   * real dangling reference. The same caveat applies to the session
   * set: an unreadable session note makes unknown-topic and index
   * findings provisional.
   */
  readIncomplete: boolean;
  /**
   * Canonical session notes (`.palee/sessions/S-*.md` and
   * `DRAFT-S-*.md`) with per-file parse outcomes, sorted by filename.
   *
   * @remarks Empty on a fresh vault (no `.palee/sessions/` yet) — a
   * valid state every memory rule must pass on. Malformed notes are
   * included with `frontmatter: null` so `valid-session-schema` can
   * report them; the schema rule owns parse findings, downstream
   * memory rules skip unparseable notes (no double-reporting).
   */
  sessions: LoadedSession[];
  /**
   * Classified read of the derived session index (`.palee/index.md`).
   *
   * @remarks `missing` is a valid state — the index is a rebuildable
   * projection (VERDICT decision 4), never a source of truth; its
   * absence is never reported. `corrupt` carries the parser error for
   * the index rule to report.
   */
  sessionIndex: SessionIndexRead;
  /**
   * Tolerant read of `.palee/hot.md` (classification states owned by
   * `readHotMemory`, #130 read-state contract).
   *
   * @remarks Reserved for the hot-memory cluster (#43): collected in
   * the same single-read snapshot so future rules observe the same
   * vault instant as everything else.
   */
  hotMemory: HotMemoryRead;
}

/**
 * Contract every validation rule implements.
 *
 * @remarks
 * Rules are pure deterministic functions of the {@link ValidationContext}.
 * The `severity` field documents the rule's default classification; the
 * per-issue severity is authoritative when a rule reports mixed classes.
 */
export interface ValidationRule {
  /** Unique kebab-case rule identifier (e.g. `no-duplicate-topic-id`) */
  id: string;
  /** One-line description of what the rule checks */
  description: string;
  /** Default severity classification for the rule's findings */
  severity: ValidationSeverity;
  /** Fixability classification; `--fix` stays a Phase-1 stub */
  fixable?: ValidationFixability;
  /** Runs the rule against a collected context and returns its findings. */
  run(context: ValidationContext): ValidationIssue[];
}
