/**
 * Adopt Command Handler
 * Adopts existing notes as PALEE topics (single-file or batch mode)
 *
 * P3-14 (#565): the batch mode's three phases live beside this handler — the
 * scan in `./adopt-scan`, the auto-chain plan and its write plan in
 * `./adopt-plan`, and the preflight/journal execution in `./adopt-execute`.
 * This file stays the orchestrator: mode detection, the single-file path, the
 * preview and its reports, and the confirmation gate, called in the same
 * order the monolith ran them.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { resolveVaultTarget } from './vault-echo';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  validatePattern,
  loadTopics,
} from '../storage';
// #312 — the per-pattern accounting behind the preview's aggregate counts.
import { tallyPatterns, type PatternTally } from '../storage/pattern-matcher';
import { noteExceedsReadCap, noteContentExceedsReadCap, oversizedNoteDiagnostic, oversizedWriteDiagnostic, MAX_NOTE_SOURCE_BYTES } from '../storage/source-cap';
import { resolveTopicMastery, carriedPillarScores } from '../engine/mastery';
import { buildTopicScaffold } from '../engine/topic-scaffold';
import { generateTopicId, isValidTopicId } from '../engine/topic-id';
// P3-13 (#565): the "is this adopted" judgment is the shared predicate — the same
// one `loadTopics` and `--undo` apply — and the repair path its refusals print.
import { INVALID_PALEE_ID_REPAIR, isValidPaleeId, type Tier0SkipReason } from '../engine/tier0-hygiene';
import { parseAutoChainTier, type AutoChainTier } from '../engine/toc-chain';
import { normalizeDependencies } from '../storage/dependencies';
import { AdoptOptions, Difficulty, normalizeDifficulty, normalizeAssessedAt } from '../types';

import { resolveNoteTitle } from '../storage/note-title';
// P3-14 (#565): the batch phases, extracted from this handler.
import { scanBatchAdoptionCandidates, hasUnclosedFrontmatterOpener } from './adopt-scan';
import {
  buildAutoChainPlan,
  settleProjectedCapDrops,
  printOversizedResults,
  printSeveredEdges,
} from './adopt-plan';
import { executeBatchAdoption } from './adopt-execute';
import adoptUndoCommand from './adopt-undo';

// P3-14 (#565): the diagnostic-path rendering moved with the plan's skip
// reports to `./adopt-plan`; re-exported so this module's public surface —
// the default handler and this helper, both imported by tests and callers —
// is unchanged.
export { formatDiagnosticPath } from './adopt-plan';

/**
 * Prompts user for interactive confirmation via CLI stdin.
 *
 * @param message - Confirmation prompt question displayed to user
 * @returns Promise resolving to `true` if user answered 'y' or 'yes', otherwise `false`
 *
 * @remarks
 * Creates a standard readline interface on `process.stdin` and `process.stdout`.
 * EOF — Ctrl+D on a TTY whose input ends — closes that interface without invoking
 * the question callback, so the close handler settles the promise as a "No" — an
 * aborted run declines instead of hanging, and `rl.close()` inside the callback
 * cannot report a second answer.
 *
 * @example
 * ```typescript
 * const confirmed = await promptConfirmation('Proceed with adoption? (y/N): ');
 * ```
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    let answered = false;
    rl.once('close', () => {
      if (answered) return;
      answered = true;
      process.stdout.write('\n');
      resolve(false);
    });
    rl.question(message, (answer) => {
      answered = true;
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * CLI command handler for adopting existing Markdown notes as PALEE topics.
 *
 * @param targetPath - Optional relative or absolute path to note file or directory
 * @param options - CLI flags for filtering, difficulty, dry-run, and batch confirmation
 * @returns Promise resolving when adoption process finishes
 *
 * @remarks
 * Supports single-file adoption and batch directory adoption. In batch mode:
 * - Scans vault using `walkVault`.
 * - Applies `--include`, `--exclude`, and `--tag` filters.
 * - Displays adoption preview and asks for confirmation (unless `--yes` is specified).
 * - Executes two-phase adoption with optimistic concurrency control and rollback journal.
 * - Measures each supplied filter pattern against the scanned scope and warns when one
 *   matched no file at all (#312).
 * Single-file mode takes no filter: an explicit path plus `--include`, `--exclude` or
 * `--tag` is a contradiction, and exits `2` rather than adopting the excluded note (#303).
 *
 * @example
 * ```typescript
 * await adoptCommand('notes/quantum.md', { difficulty: 'advanced' });
 * ```
 */
async function adoptCommand(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    // Names the vault before the first note is touched: with PALEE_CONFIG_DIR
    // unset this run silently acts on the per-user default config's vault (#311).
    // `json: false` keeps PALEE_JSON from switching this human-only command's
    // vault refusal to JSON above prose results.
    const target = resolveVaultTarget(config, { json: false });
    if (!target) return;
    const vaultPath = target.vaultPath;

    const resolvedVault = fs.realpathSync(vaultPath);

    // Validate difficulty if provided
    let difficulty: Difficulty = 'intermediate';
    if (options.difficulty !== undefined) {
      const rawInput = String(options.difficulty).trim().toLowerCase();
      const validInputs = ['beginner', 'intermediate', 'advanced', '1', '2', '3', '4', '5'];
      if (!validInputs.includes(rawInput)) {
        console.error('Error: Invalid difficulty. Must be one of: beginner, intermediate, advanced');
        process.exitCode = ExitCode.Usage;
        return;
      }
      difficulty = normalizeDifficulty(options.difficulty);
    }

    // Validate include/exclude pattern syntax early
    if (options.include) {
      try {
        validatePattern(options.include);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
    }
    if (options.exclude) {
      try {
        validatePattern(options.exclude);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
    }

    // --auto-chain is batch-only and synthesizes depends_on itself
    if (options.autoChain && options.dependsOn) {
      console.error('Error: --auto-chain is batch-only and conflicts with --depends-on');
      process.exitCode = ExitCode.Usage;
      return;
    }

    // C4 (PAL-205-C): the tier is a separate option, not an optional value on
    // `--auto-chain`. An optional-value flag swallows the following positional,
    // so `adopt --auto-chain MODULES` would have read `MODULES` as a tier and
    // exited 2 having adopted nothing — a regression of a form this command has
    // always accepted. A bare `--auto-chain` chains the numbered tree only;
    // enumeration order needs `--chain-tier full`. Anything outside the two
    // tiers is a usage error, never a silent default back to chaining.
    let autoChainTier: AutoChainTier | null = null;
    if (options.autoChain) {
      autoChainTier = options.chainTier === undefined ? 'strict' : parseAutoChainTier(options.chainTier);
      if (autoChainTier === null) {
        console.error('Error: --chain-tier expects one of: strict, full');
        process.exitCode = ExitCode.Usage;
        return;
      }
    } else if (options.chainTier !== undefined) {
      console.error('Error: --chain-tier requires --auto-chain');
      process.exitCode = ExitCode.Usage;
      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Mode Detection: Single File vs Batch
    // ─────────────────────────────────────────────────────────────────
    const isExplicitSingleFile =
      !options.all &&
      Boolean(targetPath) &&
      fs.existsSync(path.resolve(vaultPath, targetPath!)) &&
      fs.statSync(path.resolve(vaultPath, targetPath!)).isFile() &&
      // Case-folded like the walker: `palee adopt "Setup.MD"` used to fall out of
      // single-file mode into the batch branch, which then refused it for not
      // being a directory.
      targetPath!.toLowerCase().endsWith('.md');

    if (isExplicitSingleFile) {
      // Single-file adoption mode
      if (options.autoChain) {
        console.error('Error: --auto-chain is batch-only; it cannot be used with a single note path');
        process.exitCode = ExitCode.Usage;
        return;
      }
      // #303 — `--include`, `--exclude` and `--tag` select notes out of a directory
      // walk, and single-file mode has no walk: the learner already named the one
      // note. Validating their syntax upstream and then dropping them meant
      // `palee adopt "a/fresh.md" --exclude 'a/*.md'` exited 0 having adopted
      // exactly the note the flag excluded. An explicit path plus a filter is a
      // contradiction, and silently writing is the one outcome the user cannot
      // detect after the fact — so refuse, naming the flag and the mode. (The
      // absence of a Tier-0 hygiene pass here is a separate, deliberate choice;
      // see the note in the batch scan loop below.)
      for (const filterFlag of ['include', 'exclude', 'tag'] as const) {
        if (options[filterFlag] === undefined) continue;
        console.error(
          `Error: --${filterFlag} does not apply when a single path is given; it filters batch adoption — drop it, or pass a directory / use --all`
        );
        process.exitCode = ExitCode.Usage;
        return;
      }
      const absolutePath = path.resolve(vaultPath, targetPath!);
      const realPath = fs.realpathSync(absolutePath);

      if (!realPath.startsWith(resolvedVault + path.sep) && realPath !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      // #565 P1-10: a note this large is declined by every reading command forever, so
      // adopting it would mint an identity onto a file `palee plan` can never surface.
      // Stat before the read rather than measuring the string: the cap exists to bound
      // the read, not the parse.
      const { size: sourceSize } = fs.statSync(absolutePath);
      if (noteExceedsReadCap(sourceSize)) {
        console.error(`Error: ${targetPath} ${oversizedNoteDiagnostic(sourceSize)}; nothing was adopted.`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const { frontmatter, error: frontmatterError } = parseFrontmatter(content);

      // Refuse to write over a note whose frontmatter cannot be read: both
      // malformations can carry a `palee_id` the parser never reached, and
      // `updateFrontmatter` would either throw mid-batch or prepend a minted id
      // over the learner's own.
      if (frontmatterError !== undefined) {
        console.error(`Error: ${targetPath} has malformed frontmatter (${frontmatterError}); nothing was adopted.`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      if (hasUnclosedFrontmatterOpener(content)) {
        console.error(`Error: ${targetPath} opens a frontmatter block but never closes it; nothing was adopted.`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      if (frontmatter && frontmatter.palee_id) {
        // P3-13 (#565): the judgment is the shared predicate, the same one
        // `loadTopics` applies — a truthy non-string (`palee_id: 12345`) is NOT
        // an adopted topic, so calling it "already adopted" contradicted every
        // read command, which sees an unadopted note. PALEE also never rewrites
        // such a value — its authorship cannot be established, the same rule
        // `--undo` applies — so adoption refuses and names the one repair path.
        if (!isValidPaleeId(frontmatter.palee_id)) {
          console.error(
            `Error: ${targetPath} has a palee_id that is not a usable string (${JSON.stringify(frontmatter.palee_id)}); nothing was adopted.`
          );
          console.error(`  → ${INVALID_PALEE_ID_REPAIR}`);
          process.exitCode = ExitCode.Usage;
          return;
        }
        console.error(`Error: Note already adopted as topic ${frontmatter.palee_id}`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      const flagDeps = options.dependsOn
        ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      // #442 (bug 7): a `--depends-on` id that names no adopted topic is a dangling
      // edge — it corrupts the dependency graph, and `validate` only warns on a
      // missing dependency (exit 0), so the learner found out only when a dependent
      // vanished from `palee plan`. Warn (do not refuse) so adoption still proceeds,
      // but the graph damage is visible at the moment it is created.
      if (flagDeps.length > 0) {
        const knownIds = new Set(loadTopics(vaultPath).map((t) => t.id));
        // A malformed id can never match a topic — it must be corrected. A well-formed
        // id that just is not adopted yet is a genuine forward reference that resolves
        // later. Say the right thing about each rather than lumping them under one hint.
        const malformed = flagDeps.filter((id) => !isValidTopicId(id));
        const unresolved = flagDeps.filter((id) => isValidTopicId(id) && !knownIds.has(id));
        if (malformed.length > 0) {
          console.warn(
            `⚠ Warning: --depends-on names ${malformed.length} malformed id(s) that can match no topic ` +
              `(expected T- plus lowercase kebab-case, e.g. T-git-rebase): ${malformed.join(', ')}. ` +
              'Correct them, or the edge is permanently dangling.'
          );
        }
        if (unresolved.length > 0) {
          console.warn(
            `⚠ Warning: --depends-on names ${unresolved.length} id(s) that match no adopted topic: ` +
              `${unresolved.join(', ')} — these edges will dangle until those topics exist.`
          );
        }
      }

      // #258 — a note adopted for the first time that already carries a
      // non-empty `depends_on` is stating its own prerequisites, and adoption is
      // documented as strictly non-destructive (docs/02-1) with "explicit
      // non-empty `depends_on` always wins" (docs/03-2). Reading only the flag
      // here wrote `depends_on: []` straight over that gate. `--depends-on` still
      // outranks the note: passing it in the same invocation *is* the learner
      // overriding what the frontmatter said. The list goes through the storage
      // normalizer rather than being copied verbatim so what is stored is the
      // form `loadTopics` reads back (a comma string and a flow sequence name
      // the same edges), and in the author's own order.
      const frontmatterDeps = normalizeDependencies(frontmatter?.depends_on);
      const dependsOn = flagDeps.length > 0 ? flagDeps : frontmatterDeps;

      const topicId = generateTopicId();
      const title = resolveNoteTitle(content, absolutePath, frontmatter);

      const topicMastery = resolveTopicMastery({
        conceptual: frontmatter?.conceptual,
        practical: frontmatter?.practical,
        debug: frontmatter?.debug,
        feynman: frontmatter?.feynman,
        existing: frontmatter?.topic_mastery,
        precedence: 'existing-first',
      });

      // `--difficulty` decides; without it the note's own value stands. Adoption
      // once stamped every new topic `intermediate`, overwriting a hand-authored
      // `beginner` and never reading back what the learner wrote.
      const effectiveDifficulty =
        options.difficulty === undefined ? normalizeDifficulty(frontmatter?.difficulty) : difficulty;
      const pillars = carriedPillarScores(frontmatter);

      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        title,
        difficulty: effectiveDifficulty,
        depends_on: dependsOn,
        topic_mastery: topicMastery,
        assessed_at: normalizeAssessedAt(frontmatter?.assessed_at),
        ...pillars,
        // The never-reviewed SM-2 scaffold, from the engine's one builder (P3-10) —
        // spread at this position so the written key order is unchanged.
        ...buildTopicScaffold(),
      };

      // `declared` is the label that already means "the learner wrote this list"
      // (the `## Prerequisites` path in batch mode uses it), and unlike
      // `toc`/`tie` it gates — which is the point: a hand-written prerequisite
      // has to keep holding the note off the ready list, just as it did before
      // adoption. Nothing is labelled when the note stated no dependencies, or
      // when the flag overrode them, so those cases stay exactly as today.
      if (flagDeps.length === 0 && frontmatterDeps.length > 0) {
        paleeData.depends_on_source = 'declared';
      }

      if (options.dryRun) {
        console.log(`Dry run: would adopt ${targetPath} as a new topic`);
        console.log(`  Title: ${title}`);
        console.log(`  Difficulty: ${effectiveDifficulty}`);
        if (dependsOn.length > 0) {
          console.log(`  Dependencies: ${dependsOn.join(', ')}`);
        }
        console.log('\nDry-run complete. No files were modified.');
        return;
      }

      const updatedContent = updateFrontmatter(content, paleeData);
      const fingerprint = computeFingerprint(content);

      // #565 P1-10 review: the source was under the cap, but the managed keys are about
      // to be added to it. Writing a result no reader will load would report success and
      // then hide the topic forever, so refuse before the write.
      if (noteContentExceedsReadCap(updatedContent)) {
        const writtenBytes = Buffer.byteLength(updatedContent, 'utf8');
        console.error(`Error: ${targetPath} ${oversizedWriteDiagnostic(writtenBytes)}; nothing was adopted.`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      await atomicWrite(vaultPath, absolutePath, updatedContent, fingerprint);

      console.log(`✓ Adopted as topic ${topicId}`);
      console.log(`  Title: ${title}`);
      console.log(`  Path: ${targetPath}`);
      console.log(`  Difficulty: ${effectiveDifficulty}`);
      if (dependsOn.length > 0) {
        console.log(`  Dependencies: ${dependsOn.join(', ')}`);
      }

      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Batch Adoption Mode
    // ─────────────────────────────────────────────────────────────────
    if (!targetPath && !options.all) {
      console.error('Error: Specify a note path, a directory, or use --all to adopt notes across the vault.');
      process.exitCode = ExitCode.Usage;
      return;
    }

    let scanRoot = vaultPath;
    if (targetPath) {
      const candidatePath = path.resolve(vaultPath, targetPath);
      if (!fs.existsSync(candidatePath)) {
        console.error(`Error: Target directory not found: ${targetPath}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      const realCandidate = fs.realpathSync(candidatePath);
      if (!realCandidate.startsWith(resolvedVault + path.sep) && realCandidate !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      const candidateStat = fs.statSync(candidatePath);
      if (!candidateStat.isDirectory()) {
        // A file lands in batch mode whenever it fails to qualify for single-file
        // mode — a non-markdown name, or any note passed with `--all`. Naming the
        // mistake the user actually made beats naming a directory they never typed:
        // with `--all` the fault is the file-vs-directory mismatch regardless of
        // extension; without it, a file only reaches here by not being `.md`.
        if (candidateStat.isFile()) {
          if (options.all) {
            console.error(
              `Error: ${targetPath} is a file, but --all adopts every note under a directory — pass a directory, or drop --all to adopt a single .md note`
            );
          } else {
            console.error(
              `Error: Not a markdown note: ${targetPath} — pass a .md file or a directory to adopt`
            );
          }
          process.exitCode = ExitCode.Usage;
          return;
        }
        console.error(`Error: Expected directory path for batch adoption: ${targetPath}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      scanRoot = candidatePath;
    }

    // Scan vault markdown files (the scan phase, in ./adopt-scan)
    const scan = scanBatchAdoptionCandidates(vaultPath, scanRoot, options);

    if (scan.allFiles.length === 0) {
      console.log('No markdown files found to adopt.');
      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Auto-chain planning (#73, INV-46) — the plan phase, in ./adopt-plan
    // ─────────────────────────────────────────────────────────────────
    const planOutcome = buildAutoChainPlan({ vaultPath, scan, options, tier: autoChainTier });
    if (planOutcome.aborted) return;
    const {
      chainPlan,
      chainSourceOf,
      chainRefused,
      tocLinksDeclined,
      declaredSkippedCount,
      chainWritePlan,
      chainBridgedPaths,
    } = planOutcome.state;

    const composeCtx = { options, difficulty };
    // Projected result-cap drops (#565 P1-10 review), settled to a fixed point and
    // severed from the plan before anything is previewed. Mutates the scan (drops
    // leave the batch) and the plan (their planned edges leave the write plan).
    const { projectedOversized, projectedSevered } = settleProjectedCapDrops({
      scan,
      chain: planOutcome.state,
      ctx: composeCtx,
    });

    // #312 — measure each supplied pattern against the whole scanned scope before
    // reporting on it. `matchesPattern` OR-folds, so the run could only ever print
    // one aggregate number; this keeps the accounting per pattern, in the order the
    // learner listed them, so a pattern that named no file at all can be named back.
    const filterTallies: { flag: string; tallies: PatternTally[] }[] = [
      {
        flag: '--include',
        tallies: options.include ? tallyPatterns(scan.scannedPaths, options.include) : [],
      },
      {
        flag: '--exclude',
        tallies: options.exclude ? tallyPatterns(scan.scannedPaths, options.exclude) : [],
      },
    ];

    // Display summary preview
    const scanLabel = targetPath ? targetPath.replace(/\\/g, '/') : '(Entire Vault)';
    console.log('=== PALEE Batch Adoption ===');
    console.log(`Scope:            ${scanLabel}`);
    console.log(`Total Scanned:    ${scan.allFiles.length} files`);
    console.log(`Ready to Adopt:   ${scan.toAdopt.length} notes`);
    console.log(`Already Adopted:  ${scan.alreadyAdopted.length} notes`);
    if (options.include || options.exclude) {
      console.log(`Excluded (Pattern): ${scan.skippedByPattern.length} notes`);
    }
    if (options.tag) {
      console.log(`Excluded (Tag):     ${scan.skippedByTag.length} notes`);
    }
    // #312 — `Excluded (Pattern): 0` reads the same whether the filter worked on an
    // empty inbox or the pattern can never match a file here, and only the second
    // one is a mistake the learner has to fix. Name the pattern, and name the rule
    // that usually causes it: a pattern carrying `/` is anchored at the vault root,
    // so `a/*.md` addressed a path this scope does not hold.
    for (const { flag, tallies } of filterTallies) {
      for (const tally of tallies) {
        if (tally.matches > 0) continue;
        console.log(`⚠ Warning: ${flag} '${tally.pattern}' matched no file in this scope; check the pattern.`);
        console.log(
          tally.pattern.includes('/')
            ? '    It contains `/`, so it is matched against the whole vault-relative path from the root, not against a filename — see `palee adopt --help`.'
            : '    It has no `/`, so it matches a filename in any directory — check its spelling and wildcards.'
        );
      }
    }
    if (scan.skippedUnreadable.size > 0) {
      console.log(
        `Unreadable:         ${scan.skippedUnreadable.size} notes (frontmatter will not parse; not adopted, not rewritten)`
      );
    }
    if (scan.skippedOversized.size > 0) {
      console.log(
        `Oversized:          ${scan.skippedOversized.size} notes (over the ${MAX_NOTE_SOURCE_BYTES} byte read cap; not adopted, not rewritten)`
      );
    }
    // Without `--difficulty` each note keeps the difficulty its own frontmatter
    // declares, so one number here would over-claim the run.
    console.log(
      options.difficulty === undefined
        ? 'Difficulty:         per note (its own value, default intermediate)'
        : `Difficulty:         ${difficulty}`
    );
    // INV-11 makes a malformed note a warning, not a stopped scan — and a count
    // alone is not a warning the learner can act on. Each skipped note is named
    // with the YAML that rejected it.
    for (const [relPath, reason] of scan.skippedUnreadable) {
      console.error(`Skipped ${relPath}: frontmatter will not parse (${reason})`);
    }
    for (const [relPath, reason] of scan.skippedOversized) {
      console.error(`Skipped ${relPath}: ${reason}`);
    }
    // Reported before the plan and the confirmation gate, so what is approved is
    // what is written.
    printOversizedResults(projectedOversized);
    printSeveredEdges(projectedSevered);
    if (options.autoChain) {
      if (chainRefused) {
        // C4 honest refusal: nothing in scope was chainable under this tier —
        // exit 0 with zero edges instead of inventing alphabetical
        // prerequisites. Phrased about what the plan could chain rather than
        // about whether a README exists, because a listing document whose every
        // link resolves to a note this tier will not order is the same refusal.
        console.log(
          tocLinksDeclined
            ? 'Auto-chain:       0 edges (no numbered layout; --chain-tier strict does not read a README enumeration) — try --chain-tier full'
            : 'Auto-chain:       0 edges (no numbered layout, no chainable order signal) — consider palee roadmap'
        );
      } else {
        // Count the edges this run actually writes, by the tier that authored
        // them. The previous wording promised `toAdopt.length` notes "chained by
        // prefix order", which was wrong three ways at once: under `toc` and
        // `full` some edges come from the README enumeration, a chain head
        // receives no edge at all, and an already-adopted note bridged over is
        // never rewritten.
        const writtenEdges = chainWritePlan.filter((e) => e.dependsOnPath !== null);
        const declaredWritten = writtenEdges.filter((e) => chainSourceOf.get(e.path) === 'declared').length;
        const tocWritten = writtenEdges.filter((e) => chainSourceOf.get(e.path) === 'toc').length;
        const tieWritten = writtenEdges.filter((e) => chainSourceOf.get(e.path) === 'tie').length;
        // The fourth bucket PAL-205 asked for. A planned note with no predecessor is
        // the one the tier ordered but could not gate, and without its own count the
        // line below read as "N edge(s) written" implying N notes chained — the exact
        // over-claim this block was rewritten to stop.
        const unchainedNotes = chainWritePlan.filter((e) => e.dependsOnPath === null).length;
        console.log(
          `Auto-chain:       enabled (${autoChainTier ?? 'strict'} tier — ` +
            `${writtenEdges.length} edge(s) written: ${writtenEdges.length - tocWritten - declaredWritten - tieWritten} numbered, ` +
            `${tocWritten} toc${tieWritten > 0 ? `, ${tieWritten} tie (advisory)` : ''})`
        );
        if (declaredWritten > 0 || declaredSkippedCount > 0) {
          // Its own line rather than a third bucket in the tier count above,
          // because a declared edge *replaces* the inferred one: the tier numbers
          // say what the plan could chain, this says what the notes themselves
          // said. The skip count rides along — a name that matched nothing, or
          // matched two notes, cost its own edge and nothing else, and silence
          // there would read as a complete list.
          console.log(
            `Declared:         ${declaredWritten} edge(s) from the notes' own prerequisite text` +
              (declaredSkippedCount > 0
                ? ` (${declaredSkippedCount} name(s) resolved to no single note)`
                : '')
          );
        }
        if (unchainedNotes > 0) {
          console.log(
            `Unchained:        ${unchainedNotes} note(s) the chain gave no predecessor, so their ` +
              '`depends_on` stays empty and nothing gates them'
          );
        }
      }
    }

    // B6 - per-rule hygiene report for every batch adoption, printed on the
    // dry-run and the confirmation screen so what is reviewed is what is
    // written. It is printed even when nothing survived filtering: silently
    // discarding the learner's notes is the failure mode this report exists to
    // remove, so an empty batch must still account for every skipped file.
    // Auto-chain additionally accounts for the notes the planner excluded among
    // already-adopted paths and reports backbone/leaf/phase counts; a plain
    // batch prints only the per-rule skip counts. P3-13: the invalid-`palee_id`
    // count and its repair path are part of every batch's block, not an
    // `--auto-chain` extra.
    if (
      scan.skippedByHygiene.size > 0 ||
      scan.skippedInvalidId.length > 0 ||
      (options.autoChain && chainPlan !== null)
    ) {
      const excludedFromPlan = chainPlan ? chainPlan.excluded : new Map<string, Tier0SkipReason>();
      const countFor = (reason: Tier0SkipReason): number => {
        const scanList = scan.skippedByHygiene.get(reason);
        let count = scanList ? scanList.length : 0;
        for (const r of excludedFromPlan.values()) {
          if (r === reason) count += 1;
        }
        return count;
      };
      const excludedTotal =
        countFor('repo-meta') + countFor('translation') + countFor('template');
      console.log('Tier-0 hygiene:');
      if (options.autoChain) {
        if (chainPlan) {
          console.log(`  Backbone:       ${chainPlan.counts.backbone} notes (may gate the chain)`);
          console.log(`  Leaves:         ${chainPlan.counts.leaf} notes (attached, never gate)`);
        } else {
          console.log('  Backbone:       0 notes (may gate the chain)');
          console.log('  Leaves:         0 notes (attached, never gate)');
        }
      }
      console.log(`  Skipped (meta): ${countFor('repo-meta')} notes`);
      console.log(`  Skipped (translations): ${countFor('translation')} notes`);
      console.log(`  Skipped (template): ${countFor('template')} notes`);
      if (options.autoChain) {
        console.log(
          `  Phase subtrees: ${chainPlan ? chainPlan.counts.byReason['phase-subtree'] : 0} notes collapsed to leaves`
        );
      }
      // P3-13: counted in every batch, not only under --auto-chain — the
      // plain batch used to file these notes under "Already Adopted" instead.
      if (scan.skippedInvalidId.length > 0) {
        console.log(
          `  Invalid palee_id: ${scan.skippedInvalidId.length} notes (not adopted, not chained)`
        );
        console.log(`  → ${INVALID_PALEE_ID_REPAIR}`);
      }
      console.log(`  Excluded total: ${excludedTotal} notes`);
      if (options.autoChain && !chainPlan && excludedTotal + scan.skippedInvalidId.length > 0) {
        console.log(
          '  → Nothing left to chain. Tier-0 hygiene is always on; to keep one of ' +
            'these notes anyway, adopt it directly: palee adopt "<path>"'
        );
      } else if (!options.autoChain && excludedTotal > 0) {
        console.log(
          '  Not adopted. To keep one anyway, adopt it directly: palee adopt "<path>"'
        );
      }
    }

    if (options.verbose) {
      if (scan.toAdopt.length > 0) {
        console.log('\nNotes to adopt:');
        scan.toAdopt.forEach((n) => console.log(`  + ${n.relativePath}`));
      }
      if (scan.alreadyAdopted.length > 0) {
        console.log('\nAlready adopted:');
        scan.alreadyAdopted.forEach((f) => console.log(`  = ${f}`));
      }
      if (scan.skippedByPattern.length > 0) {
        console.log('\nSkipped by pattern filter:');
        scan.skippedByPattern.forEach((f) => console.log(`  - ${f}`));
      }
      // #312 — the per-pattern numbers behind the aggregate count above, so a run
      // can be audited pattern by pattern rather than guessed at from one total.
      if (filterTallies.some((filter) => filter.tallies.length > 0)) {
        console.log('\nPattern filter accounting:');
        for (const { flag, tallies } of filterTallies) {
          for (const tally of tallies) {
            console.log(`  ${flag} '${tally.pattern}': ${tally.matches} of ${scan.scannedPaths.length} files`);
          }
        }
      }
      if (scan.skippedByTag.length > 0) {
        console.log('\nSkipped by tag filter:');
        scan.skippedByTag.forEach((f) => console.log(`  ~ ${f}`));
      }
      if (scan.skippedUnreadable.size > 0) {
        console.log('\nSkipped: frontmatter will not parse (not adopted, not rewritten):');
        for (const relPath of scan.skippedUnreadable.keys()) {
          console.log(`  ? ${relPath}`);
        }
      }
      if (scan.skippedOversized.size > 0) {
        console.log(`\nSkipped: over the ${MAX_NOTE_SOURCE_BYTES} byte read cap (not adopted):`);
        for (const relPath of scan.skippedOversized.keys()) {
          console.log(`  ? ${relPath}`);
        }
      }
      for (const [reason, list] of scan.skippedByHygiene) {
        console.log(`\nSkipped by Tier-0 hygiene (${reason}):`);
        list.forEach((f) => console.log(`  ! ${f}`));
      }
      if (options.autoChain && chainPlan && chainPlan.excluded.size > 0) {
        console.log('\nExcluded from the chain by Tier-0 hygiene:');
        for (const [relPath, reason] of chainPlan.excluded) {
          console.log(`  ! ${relPath} (${reason})`);
        }
      }
      // P3-13: listed in every batch, not only under --auto-chain.
      if (scan.skippedInvalidId.length > 0) {
        console.log('\nSkipped: palee_id is not a usable string (B7):');
        scan.skippedInvalidId.forEach((f) => console.log(`  ! ${f}`));
      }
    }

    if (options.dryRun) {
      if (chainPlan) {
        // The preview is the write plan, so it can be diffed against what the
        // commit actually does. `chainPlan.predecessorOf` spans the whole
        // scanned scope — including already-adopted notes the commit never
        // touches — so printing it showed edges that would never be applied.
        const edgeCount = chainWritePlan.filter((edge) => edge.dependsOnPath !== null).length;
        console.log(`\nPlanned dependency chain (${edgeCount} edges to write):`);
        for (const edge of chainWritePlan) {
          if (edge.dependsOnPath) {
            console.log(`  • ${edge.path} depends on ${edge.dependsOnPath}`);
          } else {
            console.log(`  • ${edge.path} (chain head)`);
          }
        }
        if (chainBridgedPaths.length > 0) {
          console.log('\nBridged over (already adopted; used as predecessors, never rewritten):');
          for (const relPath of chainBridgedPaths) {
            console.log(`  = ${relPath}`);
          }
        }
      }
      console.log('\nDry-run complete. No files were modified.');
      return;
    }

    if (scan.toAdopt.length === 0) {
      console.log('\nNo new notes matched the criteria to adopt.');
      return;
    }

    // Confirmation gate
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Error: Non-interactive environment. Use -y or --yes to confirm batch adoption.');
        process.exitCode = ExitCode.Usage;
        return;
      }

      console.log(`\nThis will initialize PALEE tracking for ${scan.toAdopt.length} notes.`);
      const confirmed = await promptConfirmation('Proceed with adoption? (y/N): ');
      if (!confirmed) {
        console.log('Aborted.');
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 1 + Phase 2 — the execute phase, in ./adopt-execute
    // ─────────────────────────────────────────────────────────────────
    await executeBatchAdoption({
      vaultPath,
      scan,
      chain: planOutcome.state,
      ctx: composeCtx,
    });
    return;
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

/**
 * The handler `palee adopt` is registered with.
 *
 * `--undo` (#299) is a mode of this command rather than a command of its own —
 * `test/docs-command-matrix.test.ts` pins the documented exit-code table to one
 * row per registered command — so the registered entry point dispatches on the
 * flag and the reversal itself lives in `./adopt-undo`. Keeping the branch here,
 * at the export, leaves the adoption path above untouched.
 */
async function adoptEntry(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  if (options.undo) {
    await adoptUndoCommand(targetPath, options);
    return;
  }
  if (options.dropTitle !== undefined) {
    // The same refusal `--chain-tier` without `--auto-chain` gets: a qualifier for
    // one mode must not be accepted by the other, where it would be silently inert.
    console.error('Error: --drop-title requires --undo; adoption never removes a key');
    process.exitCode = ExitCode.Usage;
    return;
  }
  await adoptCommand(targetPath, options);
}

export default adoptEntry;
