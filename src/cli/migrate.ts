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
  parseFrontmatter,
  type LoadedTopic,
} from '../storage';
import { tiedByName, compareLessonOrderTier0 } from '../engine/auto-chain';
import { MigrateOptions } from '../types';

/** A note stored as `depends_on_source: numbered` whose edge a filename decided. */
interface StoredTie {
  /** Absolute path of the gated note */
  filePath: string;
  /** Vault-relative path of the predecessor it is gated behind */
  predecessorPath: string;
  /** Id of that predecessor, re-checked against the bytes immediately before writing */
  predecessorId: string;
}

/** What a relabel pass did, so the caller can pick an exit code. */
interface RelabelOutcome {
  /** Notes rewritten */
  relabelled: number;
  /** Notes skipped because the file changed between the scan and the write */
  stale: number;
  /** Writes that failed for a reason other than a conflict */
  failed: number;
  /** True when any write hit an OCC conflict or an active lock */
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
    const predecessorId = deps[0] as string;
    const pred = byId.get(predecessorId);
    if (pred === undefined) continue;
    if (path.dirname(pred.filePath) !== path.dirname(t.filePath)) continue;
    const predBase = path.basename(pred.filePath);
    const ownBase = path.basename(t.filePath);
    if (!tiedByName(predBase, ownBase)) continue;
    if (compareLessonOrderTier0(predBase, ownBase) >= 0) continue;
    found.push({
      filePath: t.filePath,
      predecessorPath: pred.path,
      predecessorId,
    });
  }
  return found;
}

/**
 * Re-checks the tie against the bytes about to be written, not the scan.
 *
 * @param content - The note as just read from disk
 * @param predecessorId - The predecessor the scan matched
 * @returns True when the note still carries a single `numbered` edge to it
 *
 * @remarks
 * The audit and the write are separated by console output and, in a batch, by
 * however long the user spends reading it. Anything editing notes in that window
 * would otherwise have its genuine gate demoted by a decision made against
 * content that no longer exists, so each candidate is confirmed against its own
 * fresh bytes before `atomicWrite` is called.
 *
 * Exported so the window it closes has a test that can fail: no single-process
 * CLI run can edit a note between this module's scan and its write, and a guard
 * nothing can reach is a guard nobody knows still works.
 */
export function tieStillHolds(content: string, predecessorId: string): boolean {
  const parsed = parseFrontmatter(content).frontmatter;
  if (parsed === null || parsed.depends_on_source !== 'numbered') return false;
  const deps = parsed.depends_on;
  return Array.isArray(deps) && deps.length === 1 && String(deps[0]) === predecessorId;
}

/**
 * Prints the stored-tie audit and, when asked, rewrites the label.
 *
 * @param vaultPath - The validated vault root
 * @param ties - Candidates from {@link findStoredTies}
 * @param apply - True when `--relabel-ties` was given
 * @param dryRun - True when `--dry-run` was given: report, and write nothing even
 *   alongside `--relabel-ties`, so a caller that always passes the flag can be
 *   made safe without editing the command.
 * @returns What the pass did; zero writes and no conflict on a report-only run
 */
async function reportStoredTies(
  vaultPath: string,
  ties: StoredTie[],
  apply: boolean,
  dryRun: boolean
): Promise<RelabelOutcome> {
  const none: RelabelOutcome = { relabelled: 0, stale: 0, failed: 0, hadConflict: false };
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
      console.log(`Dry run: would relabel ${ties.length} note(s) to \`depends_on_source: tie\`. Nothing written.`);
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
      if (!tieStillHolds(content, tie.predecessorId)) {
        console.error(`  Skipped ${tie.filePath}: its stored prerequisites changed since the scan.`);
        outcome.stale++;
        continue;
      }
      const expectedFingerprint = computeFingerprint(content);
      const updated = updateFrontmatter(content, { depends_on_source: 'tie' });
      await atomicWrite(vaultPath, tie.filePath, updated, expectedFingerprint);
      outcome.relabelled++;
    } catch (err: unknown) {
      console.error(`  Failed to relabel ${tie.filePath}: ${(err as Error).message}`);
      if (exitCodeFor(err) === ExitCode.Conflict) outcome.hadConflict = true;
      else outcome.failed++;
    }
  }
  console.log(`✓ Relabelled ${outcome.relabelled} of ${ties.length} notes to \`depends_on_source: tie\`.`
    + (outcome.stale ? ` (${outcome.stale} changed since the scan and were skipped)` : '')
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
 * note update hits an OCC/lock conflict during `--fix` or `--relabel-ties`, and
 * process.exitCode = 5 on unexpected runtime exceptions — including a
 * `--relabel-ties` write that fails for any other reason (permissions, disk), so
 * a caller never sees success on a migration that did not finish. A note skipped
 * because its prerequisites changed since the scan is reported and counted and
 * leaves the exit code alone: it simply no longer matches the pattern.
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
    // this write's conflict as its own.
    const ties = findStoredTies(loaded);
    const tieOutcome = await reportStoredTies(
      vaultPath,
      ties,
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
