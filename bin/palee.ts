#!/usr/bin/env node

/**
 * PALEE CLI Entry Point
 * Implements all Phase 1 commands (deterministic only, no AI)
 */

import { program } from 'commander';
import packageJson from '../package.json';
import { ExitCode } from '../src/cli/exit-codes';
import { deriveProgramName } from '../src/cli/program-name';

// Command handlers
import configCommand from '../src/cli/config';
import adoptCommand from '../src/cli/adopt';
import nextCommand from '../src/cli/next';
import planCommand from '../src/cli/plan';
import progressCommand from '../src/cli/progress';
import reviewCommand from '../src/cli/review';
import assessCommand from '../src/cli/assess';
import validateCommand from '../src/cli/validate';
import roadmapCommand from '../src/cli/roadmap';
import migrateCommand from '../src/cli/migrate';
import sessionCommand from '../src/cli/session';
import dashboardCommand from '../src/cli/dashboard';

program
  // The name the process was invoked as, not the published bin: a parallel or
  // renamed install (`palee-test`) has to print usage its learner can copy
  // back. Pinned here rather than left to Commander's own derivation, which
  // only runs inside `parse()` and falls back to the literal `'program'` when
  // `argv[1]` is missing. Handlers read it back through `programName()` so a
  // hint can never disagree with this usage line (#314).
  .name(deriveProgramName())
  .description('Personal Active Learning & Evaluation Engine')
  .version(packageJson.version)
  // Commander exits the process directly for usage errors, which bypasses the
  // ExitCode contract (it hard-codes 1, the partial-import code). Override turns
  // those into `CommanderError` throws so the catch below can map them (#192).
  .exitOverride();

// The one per-run config override, in the place a user looks for how the run is
// scoped. `PALEE_CONFIG_DIR` was documented in the guides and in no help text, so
// nothing told a scripted run that omitting it silently re-targets every command
// at the machine-global config and the vault it names (#311). `afterAll` is what
// makes it reach `palee <command> --help` too, not just `palee --help`.
program.addHelpText('afterAll', `

Environment:
  PALEE_CONFIG_DIR  Directory holding config.json. Unset, palee reads and writes the
                    machine-global config (%LOCALAPPDATA%\\palee on Windows,
                    ~/.config/palee elsewhere), so every command on this machine
                    shares one config and the vault it names. Mutating commands
                    (adopt, roadmap, review, assess, session, migrate) print the
                    resolved vault and config path; set PALEE_CONFIG_DIR per run to
                    isolate them.
`);

// palee config
program
  .command('config')
  .description('Manage PALEE configuration (reads $PALEE_CONFIG_DIR/config.json; unset means the machine-global config)')
  .argument('[action]', 'Action: show, set-vault, set-provider, set-base-url, set-api-key, unset-api-key, test-connection, set-model')
  .argument('[value]', 'Value for set-* actions (never the API key)')
  .option('--from-env <var>', 'environment variable to read the API key from (set-api-key)')
  .option('--json', 'Output in JSON format (config show)')
  .action(configCommand);

// palee adopt

/**
 * Commander argument parser for the repeatable batch filter flags.
 *
 * @param value - The option-argument of this occurrence of the flag
 * @param previous - Everything already accumulated for it, `undefined` on the first
 * @returns The whole list as one comma-separated pattern string
 *
 * @remarks
 * `--include`/`--exclude`/`--tag` were plain `<patterns>` strings, so a repeated
 * flag let the last value silently win (#312): `--exclude '*draft*' --exclude
 * '*template*'` dropped the first pattern and adopted the draft. Joining on commas
 * keeps the accumulator in the shape the filters already read — `matchesPattern`
 * and `matchesTags` both split a comma list and OR-fold it — so every value is
 * consumed by the batch loop and a single comma-separated flag behaves exactly as
 * before.
 */
function collectPatterns(value: string, previous?: string): string {
  return previous ? `${previous},${value}` : value;
}

program
  .command('adopt')
  .description('Adopt existing notes as PALEE topics')
  .argument('[path]', 'Path to markdown file or directory relative to vault root')
  .option('--all', 'Adopt all markdown files across the vault (a batch scan skips repo-meta docs — README/SUMMARY/LICENSE/etc.; adopt a single file by path to override)')
  .option('--difficulty <level>', 'Difficulty: beginner, intermediate, advanced')
  .option('--depends-on <ids>', 'Comma-separated topic IDs (single-file mode only)')
  .option('--include <patterns>', 'Comma-separated inclusion glob patterns (batch mode; repeatable)', collectPatterns)
  .option('--exclude <patterns>', 'Comma-separated exclusion glob patterns (batch mode; repeatable)', collectPatterns)
  .option('--tag <tags>', 'Comma-separated Obsidian frontmatter tags to filter (batch mode; repeatable)', collectPatterns)
  .option('--dry-run', 'Simulate adoption and print summary without modifying files')
  .option('--verbose', 'Print detailed file-by-file inspection list')
  .option('--auto-chain', 'Auto-wire depends_on from a note\'s own prerequisites, else the numbered tree (batch mode only)')
  .option('--chain-tier <tier>', 'Order signal for --auto-chain: strict (default) numbers only; full adds listing order, which never gates')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--undo', 'Reverse an adoption instead of performing one: strip only the PALEE-owned frontmatter keys from the selected notes, preserving every other key, comment and body byte (combine with --dry-run to preview)')
  .option('--drop-title', 'With --undo: also remove the `title` key. Adoption writes it but does not own it, and a note that authored its own title keeps it, so reversal cannot tell the two apart and leaves it unless you say otherwise')
  // #312 — the glob dialect decides what a filter means and was never written
  // down anywhere a learner reads: `palee adopt --help` now states it, because a
  // pattern's `/` is the difference between "this directory tree" and "no file
  // in this vault, ever".
  .addHelpText(
    'after',
    `
Pattern syntax for --include / --exclude (batch mode):
  • A pattern with no "/" matches the note's filename in any directory: '*template*' catches MODULES/01/runbook-template.md.
  • A pattern with a "/" is anchored at the vault root and must name the whole vault-relative path, segment by segment: 'a/*.md' matches a/x.md but never x.md, and never b/a/x.md.
  • '*' stops at a directory boundary, '**' crosses it: '**/*.md' is every note in scope, 'MODULES/**' every note under MODULES/.
  • '?' matches one character; '[0-9]' matches a class and '[!0-9]' a negated one.
  • Matching ignores case.
  • Repeat the flag, or separate patterns with commas, to filter on more than one; a pattern that matches no file in the scanned scope is named in a warning.
  • --include, --exclude and --tag filter a scan, so they are batch mode only: with a single note path they exit 2.
`
  )
  .addHelpText(
    'after',
    `
Prerequisite format for --auto-chain (a note's own declared prerequisites):
  • A prerequisites section is a heading that is exactly a trigger phrase: 'Prerequisites', 'Prerequisite', 'Requires', 'Required knowledge' or 'Depends on'/'Dependency on' (a leading 'Prior ' is allowed), with nothing else on the line. '## Prerequisites for the lab' is NOT such a heading.
  • Only list items under that heading count, and each must carry a [[wikilink]] or a markdown [link](target) — the link is the reference; the words around it only qualify it.
  • Prose is never read as a prerequisite: 'Prerequisite: X' written as a sentence is ignored by design, because a sentence cannot be told from a description of what a lesson involves.
  • A hedged item is skipped, not gated: negation ('does not require [[x]]'), disjunction ('[[x]] or [[y]]'), and reversal ('a prerequisite for [[x]]') contribute no edge.
`
  )
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
  .option('--force', 'Record a review before the topic is due without printing the early-review warning')
  .action(reviewCommand);

// palee assess
program
  .command('assess')
  .description('Record a four-pillar assessment and recompute topic mastery')
  .argument('<topic>', 'Topic ID or unique name fragment')
  .option('--conceptual <score>', 'Conceptual understanding score (0-1)')
  .option('--practical <score>', 'Practical application score (0-1)')
  .option('--debug <score>', 'Debugging & troubleshooting score (0-1)')
  .option('--feynman <score>', 'Feynman articulation score (0-1)')
  .action(assessCommand);

// palee validate
program
  .command('validate')
  .description('Validate vault integrity')
  .option('--fix', 'Repair corrupted SM-2 review fields to adopt defaults')
  .option('--json', 'Output in JSON format')
  .option('--strict', 'Exit non-zero on warnings as well as errors')
  .action(validateCommand);

// palee roadmap
program
  .command('roadmap')
  .description('Manage learning roadmaps')
  .option('--from <file>', 'Import roadmap from a YAML or Markdown file (frontmatter, fenced YAML, or [[wikilink]] formats)')
  .option('--auto-chain', 'Chain imported topics onto the previous one - ordered by ascending order field, topics without one follow in file order after all ordered ones; an explicit non-empty depends_on wins')
  .option('--dry-run', 'Print the full per-note import plan (ids, paths, resolved depends_on, creates/updates) and write nothing')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(roadmapCommand);

// palee migrate
program
  .command('migrate')
  .description('Migrate PALEE schema and prerequisite labels to the current version')
  .option('--fix', 'Automatically update notes missing palee_schema to schema v1')
  .option('--relabel-ties', 'Store an alphabetical tiebreak as `tie` rather than `numbered` on notes whose stored label says `numbered`, so they stop gating; depends_on is never changed. Notes carrying no depends_on_source key at all - the ones adopted before that label existed - are NOT reached by this flag; they need --include-unlabeled-ties')
  .option('--include-unlabeled-ties', 'With --relabel-ties, also relabel notes that carry no depends_on_source key at all, which is what notes adopted before that label existed were left in. Opt-in because an unlabeled note is byte-identical whether the chain or a person wrote its depends_on: only the label is written, never the list, and only for a single backward edge to a same-rank sibling in the same directory with no same-rank sibling still between them. Combine with --dry-run to preview every note it would touch')
  .option('--dry-run', 'Preview without writing files: with --fix, lists the notes that would be upgraded to Schema v1; with --relabel-ties, lists the notes that would be relabelled. Writes nothing in both cases')
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
  .description('Show a learning dashboard summary')
  .option('--json', 'Output in JSON format')
  .action(dashboardCommand);

/**
 * The raw options commander parsed for the command that is about to run, or
 * `undefined` when no action ran. The catch below needs to know whether the
 * user asked for JSON, but it sits outside the action's scope, so the only
 * honest way to read the *parsed* `--json` option is to have commander hand it
 * over at the moment it dispatches (#338).
 */
let parsedActionOptions: { json?: boolean } | undefined;

program.hook('preAction', (_thisCommand, actionCommand) => {
  parsedActionOptions = actionCommand.opts() as { json?: boolean };
});

/**
 * Whether `PALEE_DEBUG` opts the user into a raw stack trace. Read as an env
 * var, the same way `src/cli/config.ts` reads `PALEE_CONFIG_DIR`, so no new CLI
 * flag is added to the documented option surface (#338).
 */
function isDebugEnabled(): boolean {
  const value = process.env.PALEE_DEBUG;
  return value !== undefined && value !== '' && value !== '0';
}

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

  // JSON mode comes from the option commander parsed for the command that ran
  // (#338) — a positional `process.argv.includes('--json')` also fires when
  // `--json` is merely a *value* (`palee config -- --json`). Fall back to that
  // sniff only when no action ran, so there is nothing parsed to consult.
  const isJson = parsedActionOptions
    ? Boolean(parsedActionOptions.json)
    : process.argv.includes('--json');
  const message = err instanceof Error ? err.message : String(err);
  if (isJson) {
    console.log(JSON.stringify({
      status: 'error',
      code: ExitCode.Unexpected,
      error: message,
    }));
  } else if (isDebugEnabled() && err instanceof Error && err.stack) {
    // The message is the user-facing diagnostic; the stack is a debugging
    // artifact that #338 reports being dumped on every fatal error. It stays
    // behind `PALEE_DEBUG`.
    console.error(err.stack);
  } else {
    console.error(message);
  }
  // #320: exiting through `process.exit` discards writes still queued to a
  // redirected stdout, so the JSON payload above could arrive truncated for
  // exactly the piped callers that read it. Setting the code and returning lets
  // the event loop drain first — the same policy the Commander branch above
  // follows.
  process.exitCode = ExitCode.Unexpected;
  return;
});
