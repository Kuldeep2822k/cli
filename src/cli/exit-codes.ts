/**
 * CLI Exit Code Classification
 *
 * @remarks
 * The documented exit-code values live in `./exit-code-values` — a leaf module
 * the entry point can import without the storage and AI layers — and are
 * re-exported here. Route conflict-vs-unexpected classification through
 * `exitCodeFor()` so every handler maps OCC/lock conflicts identically.
 */

import { isConflictError, isContainmentError } from '../storage';
import { ProviderError } from '../ai';
import { ExitCode } from './exit-code-values';

/**
 * Re-exported for the handlers: the values live in a leaf module so the entry
 * point can read them without pulling the storage and AI layers in (#565
 * P2-12).
 */
export { ExitCode };

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
export function exitCodeFor(error: unknown): 2 | 3 | 4 | 5 {
  if (isConflictError(error)) return ExitCode.Conflict;
  if (isContainmentError(error)) return ExitCode.Validation;
  if (error instanceof ProviderError) {
    // Mapped here rather than at each call site, so the same provider refusal cannot
    // exit 2 from `config set-base-url` and 5 from a command that read the same stored
    // value. A bad endpoint or an unsupported provider is configuration (2); a reply
    // that failed the output contract is validation (3); nothing reached the provider,
    // or the provider refused, is the I/O class (5).
    if (error.kind === 'config') return ExitCode.Usage;
    if (error.kind === 'schema') return ExitCode.Validation;
    // A 401/403 is a user-fixable credential problem, not a crash: `status` is carried
    // precisely so it can be told apart from a 5xx or an unreachable endpoint, both of
    // which stay in the I/O class (5).
    if (error.kind === 'provider' && (error.status === 401 || error.status === 403)) {
      return ExitCode.Usage;
    }
    return ExitCode.Unexpected;
  }
  return ExitCode.Unexpected;
}
