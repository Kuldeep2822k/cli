/**
 * Onboarding Utilities
 * Shared guidance, validation, and empty-state messaging for PALEE CLI
 */

import fs from 'fs';
import path from 'path';

/**
 * Validates that the vault path is configured, exists, is a directory, and is readable.
 * Exits with code 2 on any configuration/access failure.
 */
export function validateVaultPath(vaultPath?: string): string {
  if (!vaultPath) {
    console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
    process.exit(2);
  }

  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: Vault path not found: ${resolved}`);
    process.exit(2);
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      console.error(`Error: Vault path is not a directory: ${resolved}`);
      process.exit(2);
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error: Cannot access vault path: ${error.message}`);
    process.exit(2);
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    console.error(`Error: Vault path is not readable (permission denied): ${resolved}`);
    process.exit(2);
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
