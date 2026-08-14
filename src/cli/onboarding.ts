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
 * Validates that the vault path is configured, exists, is a directory, and is readable.
 * Sets process.exitCode = 2 and prints error (as JSON if options.json is true) on any configuration/access failure.
 * Returns the resolved vault path string if valid, or null on failure.
 */
export function validateVaultPath(vaultPath?: string, options: VaultValidationOptions = {}): string | null {
  const reportError = (msg: string) => {
    if (options.json) {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 2;
  };

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
 */
export function printEmptyVaultOnboarding(): void {
  console.log('No topics found in vault.\n');
  console.log('To get started:');
  console.log('  • Adopt an existing note:');
  console.log('    palee adopt "path/to/note.md"\n');
  console.log('  • Import a curriculum roadmap:');
  console.log('    palee roadmap --from <file.yaml>\n');
}
