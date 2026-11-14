/**
 * The documented CLI exit-code constants.
 *
 * @remarks
 * A leaf module on purpose. The entry point and `onboarding` need the numbers
 * on every run — including `--help` and `--version` — while `exitCodeFor` needs
 * the storage barrel and the AI error type to classify an error. Keeping both
 * in one module put the vault scanner and the provider layer in front of
 * argument parsing (#565 P2-12). `exit-codes.ts` re-exports this object, so
 * handlers keep one import specifier.
 */

/** Documented CLI exit codes */
export const ExitCode = {
  /** Command completed successfully */
  Success: 0,
  /** Partial failure: the note landed, but sub-items did not (roadmap skips, session cleanup) */
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
