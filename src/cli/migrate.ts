import fs from 'fs';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import {
  loadTopics,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  isConflictError,
} from '../storage';
import { MigrateOptions } from '../types';

/**
 * CLI command handler for validating and migrating note schema versions across the vault.
 *
 * @param options - Migration options including `--fix`.
 * @returns Promise resolving when the migration scan or update completes.
 * @remarks Sets process.exitCode = 2 if the vault path is unconfigured or invalid,
 * process.exitCode = 3 if unrecognized schemas exist, process.exitCode = 4 on an OCC
 * fingerprint mismatch or active file lock conflict (raised via `isConflictError`),
 * and process.exitCode = 5 on any other unexpected runtime exception.
 *
 * @example
 * ```typescript
 * await migrateCommand({ fix: true });
 * ```
 */
async function migrateCommand(options: MigrateOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    if (!vaultPath) return;
    const loaded = loadTopics(vaultPath);

    console.log('Scanning vault for PALEE schema versions...');
    console.log();

    let schemaV1 = 0;
    const missingSchema: string[] = [];
    const unrecognized: string[] = [];

    for (const t of loaded) {
      const schema = t.frontmatter.palee_schema;

      if (schema === 1) {
        schemaV1++;
      } else if (schema === undefined) {
        missingSchema.push(t.filePath);
      } else {
        unrecognized.push(`${t.filePath} (schema: ${schema})`);
      }
    }

    if (options.fix && missingSchema.length > 0) {
      console.log(`Migrating ${missingSchema.length} schema-less notes to Schema v1...`);
      let migrated = 0;
      const failed: string[] = [];
      let sawConflict = false;
      for (const filePath of missingSchema) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const expectedFingerprint = computeFingerprint(content);
          const updated = updateFrontmatter(content, { palee_schema: 1 });
          await atomicWrite(vaultPath, filePath, updated, expectedFingerprint);
          migrated++;
        } catch (err: unknown) {
          console.error(`  Failed to migrate ${filePath}: ${(err as Error).message}`);
          if (isConflictError(err)) sawConflict = true;
          failed.push(filePath);
        }
      }
      console.log(`✓ Successfully migrated ${migrated} notes to Schema v1.`);
      schemaV1 += migrated;
      missingSchema.length = 0;
      missingSchema.push(...failed);
      if (sawConflict) {
        // OCC/lock conflict wins over the "unrecognized schema" exit 3 branch below:
        // the migration could not complete, so report the stronger signal first.
        process.exitCode = 4;
        return;
      }
    }

    console.log(`Schema v1: ${schemaV1} notes`);
    if (missingSchema.length > 0 || unrecognized.length > 0) {
      const allUnrecognized = [...missingSchema, ...unrecognized];
      console.log(`Unrecognized schema: ${allUnrecognized.length} notes`);
      for (const file of allUnrecognized.slice(0, 5)) {
        console.log(`  • ${file}`);
      }
      if (allUnrecognized.length > 5) {
        console.log(`  ... and ${allUnrecognized.length - 5} more`);
      }
      console.log();
      if (missingSchema.length > 0 && !options.fix) {
        console.log('Tip: Run "palee migrate --fix" to automatically upgrade notes missing palee_schema to Schema v1.');
      }
      console.error('Error: Phase 1 only supports schema v1. Cannot migrate unrecognized schemas.');
      process.exitCode = 3;
      return;
    }

    console.log();
    console.log('✓ All notes are schema v1 - no migration needed');
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = isConflictError(e) ? 4 : 5;
    return;
  }
}

export default migrateCommand;
