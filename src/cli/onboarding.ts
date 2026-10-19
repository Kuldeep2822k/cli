/**
 * Onboarding Utilities
 * Shared guidance, validation, and empty-state messaging for PALEE CLI
 */

import fs from 'fs';
import path from 'path';
import { programName } from './program-name';

export interface VaultValidationOptions {
  json?: boolean;
}

/**
 * Determines whether machine-readable JSON output should be used:
 * only when explicitly requested via `--json` or the `PALEE_JSON`
 * environment variable.
 *
 * @param options - Optional command options containing boolean `json` flag
 * @returns `true` if JSON output mode should be activated, otherwise `false`
 *
 * @remarks
 * Piping or redirecting stdout deliberately does NOT switch to JSON: a
 * redirected human-readable report (`palee plan > out.txt`,
 * `palee dashboard | less`) stays human-readable. Set `PALEE_JSON=1`
 * (or `true`) for machine-readable output without the flag (#357).
 *
 * An explicit `json: false` forces human output even under `PALEE_JSON`: the
 * commands that declare no `--json` flag (`review`, `adopt`, `assess`,
 * `roadmap`, `migrate`) pass it when they validate the vault, so a global env
 * setting cannot split their output into machine-readable errors above prose
 * results.
 *
 * @example
 * ```typescript
 * const jsonMode = isJsonOutput({ json: true });
 * ```
 */
export function isJsonOutput(options?: { json?: boolean }): boolean {
  if (options?.json === false) return false;
  if (options?.json === true) return true;
  const env = process.env.PALEE_JSON;
  return env === '1' || env?.toLowerCase() === 'true';
}

/**
 * The single machine-readable error shape every command emits: a JSON object
 * `{ error: string }` on `stderr` in JSON mode, `Error: <message>` otherwise.
 *
 * @param error - The caught value, or a ready-made diagnostic message
 * @param options - Command options carrying the boolean `json` flag
 * @returns Void
 *
 * @remarks
 * One emitter, one shape: `validateVaultPath`'s exit-2 configuration path and
 * the exit-5 runtime catches in the reading commands both go through here, so a
 * tool that parses `stderr` as JSON under `--json` sees the same object either
 * way (#325). The caller owns the exit code — this only formats and writes.
 *
 * @example
 * ```typescript
 * } catch (e: unknown) {
 *   emitError(e, options);
 *   process.exitCode = exitCodeFor(e);
 * ```
 */
export function emitError(error: unknown, options?: { json?: boolean }): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isJsonOutput(options)) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
}

/**
 * Validates that the vault path is configured, exists, is a directory, and is readable.
 * Sets process.exitCode = 2 and prints error (as JSON if isJsonOutput is true) on any configuration/access failure.
 *
 * @param vaultPath - Path string from configuration
 * @param options - Validation formatting options (e.g. `json`)
 * @returns Resolved absolute vault path string if valid, or `null` on failure
 *
 * @remarks
 * Validates existence, directory type, and read permissions via `fs.accessSync`.
 *
 * @example
 * ```typescript
 * const vault = validateVaultPath('/path/to/vault');
 * ```
 */
export function validateVaultPath(vaultPath?: string, options: VaultValidationOptions = {}): string | null {
  /**
   * Emits structured or formatted error message and sets exit code.
   *
   * @param msg - Error diagnostic message
   * @returns Void
   * @remarks Formats error based on JSON output mode.
   * @example
   * ```typescript
   * reportError('Vault not found');
   * ```
   */
  function reportError(msg: string): void {
    emitError(msg, options);
    process.exitCode = 2;
  }

  if (!vaultPath) {
    reportError(`Vault path not configured. Run: ${programName()} config set-vault <path>`);
    return null;
  }

  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved)) {
    reportError(`Vault path not found: ${resolved}`);
    return null;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      reportError(`Vault path is not a directory: ${resolved}`);
      return null;
    }
  } catch (err: unknown) {
    const error = err as Error;
    reportError(`Cannot access vault path: ${error.message}`);
    return null;
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    reportError(`Vault path is not readable (permission denied): ${resolved}`);
    return null;
  }

  return resolved;
}

/**
 * Prints standard onboarding guidance when an empty vault contains 0 topics.
 *
 * @returns Void
 *
 * @remarks
 * Outputs sample CLI commands for adopting notes and importing roadmaps.
 *
 * @example
 * ```typescript
 * printEmptyVaultOnboarding();
 * ```
 */
export function printEmptyVaultOnboarding(): void {
  const bin = programName();
  console.log('No topics found in vault.\n');
  console.log('To get started:');
  console.log('  • Adopt an existing note:');
  console.log(`    ${bin} adopt "path/to/note.md"\n`);
  console.log('  • Import a curriculum roadmap:');
  console.log(`    ${bin} roadmap --from <file.yaml>\n`);
}
