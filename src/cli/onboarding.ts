/**
 * Onboarding Utilities
 * Shared guidance and empty-state messaging for PALEE CLI
 */

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
