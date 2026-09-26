#!/usr/bin/env node

/**
 * PALEE CLI Entry Point
 * Implements all Phase 1 commands (deterministic only, no AI)
 */

import { program } from 'commander';
import packageJson from '../package.json';
import { ExitCode } from '../src/cli/exit-codes';

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
  .version(packageJson.version)
  // Commander exits the process directly for usage errors, which bypasses the
  // ExitCode contract (it hard-codes 1, the partial-import code). Override turns
  // those into `CommanderError` throws so the catch below can map them (#192).
  .exitOverride();

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
  .option('--auto-chain [tier]', 'Auto-wire depends_on: numbered tree + optional TOC tier (strict|toc|full; bare flag = full; batch mode only)')
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
  .option('--strict', 'Exit non-zero on warnings as well as errors')
  .action(validateCommand);

// palee roadmap
program
  .command('roadmap')
  .description('Manage learning roadmaps')
  .option('--from <file>', 'Import roadmap from YAML file')
  .option('--auto-chain', 'Chain imported topics by their order field')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(roadmapCommand);

// palee migrate
program
  .command('migrate')
  .description('Migrate PALEE schema to current version')
  .option('--fix', 'Automatically update notes missing palee_schema to schema v1')
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

// Parse and execute
program.parseAsync(process.argv).catch((err: unknown) => {
  const cmdErr = err as { code?: unknown; exitCode?: unknown };
  if (typeof cmdErr.code === 'string' && cmdErr.code.startsWith('commander.')) {
    // Commander writes the text for each of these paths before throwing, so
    // nothing is printed here — re-emitting `err.message` would duplicate the
    // `error: unknown command ...` line.
    //
    // Help and `--version` are informational, so they exit 0: `--help` throws
    // `helpDisplayed`, a bare invocation throws `commander.help` (Commander
    // hands that path exit code 1, which is reserved here for partial roadmap
    // import), and `--version` throws with 0. Every remaining code —
    // unknownCommand, unknownOption, missingArgument — is a usage error (#192).
    const informational =
      cmdErr.exitCode === 0 || cmdErr.code === 'commander.help' || cmdErr.code === 'commander.version';
    process.exitCode = informational ? ExitCode.Success : ExitCode.Usage;
    return;
  }

  const isJson = process.argv.includes('--json');
  const message = err instanceof Error ? err.message : String(err);
  if (isJson) {
    console.log(JSON.stringify({
      status: 'error',
      code: ExitCode.Unexpected,
      error: message,
    }));
  } else {
    console.error(err);
  }
  process.exit(ExitCode.Unexpected);
});
