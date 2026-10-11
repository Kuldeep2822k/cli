import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { resolveVaultTarget } from './vault-echo';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  loadTopics,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  type LoadedTopic,
} from '../storage';
import { tiedByName, compareLessonOrderTier0 } from '../engine/auto-chain';
import { classifyNoteForChain } from '../engine/tier0-hygiene';
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
  /**
   * True when the note carried **no** `depends_on_source` key rather than a
   * stored `numbered` one, i.e. it was adopted before the label existed (#266).
   *
   * @remarks
   * Optional and defaulting to false so the labelled population — and every
   * {@link StoredTie} built before this flag existed — reads unchanged. The two
   * populations are written the same way (the label is all this pass touches);
   * they differ in what the report may honestly say about them, so the pass keeps
   * the distinction rather than re-deriving it from the frontmatter later.
   */
  unlabeled?: boolean;
}

/** Why a note labelled `numbered` was declined rather than demoted. */
type DeclinedReason = 'multiple' | 'forward' | 'skipping';

/** What one vault scan turned up, before anything was written. */
interface StoredTieScan {
  /** Notes whose stored label can be demoted to `tie` with confidence */
  ties: StoredTie[];
  /** Notes labelled `numbered` whose single predecessor no longer resolves */
  unresolved: string[];
  /**
   * Notes labelled `numbered` whose stored edge the numbered plan cannot produce:
   * more than one prerequisite, an edge pointing at the sibling the numbering puts
   * after it, or one that steps over a sibling still in the directory. Left gated —
   * demoting them would be a guess — but counted, because a pass that says nothing
   * reads to a learner as a vault that has no such notes.
   */
  declined: DeclinedReason[];
}

/** What a relabel pass did, so the caller can pick an exit code. */
interface RelabelOutcome {
  /** Notes rewritten */
  relabelled: number;
  /** Notes skipped because a file moved under the pass between deriving and writing */
  stale: number;
  /** Writes that failed for a reason other than a conflict */
  failed: number;
  /** Notes left gated because their stored predecessor no longer resolves */
  unresolved: number;
  /** Notes left gated because their stored edge is one the numbered plan does not produce */
  declined: number;
  /** Writes refused by a lock or an OCC conflict, each of which a re-run retries */
  conflicted: number;
  /** Notes deleted between the scan and the write, so there is nothing left to relabel */
  vanished: number;
  /** Paths {@link RelabelOutcome.vanished} names, so no later pass acts on a note that is gone */
  vanishedPaths: string[];
  /** True when a write conflicted, or a note drifted while the pass held it */
  hadConflict: boolean;
}

/**
 * True when another note of the same tied rank sits strictly between a stored
 * predecessor and its dependent.
 *
 * @param siblings - Every note basename in the candidate's directory
 * @param predBase - Basename of the stored predecessor
 * @param ownBase - Basename of the candidate
 * @returns Whether the stored edge skips a sibling that is still on disk
 *
 * @remarks
 * The chain links neighbours: for `02-a`, `02-b`, `02-c` it writes `02-b → 02-a`
 * and `02-c → 02-b`, and never `02-c → 02-a`. An edge that skips a present
 * sibling is therefore not one the chain wrote, and demoting it would retire a
 * gate the learner set.
 *
 * Deleting the middle note is why this is not an adjacency test. With `02-b` gone
 * the stored `02-c → 02-a` *is* the edge the chain wrote — `02-a` is simply the
 * nearest surviving sibling — and it must still be demoted. So the property is
 * "nothing of the same rank lies between them", not "the predecessor is the
 * element immediately before this one".
 */
function survivingSiblingBetween(siblings: string[], predBase: string, ownBase: string): boolean {
  for (const other of siblings) {
    if (other === predBase || other === ownBase) continue;
    if (!tiedByName(other, ownBase)) continue;
    if (compareLessonOrderTier0(predBase, other) < 0 && compareLessonOrderTier0(other, ownBase) < 0) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an edge on a note that carries **no** `depends_on_source` key at all
 * could have been written by the auto-chain rather than typed by a person.
 *
 * @param note - The candidate: a note with an absent label
 * @param pred - The single note its `depends_on` names
 * @returns `false` when any signal says the chain never authored this edge
 *
 * @remarks
 * An absent label is the fail-closed spelling for "the learner wrote this" (see
 * {@link normalizeDependsOnSource}), and it is also exactly what the 0.5.2
 * auto-chain left behind, because the label did not exist yet. The two are the
 * same bytes on disk — that is the whole of #266 — so the caller reaching this
 * predicate has already passed `--include-unlabeled-ties` and declared its
 * unlabeled notes to be adopted ones. These are the cases where even that
 * declaration is not enough, because the planner provably did not write the edge:
 *
 * - **a legacy `dependencies` key on the note.** `normalizeDependencies` unions
 *   `dependencies` into `depends_on` (`src/storage/loader.ts:246`) and dedupes,
 *   so a note whose alias names the same id loads as a *single* predecessor and
 *   looks exactly like a chain edge. The chain only ever wrote `depends_on`, so
 *   the alias is a person's spelling or a pre-auto-chain build's, and the union
 *   hides which entry is whose: indistinguishable means refused.
 * - **either endpoint excluded by Tier-0 hygiene.** `classifyNoteForChain` drops
 *   repo-meta (`index.md`, `license.md`), translation copies and templates from
 *   the plan before any edge is written, so an edge between two of them is not
 *   one the planner could have produced however its names rank. The check is the
 *   shipped classifier, not a restatement of it.
 *
 * Every remaining signal — same directory, rank equality
 * ({@link tiedByName}), direction ({@link compareLessonOrderTier0}), and the
 * surviving-sibling rule — is applied to both populations by
 * {@link findStoredTies} itself, so this only carries what is specific to an
 * absent label.
 */
function unlabeledEdgeCouldComeFromTheChain(note: LoadedTopic, pred: LoadedTopic): boolean {
  if (note.frontmatter.dependencies !== undefined) return false;
  if (classifyNoteForChain(note.path, note.frontmatter.palee_id).cls === 'excluded') return false;
  return classifyNoteForChain(pred.path, pred.frontmatter.palee_id).cls !== 'excluded';
}

/**
 * Finds notes still locked behind an alphabetical tie the numbering never decided.
 *
 * @param topics - Every topic loaded from the vault
 * @param includeUnlabeledTies - Also consider notes with no `depends_on_source`
 *   key at all, which is what `--include-unlabeled-ties` asks for
 * @returns The notes whose stored label should read `tie`, in vault order
 *
 * @remarks
 * Before #234 an auto-chain tie was written as `depends_on_source: numbered`,
 * which gates; before the label existed at all it was written with **no** label,
 * which gates the same way. Nothing rewrites an adopted note, so both outlive the
 * fix, and the two are indistinguishable except by the label itself — which is
 * why the unlabeled population sits behind {@link includeUnlabeledTies} rather
 * than in the default scan. Absent that flag the scan is exactly what it was:
 * only notes whose label reads the exact string `numbered`.
 *
 * For either population this re-asks the planner's own predicates against what is
 * on disk, because an edge may only be demoted if the planner itself could have
 * produced it: same directory, {@link tiedByName} true of the two names, the
 * stored predecessor the one {@link compareLessonOrderTier0} would have placed
 * *first*, and nothing of the same rank still sitting between the two
 * ({@link survivingSiblingBetween}). The unlabeled population adds
 * {@link unlabeledEdgeCouldComeFromTheChain} on top.
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
 * - an edge that skips a same-rank sibling still on disk is left alone, because
 *   the chain links neighbours and never wrote such an edge;
 * - a note whose label is present but unrecognized (`depends_on_source:
 *   numbering`) is left alone: only a key that is not there at all is the 0.5.x
 *   shape, and a typo must not be overwritten (#266);
 * - a labelled note that is not `numbered` — `toc`, `declared`, `tie` — is left
 *   alone, since its label already says who authored the edge;
 * - a predecessor that no longer resolves cannot be ranked at all, so a labelled
 *   note is reported in {@link StoredTieScan.unresolved} rather than guessed at,
 *   and left to the dangling-edge report that owns that case. An unlabeled note
 *   is simply refused: that report is worded for the labelled population, and
 *   with no pair to rank this pass has no claim about the edge either way.
 *
 * The three refusals that still leave a note gated — a list of more than one
 * prerequisite, an edge pointing at the sibling the numbering puts after it, one that
 * steps over a same-rank sibling still on disk — are counted in
 * {@link StoredTieScan.declined} instead of passed over in silence. Each is a stored
 * `numbered` label that the plan contradicts, and exit 0 with no line at all reads to
 * a learner as a vault with nothing to look at. An unlabeled note is not counted: it
 * makes no `numbered` claim for the plan to contradict.
 */
function findStoredTies(topics: LoadedTopic[], includeUnlabeledTies: boolean): StoredTieScan {
  const byId = new Map<string, LoadedTopic>();
  const siblingsByDir = new Map<string, string[]>();
  for (const t of topics) {
    byId.set(t.id, t);
    const dir = path.dirname(t.filePath);
    const basenames = siblingsByDir.get(dir);
    if (basenames === undefined) siblingsByDir.set(dir, [path.basename(t.filePath)]);
    else basenames.push(path.basename(t.filePath));
  }
  const found: StoredTie[] = [];
  const unresolved: string[] = [];
  const declined: DeclinedReason[] = [];
  for (const t of topics) {
    // The raw key is the only thing that separates "no label was ever written"
    // from "the label is there but this build does not recognize it", because
    // `normalizeDependsOnSource` fails both to `undefined`. An absent raw key is
    // the 0.5.x shape; a typo is a note somebody edited, and neither is a
    // `numbered` label, which still decides the labelled population on its own.
    const unlabeled = t.frontmatter.depends_on_source === undefined;
    if (unlabeled) {
      if (!includeUnlabeledTies) continue;
    } else if (t.depends_on_source !== 'numbered') {
      continue;
    }
    const deps = t.depends_on ?? [];
    // More than one stored prerequisite is not a shape the numbered chain writes: it
    // gives each note its immediate predecessor, one edge at a time.
    if (deps.length > 1 && !unlabeled) declined.push('multiple');
    if (deps.length !== 1) continue;
    const pred = byId.get(deps[0] as string);
    if (pred === undefined) {
      // An unlabeled note makes no claim this pass can answer without the pair,
      // and the line below reports `numbered` labels, so it is refused in silence
      // and `palee validate` names the missing id.
      if (!unlabeled) unresolved.push(t.filePath);
      continue;
    }
    const dir = path.dirname(t.filePath);
    if (path.dirname(pred.filePath) !== dir) continue;
    const predBase = path.basename(pred.filePath);
    const ownBase = path.basename(t.filePath);
    if (!tiedByName(predBase, ownBase)) continue;
    if (compareLessonOrderTier0(predBase, ownBase) >= 0) {
      // The numbering puts the stored predecessor at or after this note, so it wrote
      // no such edge: a `numbered` label here contradicts the label's own meaning.
      if (!unlabeled) declined.push('forward');
      continue;
    }
    if (survivingSiblingBetween(siblingsByDir.get(dir) ?? [], predBase, ownBase)) {
      // #251: the middle note was deleted and a same-rank sibling still sits between
      // the pair, so the edge keeps gating and this pass may not demote it. Declining
      // was always right; saying nothing about it was not.
      if (!unlabeled) declined.push('skipping');
      continue;
    }
    if (unlabeled && !unlabeledEdgeCouldComeFromTheChain(t, pred)) continue;
    found.push({
      filePath: t.filePath,
      predecessorPath: pred.path,
      predecessorFilePath: pred.filePath,
      noteFingerprint: computeFingerprint(t.content),
      predecessorId: pred.id,
      unlabeled,
    });
  }
  return { ties: found, unresolved, declined };
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
 * @param scanned - The vault as the command loaded it: the single source of both
 *   this report and the writes it decides
 * @param apply - True when `--relabel-ties` was given
 * @param dryRun - True when `--dry-run` was given: report, and write nothing even
 *   alongside `--relabel-ties`, so a caller that always passes the flag can be
 *   made safe without editing the command.
 * @param includeUnlabeledTies - True when `--include-unlabeled-ties` was given:
 *   the scan also covers notes with no `depends_on_source` key (#266), and the
 *   report says so instead of describing them as labelled notes
 * @returns What the pass did; zero writes and no conflict on a report-only run
 *
 * @remarks
 * One list, printed and then written from, so no note can be reported one way and
 * treated another. It is derived from the scan the caller already holds: a second
 * whole-vault read here would sit one statement away from the first and close no
 * window worth its cost. The gap that matters is between deriving a tie and
 * promoting its write, and each write closes that gap for itself, below.
 *
 * Both populations are written the same way — the label is all this pass touches —
 * but only the unlabeled one gains a key it never had, so the header names which
 * notes are in front of the user and the dry run lists every one of them before
 * anything is written.
 *
 * Each write is confirmed against the state its own decision read: the gated
 * note's fingerprint, and the predecessor's identity. A mismatch means the vault
 * moved while the pass was running — the note is left exactly as it is, counted,
 * and the caller is told to re-run. A drifted candidate is refused rather than
 * re-judged mid-flight, because the re-run then makes its decision against one
 * consistent read instead of two half-reads.
 */
async function reportStoredTies(
  vaultPath: string,
  scanned: LoadedTopic[],
  apply: boolean,
  dryRun: boolean,
  includeUnlabeledTies: boolean
): Promise<RelabelOutcome> {
  const none: RelabelOutcome = {
    relabelled: 0, stale: 0, failed: 0, unresolved: 0, declined: 0, conflicted: 0, vanished: 0,
    vanishedPaths: [], hadConflict: false,
  };
  const { ties, unresolved, declined } = findStoredTies(scanned, includeUnlabeledTies);
  if (ties.length === 0 && unresolved.length === 0 && declined.length === 0) return none;
  // Which population the user is looking at, so the report and the tip below both
  // describe the notes actually in front of them.
  const unlabeledCount = ties.reduce((n, t) => (t.unlabeled === true ? n + 1 : n), 0);
  const numberedCount = ties.length - unlabeledCount;
  if (ties.length > 0) {
    console.log(`Prerequisite labels:  ${ties.length} note(s) gate behind a same-directory sibling`);
    if (unlabeledCount === 0) {
      console.log('                    their stored label says `numbered`, but the numbering did not'
        + ' decide those');
      console.log('                    orders — the filenames did, which is what `tie` means.');
    } else if (numberedCount === 0) {
      console.log('                    they carry no `depends_on_source` key at all — the shape notes');
      console.log('                    adopted before that label existed were left in. Their order');
      console.log('                    came from the filenames, which is what `tie` means.');
    } else {
      console.log(`                    ${numberedCount} say \`numbered\` and ${unlabeledCount} carry no`
        + ' `depends_on_source` key at all — the shape notes');
      console.log('                    adopted before that label existed were left in. In both cases');
      console.log('                    the filenames decided the order, which is what `tie` means.');
    }
    // A dry run is the preview of exactly what `--relabel-ties` would touch,
    // so it lists every candidate. The audit-only report keeps its limit.
    const previewAll = apply && dryRun;
    for (const tie of (previewAll ? ties : ties.slice(0, 5))) {
      console.log(`  • ${path.relative(vaultPath, tie.filePath)} → ${tie.predecessorPath}`);
    }
    if (!previewAll && ties.length > 5) console.log(`  ... and ${ties.length - 5} more`);
  }
  if (unresolved.length > 0) {
    // Counted rather than guessed at: with the predecessor gone there is no pair
    // to rank, and the chain never wrote such an edge. The dangling-edge report
    // is the one that names the missing id, so this pass defers to it in print.
    console.log(`Prerequisite labels:  ${unresolved.length} note(s) labelled \`numbered\` depend on an id`);
    console.log('                    this vault no longer contains, so no order can be derived for them.');
    console.log('                    `palee validate` reports those edges.');
  }
  if (declined.length > 0) {
    // The other half of #237's "left alone and counted". These notes do resolve, and
    // the pair is tied by name, but the numbering did not decide the edge the way the
    // note stores it — so demoting it would be a guess. Silence is the harm: a learner
    // who runs the pass to unlock a note gets exit 0 and no line at all, and reads
    // that as the vault having no problem, exactly as with #258's "Nothing to repair".
    const causes: Array<[DeclinedReason, string]> = [
      ['multiple', 'store more than one prerequisite, which the numbered chain never writes'],
      ['forward', 'point at the sibling the numbering puts after them'],
      ['skipping', 'step over a same-rank sibling still in the directory'],
    ];
    console.log(`Prerequisite labels:  ${declined.length} note(s) labelled \`numbered\` hold an edge the`);
    console.log('                    numbered plan does not produce, so their labels stay as stored:');
    for (const [cause, phrase] of causes) {
      const count = declined.filter((r) => r === cause).length;
      if (count > 0) console.log(`                      • ${count} ${phrase}`);
    }
    console.log('                    `palee plan` still gates them; only the author can say what`');
    console.log('                    the order should be.');
  }
  console.log();
  if (ties.length === 0) return { ...none, unresolved: unresolved.length, declined: declined.length };

  if (!apply || dryRun) {
    if (apply) {
      console.log(`Dry run: would relabel ${ties.length} note(s) to \`depends_on_source: tie\`.`
        + ' Nothing written.');
      console.log();
    } else {
      // Name the flags that actually reach the notes being reported: a learner
      // told to run `--relabel-ties` against unlabeled notes would get the same
      // silent exit 0 that #266 is about.
      const hint = unlabeledCount > 0 ? '--relabel-ties --include-unlabeled-ties' : '--relabel-ties';
      console.log(`Tip: Run "palee migrate ${hint}" to rewrite the label. \`depends_on\` is`);
      console.log('     never touched, and a relabelled note is no longer held off `palee plan`.');
      if (unlabeledCount > 0) {
        console.log(`     Add "--dry-run" first: these ${unlabeledCount} note(s) have no label, so the`);
        console.log('     pass would be writing a key they never had, and only the user can say');
        console.log('     whether they were adopted or typed by hand.');
      }
      console.log();
    }
    return { ...none, unresolved: unresolved.length, declined: declined.length };
  }

  // Every return from here on carries the unresolved and declined counts it just
  // printed: an audit report that named N notes and hands back 0 is the same number
  // being wrong in two places, and a caller reading the outcome would conclude the
  // vault had no dangling `numbered` edge at all.
  const outcome: RelabelOutcome = {
    ...none, unresolved: unresolved.length, declined: declined.length, vanishedPaths: [],
  };
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
      // A note deleted between the scan and this write is not a failed write, and
      // it is not gated either — there is nothing left to gate. Counting it as one
      // sent the caller off to repair a note that does not exist, under exit `5`.
      // ENOENT from anywhere in this try is not proof the note is gone: the
      // parent directory vanishing under `atomicWrite`, or a temp-file race in its
      // rename, raises the same code while the note sits there untouched — and a
      // note that exists still has its relabel to do. Classify as vanished only
      // when the path really is absent now.
      if ((err as { code?: string }).code === 'ENOENT' && !fs.existsSync(tie.filePath)) {
        console.error(`  Skipped ${tie.filePath}: the note no longer exists.`);
        outcome.vanished++;
        outcome.vanishedPaths.push(tie.filePath);
        continue;
      }
      console.error(`  Failed to relabel ${tie.filePath}: ${(err as Error).message}`);
      if (exitCodeFor(err) === ExitCode.Conflict) {
        // A lock or an OCC conflict is a "re-run to retry", not a write error:
        // counted nowhere but the boolean, the summary below read "Relabelled 1
        // of 2 notes" while a note had in fact been refused.
        outcome.hadConflict = true;
        outcome.conflicted++;
      } else {
        outcome.failed++;
      }
    }
  }
  console.log(`✓ Relabelled ${outcome.relabelled} of ${ties.length} notes to \`depends_on_source: tie\`.`
    + (outcome.stale ? ` (${outcome.stale} skipped: changed while writing)` : '')
    + (outcome.conflicted ? ` (${outcome.conflicted} locked: re-run to retry)` : '')
    + (outcome.vanished ? ` (${outcome.vanished} no longer exist: nothing to relabel)` : '')
    + (outcome.failed ? ` (${outcome.failed} write error(s))` : ''));
  console.log();
  return outcome;
}

/**
 * CLI command handler for validating and migrating note schema versions across the vault.
 *
 * @param options - Migration options including `--fix`, `--relabel-ties`,
 * `--include-unlabeled-ties` and `--dry-run`. The unlabeled population is reached
 * only by that third flag, so a bare `--relabel-ties` run keeps doing exactly what
 * it did before #266: notes whose label reads `numbered`, and nothing else.
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
    // A bare `migrate` only scans, so the echo is gated on the flags that actually
    // write: `--fix` always, `--relabel-ties` unless `--dry-run` (#311).
    const willWrite = options.fix === true || (options.relabelTies === true && options.dryRun !== true);
    const target = resolveVaultTarget(config, { echo: willWrite });
    if (!target) return;
    const vaultPath = target.vaultPath;
    const loaded = loadTopics(vaultPath);

    // The label audit comes before the schema report and reports its own exit
    // code here: a learner whose vault has an unrecognized schema still needs to
    // be told they are locked out of a note, and handling the failure in this
    // block keeps the schema pass's `exitCode === Conflict` check from reading
    // this write's conflict as its own. The pass decides from this same scan and
    // re-confirms every note and predecessor before promoting a write, so a vault
    // that moved under the run is refused and counted rather than rewritten from a
    // stale decision; `loaded` also serves the schema report below.
    const tieOutcome = await reportStoredTies(
      vaultPath,
      loaded,
      options.relabelTies === true,
      options.dryRun === true,
      options.includeUnlabeledTies === true
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

    // Both passes read the one pre-relabel scan, so a note the relabel pass proved
    // is gone is still in `loaded`. Reading it here fails on a path that no longer
    // exists and the schema pass files it under "Unrecognized schema" — a
    // repair instruction for a note the vault already lost. The vanished set is
    // dropped before this loop, not reported twice.
    const gone = new Set(tieOutcome.vanishedPaths);
    const scannable = gone.size === 0 ? loaded : loaded.filter((t) => !gone.has(t.filePath));

    let schemaV1 = 0;
    const missingSchema: string[] = [];
    const unrecognized: string[] = [];

    for (const t of scannable) {
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
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default migrateCommand;
