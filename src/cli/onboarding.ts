/**
 * Onboarding Utilities
 * Shared guidance, validation, and empty-state messaging for PALEE CLI
 */

import fs from 'fs';
import path from 'path';

export interface VaultValidationOptions {
  json?: boolean;
}

/**
 * Determines whether machine-readable JSON output should be used:
 * either when explicitly requested via --json or when output is non-TTY (piped/redirected).
 *
 * @param options - Optional command options containing boolean `json` flag
 * @returns `true` if JSON output mode should be activated, otherwise `false`
 *
 * @remarks
 * Evaluates both the explicit `--json` flag and standard output TTY stream state.
 *
 * @example
 * ```typescript
 * const jsonMode = isJsonOutput({ json: true });
 * ```
 */
export function isJsonOutput(options?: { json?: boolean }): boolean {
  return Boolean(options?.json || (process.stdout && process.stdout.isTTY === false));
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
    if (isJsonOutput(options)) {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 2;
  }

  if (!vaultPath) {
    reportError('Vault path not configured. Run: palee config set-vault <path>');
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
  console.log('No topics found in vault.\n');
  console.log('To get started:');
  console.log('  • Adopt an existing note:');
  console.log('    palee adopt "path/to/note.md"\n');
  console.log('  • Import a curriculum roadmap:');
  console.log('    palee roadmap --from <file.yaml>\n');
}
