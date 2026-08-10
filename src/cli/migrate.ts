import { loadConfig } from './config';
/**
 * Migrate Command Handler
 * Schema migration (Phase 1: stub only)
 */

import fs from 'fs';
import { walkVault } from '../storage/vault-walker';
import { parseFrontmatter } from '../storage/frontmatter';

async function migrateCommand(): Promise<void> {
  try {
    // Load config
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exit(2);
    }

    const vaultPath = config.vaultPath;
    const files = walkVault(vaultPath);

    console.log('Scanning vault for PALEE schema versions...');
    console.log();

    let schemaV1 = 0;
    const unrecognized: string[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (!frontmatter || !frontmatter.palee_id) continue;

      const schema = frontmatter.palee_schema;

      if (schema === 1) {
        schemaV1++;
      } else if (schema === undefined) {
        unrecognized.push(filePath);
      } else {
        unrecognized.push(`${filePath} (schema: ${schema})`);
      }
    }

    console.log(`Schema v1: ${schemaV1} notes`);
    if (unrecognized.length > 0) {
      console.log(`Unrecognized schema: ${unrecognized.length} notes`);
      for (const file of unrecognized.slice(0, 5)) {
        console.log(`  • ${file}`);
      }
      if (unrecognized.length > 5) {
        console.log(`  ... and ${unrecognized.length - 5} more`);
      }
      console.log();
      console.error('Error: Phase 1 only supports schema v1. Cannot migrate unrecognized schemas.');
      process.exit(3);
    }

    console.log();
    console.log('✓ All notes are schema v1 - no migration needed');
    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exit(5);
  }
}

export default migrateCommand;
