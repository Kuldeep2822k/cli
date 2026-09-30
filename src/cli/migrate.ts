import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  loadTopics,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  type LoadedTopic,
} from '../storage';
import { tiedByName, compareLessonOrderTier0 } from '../engine/auto-chain';
import { MigrateOptions } from '../types';

/** A note whose stored `depends_on` was ordered by its filename, not its number. */
export interface StoredTie {
  /** Absolute path of the gated note */
  filePath: string;
  /** Vault-relative path of the predecessor it is gated behind */
  predecessorPath: string;
  /** Absolute path of that predecessor, whose identity the write is confirmed against */
  predecessorFilePath: string;
  /** Fingerprint of the gated note as it was when the tie was derived */
  noteFingerprint: string;
  /**
   * The predecessor's topic id at that instant.
   *
   * Not its content, and not its inode. A tie is decided by two names in one
   * directory, so editing the predecessor says nothing about the edge — and this
   * pass edits predecessors constantly, because relabelling `02-b` is exactly
   * what happens immediately before `02-c`'s turn. Checking its bytes made a
   * chained run of ties unfinishable, and checking its inode failed for the same
   * reason one level down: `atomicWrite` replaces the file through a rename, so
   * even an unchanged note gets a new inode from the pass's own write. What the
   * derivation actually relied on is that this id still lives at this path.
   */
  predecessorId: string;
}

/** What a relabel pass did, so the caller can pick an exit code. */
interface RelabelOutcome {
  /** Notes rewritten */
  relabelled: number;
  /** Notes skipped because a file moved under the pass between deriving and writing */
  stale: number;
  /** Writes that failed for a reason other than a conflict */
  failed: number;
  /** True when a write conflicted, or a note drifted while the pass held it */
  hadConflict: boolean;
}

/**
 * Finds notes still locked behind an alphabetical tie the numbering never decided.
 *
 * @param topics - Every topic loaded from the vault
 * @returns The notes whose stored label should read `tie`, in vault order
 *
 * @remarks
 * Before #234 an auto-chained tie was written as `depends_on_source: numbered`,
 * which gates. The two labels are indistinguishable without re-deriving the
 * order, so this re-asks the planner's own predicates against what is on disk:
 * same directory, {@link tiedByName} true of the two names, and the stored
 * predecessor the one {@link compareLessonOrderTier0} would have placed *first*.
 *
 * The direction test is not decoration. Rank equality says two notes were ordered
 * by their filenames; it does not say which of them the planner put in front.
 * `02-b → 02-a` is a tie the planner wrote, and `02-a → 02-b` is the same two
 * filenames with an edge that runs against the enumeration — which a learner must
 * have authored, because nothing in the chain produces it. Relabelling the second
 * would retire a gate the learner set on purpose, which is the one harm this pass
 * can cause.
 *
 * Deliberately narrow, because one label covers a note's whole `depends_on`
 * list and demoting the wrong one removes a real gate:
 *
 * - only a note with exactly one stored predecessor is considered — a longer
 *   list may have been edited by hand, and `adopt` never wrote one;
 * - a note with no label is left alone: absent means the learner wrote it;
 * - a predecessor that no longer loads is skipped, which is the dangling-edge
 *   report's business, not this one.
 */
function findStoredTies(topics: LoadedTopic[]): StoredTie[] {
  const byId = new Map<string, LoadedTopic>();
  for (const t of topics) byId.set(t.id, t);
  const found: StoredTie[] = [];
  for (const t of topics) {
    if (t.depends_on_source !== 'numbered') continue;
    const deps = t.depends_on ?? [];
    if (deps.length !== 1) continue;
    const pred = byId.get(deps[0] as string);
    if (pred === undefined) continue;
    if (path.dirname(pred.filePath) !== path.dirname(t.filePath)) continue;
    const predBase = path.basename(pred.filePath);
    const ownBase = path.basename(t.filePath);
    if (!tiedByName(predBase, ownBase)) continue;
    if (compareLessonOrderTier0(predBase, ownBase) >= 0) continue;
    found.push({
      filePath: t.filePath,
      predecessorPath: pred.path,
      predecessorFilePath: pred.filePath,
      noteFingerprint: computeFingerprint(t.content),
      predecessorId: pred.id,
    });
  }
  return found;
}

/**
 * True while the predecessor is still the same topic the tie was derived from.
 *
 * @param vaultPath - The validated vault root
 * @param tie - The derived candidate
 * @returns `false` when it has been renamed away or replaced under its own name
 *
 * @remarks
 * Cheap on purpose: one note re-loaded, no fingerprint. A rename is the change
 * that can flip a tie into a numbering-decided edge, and it surfaces here as the
 * path going missing or holding some other topic. An edit that leaves the same
 * id at the same name cannot change which of the two notes the numbering puts
 * first, so it is not this check's business — and the pass makes that edit
 * itself, one note at a time, down a chained run of ties.
 *
 * It goes through `loadTopics` rather than parsing the frontmatter here, because
 * the loader owns how an id is read: it trims `palee_id` and every `depends_on`
 * entry, so a note stored as `palee_id: " T-a "` *is* `T-a` to the derivation.
 * Comparing a loaded id against a hand-parsed one calls that note a different
 * topic, and the pass then refuses work the vault still needs — which is why the
 * same value must come from the same reader on both sides.
 *
 * Exported so the predicate has a test that can fail. The window it guards is
 * between deriving a tie and promoting its write, which no single-process run
 * can be made to hit on command; the call site runs on every write regardless.
 */
export function predecessorIntact(vaultPath: string, tie: StoredTie): boolean {
  try {
    const reloaded = loadTopics(vaultPath, [tie.predecessorFilePath]);
    return reloaded.length === 1 && reloaded[0].id === tie.predecessorId;
  } catch {
    return false;
  }
}

/**
 * Reports the stored ties in the vault and, when asked, rewrites their labels.
 *
 * @param vaultPath - The validated vault root
 * @param scanned - The topics the command already loaded, for the report only
 * @param apply - True when `--relabel-ties` was given
 * @param dryRun - True when `--dry-run` was given: report, and write nothing even
 *   alongside `--relabel-ties`, so a caller that always passes the flag can be
 *   made safe without editing the command.
 * @returns What the pass did; zero writes and no conflict on a report-only run
 *
 * @remarks
 * One list, printed and then written from. A run that is going to write reads the
 * vault for that purpose rather than accepting the caller's scan, so the set is
 * whatever the pairs look like at the moment of the write — a predecessor renamed
 * into a numbering-decided slot drops out and keeps its gate, and an edge
 * re-pointed at another earlier same-rank sibling is in it — and no note can be
 * reported one way and treated another. A report-only run has no decision to go
 * stale, so it reuses the scan already in hand.
 *
 * Each write is then confirmed against the state its own decision read: the gated
 * note's fingerprint, and the predecessor's identity. A mismatch means the vault
 * moved while the pass was writing it — the note is left exactly as it is and the
 * caller is told to re-run, rather than the pass guessing which of the two states
 * it is entitled to rewrite.
 *
 * The second read is deliberately confined to the writing path. Scanning on a
 * report-only run too was tried, and it shifted a pre-existing `migrate --fix`
 * test that counts reads of a note to inject a concurrent edit at a chosen one.
 */
async function reportStoredTies(
  vaultPath: string,
  scanned: LoadedTopic[],
  apply: boolean,
  dryRun: boolean
): Promise<RelabelOutcome> {
  const none: RelabelOutcome = { relabelled: 0, stale: 0, failed: 0, hadConflict: false };
  const ties = findStoredTies(scanned);
  if (ties.length === 0) return none;
  console.log(`Prerequisite labels:  ${ties.length} note(s) gate behind a same-directory sibling`);
  console.log('                    their stored label says `numbered`, but the numbering did not'
    + ' decide those');
  console.log('                    orders — the filenames did, which is what `tie` means.');
  for (const tie of ties.slice(0, 5)) {
    console.log(`  • ${path.relative(vaultPath, tie.filePath)} → ${tie.predecessorPath}`);
  }
  if (ties.length > 5) console.log(`  ... and ${ties.length - 5} more`);
  console.log();

  if (!apply || dryRun) {
    if (apply) {
      console.log(`Dry run: would relabel ${ties.length} note(s) to \`depends_on_source: tie\`.`
        + ' Nothing written.');
      console.log();
    } else {
      console.log('Tip: Run "palee migrate --relabel-ties" to rewrite the label. `depends_on` is');
      console.log('     never touched, and a relabelled note is no longer held off `palee plan`.');
      console.log();
    }
    return none;
  }

  const outcome: RelabelOutcome = { ...none };
  for (const tie of ties) {
    try {
      const content = fs.readFileSync(tie.filePath, 'utf8');
      if (computeFingerprint(content) !== tie.noteFingerprint
        || !predecessorIntact(vaultPath, tie)) {
        // The note's own bytes are what the decision read, and the predecessor's
        // identity is what the ranking depended on. If either moved, neither
        // state is one this pass may rewrite from: the note is left gated and the
        // caller is told to re-run.
        console.error(`  Skipped ${tie.filePath}: ${path.relative(vaultPath, tie.predecessorFilePath)}`
          + ' or the note itself changed while the pass was running. Re-run to retry.');
        outcome.stale++;
        outcome.hadConflict = true;
        continue;
      }
      const updated = updateFrontmatter(content, { depends_on_source: 'tie' });
      await atomicWrite(vaultPath, tie.filePath, updated, tie.noteFingerprint);
      outcome.relabelled++;
    } catch (err: unknown) {
      console.error(`  Failed to relabel ${tie.filePath}: ${(err as Error).message}`);
      if (exitCodeFor(err) === ExitCode.Conflict) outcome.hadConflict = true;
      else outcome.failed++;
    }
  }
  console.log(`✓ Relabelled ${outcome.relabelled} of ${ties.length} notes to \`depends_on_source: tie\`.`
    + (outcome.stale ? ` (${outcome.stale} skipped: changed while writing)` : '')
    + (outcome.failed ? ` (${outcome.failed} write error(s))` : ''));
  console.log();
  return outcome;
}

/**
 * CLI command handler for validating and migrating note schema versions across the vault.
 *
 * @param options - Migration options including `--fix` and `--relabel-ties`.
 * @returns Promise resolving when the migration scan or update completes.
 * @remarks Sets process.exitCode = 2 if the vault path is unconfigured or invalid,
 * process.exitCode = 3 if unrecognized schemas remain, process.exitCode = 4 if any
 * note update hits an OCC/lock conflict during `--fix` or `--relabel-ties` — or if
 * a note or its predecessor changed while `--relabel-ties` held it, which is the
 * same "re-run to retry" instruction — and process.exitCode = 5 on unexpected
 * runtime exceptions, including a `--relabel-ties` write that fails for any other
 * reason (permissions, disk), so a caller never sees success on a migration that
 * did not finish.
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

    // The label audit comes before the schema report and reports its own exit
    // code here: a learner whose vault has an unrecognized schema still needs to
    // be told they are locked out of a note, and handling the failure in this
    // block keeps the schema pass's `exitCode === Conflict` check from reading
    // this write's conflict as its own. The pass scans for itself, so `loaded`
    // serves the schema report below and nothing here carries a stale decision.
    const tieOutcome = await reportStoredTies(
      vaultPath,
      loaded,
      options.relabelTies === true,
      options.dryRun === true
    );
    if (tieOutcome.hadConflict) {
      console.error('Error: OCC conflict or active lock detected while relabelling. Re-run to retry.');
      process.exitCode = ExitCode.Conflict;
      return;
    }
    if (tieOutcome.failed > 0) {
      console.error(`Error: ${tieOutcome.failed} relabel write(s) failed. The notes remain gated.`);
      process.exitCode = ExitCode.Unexpected;
      return;
    }

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
      let hadConflict = false;
      for (const filePath of missingSchema) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const expectedFingerprint = computeFingerprint(content);
          const updated = updateFrontmatter(content, { palee_schema: 1 });
          await atomicWrite(vaultPath, filePath, updated, expectedFingerprint);
          migrated++;
        } catch (err: unknown) {
          console.error(`  Failed to migrate ${filePath}: ${(err as Error).message}`);
          failed.push(filePath);
          if (exitCodeFor(err) === ExitCode.Conflict) {
            hadConflict = true;
          }
        }
      }
      console.log(`✓ Successfully migrated ${migrated} notes to Schema v1.`);
      schemaV1 += migrated;
      missingSchema.length = 0;
      missingSchema.push(...failed);
      if (hadConflict) {
        // Conflict outranks validation: the documented concurrency condition
        // requires retrying the migration, so surface it even when other
        // schema-less notes remain.
        process.exitCode = ExitCode.Conflict;
      }
    }

    if (process.exitCode === ExitCode.Conflict) {
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
      }
      console.error('Error: OCC conflict or active lock detected during migration. Re-run to retry the conflicting notes.');
      return;
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
      process.exitCode = ExitCode.Validation;
      return;
    }

    console.log();
    console.log('✓ All notes are schema v1 - no migration needed');
    return;

  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = ExitCode.Unexpected;
    return;
  }
}

export default migrateCommand;
