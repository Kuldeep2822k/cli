#!/usr/bin/env node

/**
 * PALEE CLI Entry Point
 * Implements all Phase 1 commands (deterministic only, no AI)
 */

import { program } from 'commander';
import packageJson from '../package.json';

// Command handlers
import configCommand from '../src/cli/config';
import adoptCommand from '../src/cli/adopt';
import nextCommand from '../src/cli/next';
import planCommand from '../src/cli/plan';
import progressCommand from '../src/cli/progress';
import reviewCommand from '../src/cli/review';
import validateCommand from '../src/cli/validate';
import roadmapCommand from '../src/cli/roadmap';
import migrateCommand from '../src/cli/migrate';
import sessionCommand from '../src/cli/session';
import dashboardCommand from '../src/cli/dashboard';

program
  .name('palee')
  .description('Personal Active Learning & Evaluation Engine')
  .version(packageJson.version);

// palee config
program
  .command('config')
  .description('Manage PALEE configuration')
  .argument('[action]', 'Action: show, set-vault, set-provider, set-model')
  .argument('[value]', 'Value for set-* actions')
  .action(configCommand);

// palee adopt
program
  .command('adopt')
  .description('Adopt existing notes as PALEE topics')
  .argument('[path]', 'Path to markdown file or directory relative to vault root')
  .option('--all', 'Adopt all markdown files across the vault')
  .option('--difficulty <level>', 'Difficulty: beginner, intermediate, advanced')
  .option('--depends-on <ids>', 'Comma-separated topic IDs (single-file mode only)')
  .option('--include <patterns>', 'Comma-separated inclusion glob patterns')
  .option('--exclude <patterns>', 'Comma-separated exclusion glob patterns')
  .option('--tag <tags>', 'Comma-separated Obsidian frontmatter tags to filter')
  .option('--dry-run', 'Simulate adoption and print summary without modifying files')
  .option('--verbose', 'Print detailed file-by-file inspection list')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(adoptCommand);

// palee next
program
  .command('next')
  .description('Show the next topic due for review')
  .option('--all', 'Show all due topics')
  .option('--json', 'Output in JSON format')
  .action(nextCommand);

// palee plan
program
  .command('plan')
  .description('Show learning plan for the day')
  .option('--json', 'Output in JSON format')
  .action(planCommand);

// palee progress
program
  .command('progress')
  .description('Show learning progress summary')
  .option('--topic <id>', 'Show progress for specific topic')
  .option('--json', 'Output in JSON format')
  .action(progressCommand);

// palee review
program
  .command('review')
  .description('Record a manual review for a topic')
  .argument('<topic>', 'Topic ID or unique name fragment')
  .argument('<quality>', 'Quality rating (0-5)')
  .action(reviewCommand);

// palee validate
program
  .command('validate')
  .description('Validate vault integrity')
  .option('--fix', 'Attempt to fix validation errors')
  .option('--json', 'Output in JSON format')
  .action(validateCommand);

// palee roadmap
program
  .command('roadmap')
  .description('Manage learning roadmaps')
  .option('--from <file>', 'Import roadmap from YAML file')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(roadmapCommand);

// palee migrate
program
  .command('migrate')
  .description('Migrate PALEE schema to current version')
  .action(migrateCommand);

// palee session
program
  .command('session')
  .description('Manage learning sessions')
  .argument('<action>', 'Action: start, draft, end, list')
  .option('-i, --interactive', 'Run in interactive mode')
  .option('--topic <id>', 'Topic ID for session')
  .option('--json', 'Output in JSON format')
  .action(sessionCommand);

// palee dashboard
program
  .command('dashboard')
  .description('Show interactive learning dashboard')
  .option('--json', 'Output in JSON format')
  .action(dashboardCommand);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exitCode = 0;
}

// Parse and execute
program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exitCode = 5;
});
