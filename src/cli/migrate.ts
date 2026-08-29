import { loadConfig } from './config';
import { loadTopics } from '../storage/loader';

async function migrateCommand(): Promise<void> {
  try {
    // Load config
    const config = loadConfig();

    if (!config.vaultPath) {
      console.error('Error: Vault path not configured. Run: palee config set-vault <path>');
      process.exitCode = 2;
      return;
    }

    const vaultPath = config.vaultPath;
    const loaded = loadTopics(vaultPath);

    console.log('Scanning vault for PALEE schema versions...');
    console.log();

    let schemaV1 = 0;
    const unrecognized: string[] = [];

    for (const t of loaded) {
      const schema = t.frontmatter.palee_schema;

      if (schema === 1) {
        schemaV1++;
      } else if (schema === undefined) {
        unrecognized.push(t.filePath);
      } else {
        unrecognized.push(`${t.filePath} (schema: ${schema})`);
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
      process.exitCode = 3;
      return;
    }

    console.log();
    console.log('✓ All notes are schema v1 - no migration needed');
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = 5;
    return;
  }
}

export default migrateCommand;
