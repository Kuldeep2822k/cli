/**
 * CLI Exit Code Constants and Conflict Classification
 *
 * @remarks
 * Single source of truth for the documented CLI exit-code contract
 * (see `docs/02-0-cli-commands.md`). Import `ExitCode` instead of
 * hard-coding numeric literals, and route conflict-vs-unexpected
 * classification through `exitCodeFor()` so every handler maps
 * OCC/lock conflicts identically.
 */

import { isConflictError, isContainmentError } from '../storage';

/** Documented CLI exit codes */
export const ExitCode = {
  /** Command completed successfully */
  Success: 0,
  /** Partial import failure (e.g. some roadmap entries skipped) */
  PartialImport: 1,
  /** Invalid usage: missing/invalid arguments, unconfigured vault */
  Usage: 2,
  /** Validation failure: unrecognized schemas, vault integrity errors */
  Validation: 3,
  /** OCC detected a mid-air collision or an active file lock is held */
  Conflict: 4,
  /** Unexpected runtime exception */
  Unexpected: 5,
} as const;

/**
 * Maps an error caught by a command handler to the documented exit code.
 *
 * @param error - The caught error value
 * @returns `ExitCode.Conflict` when the error is an OCC/lock conflict,
 * `ExitCode.Validation` when it refuses a destination that escapes the vault,
 * otherwise `ExitCode.Unexpected`
 *
 * @remarks
 * A containment refusal is a vault integrity condition, not a crash and not a
 * collision: a planted link that would move a note outside the vault is exactly
 * what `ExitCode.Validation` (3) already reports for a roadmap topic path that
 * escapes the vault, and unlike `ECONFLICT` no retry can make it safe.
 */
export function exitCodeFor(error: unknown): 3 | 4 | 5 {
  if (isConflictError(error)) return ExitCode.Conflict;
  if (isContainmentError(error)) return ExitCode.Validation;
  return ExitCode.Unexpected;
}
