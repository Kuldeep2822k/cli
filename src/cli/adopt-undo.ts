/**
 * Adopt Undo Handler
 *
 * Reverses `palee adopt` (#299): strips only the frontmatter keys PALEE owns
 * from the notes the scope selects, and leaves every other byte of the note —
 * unknown keys, comments, key order and the whole body — exactly as it found it.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
  walkVault,
  relativeVaultPath,
  matchesPattern,
  matchesTags,
  validatePattern,
  readHotMemory,
  loadSessions,
} from '../storage';
import { AdoptOptions } from '../types';

/**
 * The frontmatter keys `--undo` removes, in the order `adopt.ts` writes them.
 *
 * @remarks
 * This set is read off the code, not off the prose. The first fifteen entries are
 * exactly what the two adoption paths in `src/cli/adopt.ts` hand to
 * `updateFrontmatter` (`palee_id`, `palee_schema`, `difficulty`, `depends_on`,
 * `topic_mastery`, `assessed_at`, the four pillars, `ease_factor`,
 * `interval_days`, `repetition`, `lapses`, `last_quality`, `last_reviewed_at`,
 * `due_at`), which is also the order documented for the flat topic note, plus
 * `depends_on_source`, the provenance label adoption writes whenever it lays an
 * edge and `migrate --relabel-ties` rewrites. `topic`, `track`, `status`,
 * `dependencies`, `assessment` and `review` are the remaining names on the
 * PALEE-owned key list; `dependencies` is also the legacy prerequisite list
 * `normalizeDependencies()` still reads, so a note that keeps it stays gated by a
 * key PALEE put there.
 *
 * `title` is absent from the list above and is kept by default. Adoption writes
 * it, but it is not on the owned list, it is a key Obsidian authors write by hand,
 * and adoption preserves the note's own value when it has one — so reversal cannot
 * tell a minted title from an authored one. `migrate --relabel-ties` meets the same
 * shape and refuses to guess ("only the user can say whether they were adopted or
 * typed by hand"), so this command does the same thing: it leaves the key, says it
 * left it, and hands the judgement back through `--drop-title`.
 */
const PALEE_OWNED_KEYS: readonly string[] = [
  'palee_id',
  'palee_schema',
  'difficulty',
  'depends_on',
  'topic_mastery',
  'assessed_at',
  'conceptual',
  'practical',
  'debug',
  'feynman',
  'ease_factor',
  'interval_days',
  'repetition',
  'lapses',
  'last_quality',
  'last_reviewed_at',
  'due_at',
  'depends_on_source',
  'topic',
  'track',
  'status',
  'dependencies',
  'assessment',
  'review',
];

/** The display title `adopt` minted but does not own; removed only on request. */
const TITLE_KEY = 'title';

/** What a run says when it left a `title` key in place. */
const TITLE_KEPT_NOTE =
  '  Kept `title`: adoption writes it, but the key is not PALEE-owned and an authored';
/** The second line of {@link TITLE_KEPT_NOTE}, kept separate for column width. */
const TITLE_KEPT_NOTE_2 =
  '  title is indistinguishable from a minted one. Pass --drop-title to remove it.';
/** What a run says when `--drop-title` was asked for. */
const TITLE_KEPT_REMOVED = '  Title: removed, as --drop-title asked.';

/**
 * Whether a target still has a `title` for the run to decide about.
 *
 * @param target - The reversal target
 * @returns `true` when the note's frontmatter carries `title`
 */
function carriesTitle(target: UndoTarget): boolean {
  return Object.prototype.hasOwnProperty.call(
    parseFrontmatter(target.content).frontmatter ?? {},
    TITLE_KEY
  );
}

/** A note selected for reversal, as read during the scan. */
interface UndoTarget {
  absolutePath: string;
  relativePath: string;
  /** Bytes as read during the scan; its fingerprint is the write's OCC expectation */
  content: string;
  fingerprint: string;
  paleeId: string;
  /** Whether the un-owned `title` key is being removed too (`--drop-title`) */
  dropTitle: boolean;
  /** Owned keys actually present, in `PALEE_OWNED_KEYS` order; refreshed on prepare */
  removals: string[];
  /** Comment lines that ride on a removed key and therefore leave with it */
  lostComments: string[];
}

/** A prepared write: the note's new bytes and the fingerprint they must replace. */
interface PreparedUndoItem {
  absolutePath: string;
  relativePath: string;
  originalContent: string;
  fingerprint: string;
  updatedContent: string;
  removals: string[];
  paleeId: string;
}

/** One already-written note, for the rollback journal. */
interface RollbackRecord {
  absolutePath: string;
  relativePath: string;
  originalContent: string;
}

/** A note inside `.palee/` that still names a topic this run un-adopted. */
interface DerivedViewRef {
  paleeId: string;
  location: string;
}

/**
 * Prompts for confirmation on stdin, exactly as batch adoption does.
 *
 * @param message - Question to display
 * @returns `true` only when the answer is `y` or `yes`
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * True when a note opens a frontmatter block and never closes it.
 *
 * @param content - The note's text
 * @returns `true` for a leading `---` line with no closing delimiter anywhere
 *
 * @remarks
 * Mirrors the identically-named check in `src/cli/adopt.ts` (which is private to
 * that module, and this file must not grow a dependency on it), matched to the
 * parser's own delimiters: an unterminated opener yields `{ frontmatter: null }`
 * with no error, so a `palee_id` written under it is invisible. Adoption refuses
 * such a note; reversal has to say the same thing for the opposite reason — the
 * note reads as unadopted, and calling it "not adopted" without saying why would
 * tell a learner that a key they can see on screen does not exist.
 */
function hasUnclosedFrontmatterOpener(content: string): boolean {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return false;
  }
  return !lines.slice(1).includes('---');
}

/**
 * The `palee_id` of a note PALEE actually tracks.
 *
 * @param frontmatter - Parsed frontmatter of the note
 * @returns The trimmed id, or `null` when the note is not a loaded topic
 *
 * @remarks
 * `loadTopics()` only treats a note as a topic when `palee_id` is a non-empty
 * string, so that is the whole test for "adopted": a numeric `palee_id: 12345`
 * names no topic anywhere in the CLI, and reversal leaves it alone rather than
 * guessing the learner meant it as PALEE's. That is adoption's own B7 rule
 * applied to the inverse operation.
 */
function trackedPaleeId(frontmatter: Record<string, unknown> | null): string | null {
  if (!frontmatter) return null;
  const raw = frontmatter.palee_id;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Which removable keys a note's frontmatter actually carries.
 *
 * @param frontmatter - Parsed frontmatter of the note
 * @param dropTitle - Also treat the un-owned `title` as removable (`--drop-title`)
 * @returns The present keys to drop, in `PALEE_OWNED_KEYS` order, `title` last
 *
 * @remarks
 * Ordered by the constant rather than by `Object.keys`, so two runs over the same
 * vault print the same list and a dry-run can be diffed against the commit.
 */
function ownedKeysPresent(frontmatter: Record<string, unknown> | null, dropTitle: boolean): string[] {
  if (!frontmatter) return [];
  const present = PALEE_OWNED_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(frontmatter, key)
  );
  if (dropTitle && Object.prototype.hasOwnProperty.call(frontmatter, TITLE_KEY)) {
    present.push(TITLE_KEY);
  }
  return present;
}

/**
 * The comment lines of a frontmatter block, for a multiset comparison.
 *
 * @param raw - Raw YAML block text, or `null` when there was no block
 * @returns Each comment line, trimmed, in document order
 */
function commentLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#') && line.length > 1);
}

/**
 * Which comment lines a removal takes with it.
 *
 * @param rawBefore - Raw YAML block before the removal
 * @param rawAfter - Raw YAML block after the removal
 * @returns Comment lines present before and absent after, once per actual loss
 *
 * @remarks
 * `updateFrontmatter` is CST-preserving: it deletes a key node and re-emits
 * everything else untouched. A comment attached to the deleted node goes with the
 * node — that is the one thing `--undo` removes that the learner did not hand to
 * PALEE, and the reason it is computed and reported rather than swallowed. The
 * comparison is a multiset diff over trimmed lines, so a comment that survives
 * elsewhere in the block is not reported, and a repeated comment is reported only
 * as many times as it genuinely disappeared.
 */
function lostCommentLines(rawBefore: string | null, rawAfter: string | null): string[] {
  const remaining = commentLines(rawAfter);
  const lost: string[] = [];
  for (const line of commentLines(rawBefore)) {
    const at = remaining.indexOf(line);
    if (at === -1) {
      lost.push(line);
    } else {
      remaining.splice(at, 1);
    }
  }
  return lost;
}

/**
 * An emptied frontmatter block, collapsed away.
 *
 * @param written - The full note as `updateFrontmatter` returned it
 * @returns The note with an empty `---\n{}\n---` block removed, unchanged otherwise
 *
 * @remarks
 * A note that had no frontmatter before adoption comes back byte-identical to what
 * it was, and a note whose whole block was PALEE's does not keep an orphan `{}`
 * block behind it. The predicate is exact and lossless by construction: it fires
 * only on a block whose entire content is the empty-mapping token, which provably
 * holds no key and no comment. Anything else — including `{}` followed by a
 * surviving comment — is returned byte-for-byte as the storage layer wrote it.
 */
function collapseEmptyFrontmatter(written: string): string {
  const bom = written.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const text = bom !== '' ? written.slice(1) : written;
  const match = /^---\r?\n\{\}[ \t]*\r?\n---\r?\n/.exec(text);
  if (!match) return written;
  return `${bom}${text.slice(match[0].length)}`;
}

/**
 * Builds one reversal target from bytes read during the scan.
 *
 * @param absolutePath - Absolute path to the note
 * @param relativePath - Vault-relative path, as printed
 * @param content - Note text as read
 * @param dropTitle - Also remove the un-owned `title` key
 * @returns The target, or `null` when the note is not an adopted topic
 */
function buildTarget(
  absolutePath: string,
  relativePath: string,
  content: string,
  dropTitle: boolean
): UndoTarget | null {
  const { frontmatter } = parseFrontmatter(content);
  const paleeId = trackedPaleeId(frontmatter);
  if (paleeId === null) return null;
  return {
    absolutePath,
    relativePath,
    content,
    fingerprint: computeFingerprint(content),
    paleeId,
    dropTitle,
    removals: ownedKeysPresent(frontmatter, dropTitle),
    lostComments: [],
  };
}

/**
 * Computes the bytes a reversal writes for one note.
 *
 * @param target - The scanned note and its removal list
 * @param freshContent - The note as it reads at decision time
 * @returns The prepared write, or `null` when the fresh note has nothing owned left
 *
 * @remarks
 * Two deliberate choices, recorded back onto the target so the report matches the
 * write. The removal list is recomputed from the bytes in hand rather than reused
 * from the scan, because a key the learner added in between is not PALEE's to drop
 * and a key that vanished from disk must not be reported as removed. The write's
 * `expectedFingerprint` is the *scan-time* one: the plan this write executes was
 * decided from those bytes, so a note that moved underneath the run is a conflict
 * rather than a rewrite. `palee adopt` re-reads and adopts the newer state instead,
 * because adding keys to bytes it has just read is safe; stripping keys from bytes
 * it never saw is not.
 */
function prepareUndoWrite(target: UndoTarget, freshContent: string): PreparedUndoItem | null {
  const freshParsed = parseFrontmatter(freshContent);
  const freshRemovals = ownedKeysPresent(freshParsed.frontmatter, target.dropTitle);
  if (freshRemovals.length === 0) return null;

  const updatedContent = collapseEmptyFrontmatter(
    updateFrontmatter(freshContent, {}, freshRemovals)
  );

  target.removals = freshRemovals;
  target.lostComments = lostCommentLines(freshParsed.raw, parseFrontmatter(updatedContent).raw);

  return {
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
    originalContent: freshContent,
    fingerprint: target.fingerprint,
    updatedContent,
    removals: freshRemovals,
    paleeId: target.paleeId,
  };
}

/**
 * Restores every journaled note, newest write first.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param journal - Notes already written by the current run
 *
 * @remarks
 * Best-effort, in reverse journal order, exactly like batch adoption's rollback: a
 * reversal that half-completed is worse than one that never started, because the
 * notes still carrying a `palee_id` are the only remaining record of what the run
 * intended to take.
 */
async function rollbackBatch(vaultPath: string, journal: RollbackRecord[]): Promise<void> {
  if (journal.length === 0) return;

  console.error('\nRolling back un-adopted notes...');
  for (const item of [...journal].reverse()) {
    try {
      await atomicWrite(vaultPath, item.absolutePath, item.originalContent);
    } catch (err: unknown) {
      const e = err as Error;
      console.error(`  Failed to restore ${item.relativePath}: ${e.message}`);
    }
  }
}

/**
 * Writes a prepared batch through the storage layer's atomic OCC path.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param items - Prepared writes, in the order they were planned
 * @returns The number of notes written, or `null` when the run was refused
 *
 * @remarks
 * `atomicWrite` takes the target's `Lock`, re-checks the prior content's
 * `computeFingerprint` against disk and renames an fsynced temp file into place, so
 * this pass owns no writer and opens no second locking path. Any conflict fails the
 * whole run: the journal unwinds and the exit code comes from `exitCodeFor`, which
 * is the same 4 the rest of the CLI uses for a collision.
 */
async function commitBatch(vaultPath: string, items: PreparedUndoItem[]): Promise<number | null> {
  const journal: RollbackRecord[] = [];
  try {
    for (const item of items) {
      await atomicWrite(vaultPath, item.absolutePath, item.updatedContent, item.fingerprint);
      journal.push({
        absolutePath: item.absolutePath,
        relativePath: item.relativePath,
        originalContent: item.originalContent,
      });
    }
    return journal.length;
  } catch (writeErr: unknown) {
    const err = writeErr as Error;
    console.error(`\nBatch un-adoption write error: ${err.message}`);
    await rollbackBatch(vaultPath, journal);
    process.exitCode = exitCodeFor(writeErr);
    return null;
  }
}

/**
 * Prints which notes a reversal touches and exactly which keys it drops.
 *
 * @param targets - Planned reversal targets, already prepared
 * @param verbose - Also list the keys that stay behind
 */
function reportPlan(targets: UndoTarget[], verbose: boolean | undefined): void {
  console.log('\nKeys PALEE would remove:');
  for (const target of targets) {
    console.log(`  • ${target.relativePath} (${target.paleeId})`);
    console.log(`      removes: ${target.removals.join(', ')}`);
    if (verbose) {
      const kept = Object.keys(parseFrontmatter(target.content).frontmatter ?? {}).filter(
        (key) => !target.removals.includes(key)
      );
      console.log(`      keeps:   ${kept.length > 0 ? kept.join(', ') : '(none)'}`);
    }
    if (target.lostComments.length > 0) {
      console.log('      ⚠ Warning: removes the comment line(s) written above a PALEE key,');
      console.log('        which leave with the key they annotate:');
      for (const line of target.lostComments.slice(0, 3)) {
        console.log(`        ${line}`);
      }
      if (target.lostComments.length > 3) {
        console.log(`        … and ${target.lostComments.length - 3} more`);
      }
    }
  }
}

/**
 * Finds `.palee/` records that still name a topic this run un-adopted.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param removedIds - Topic ids actually removed by this run
 * @returns One entry per reference, in the order found
 *
 * @remarks
 * Read-only, and deliberately so. `.palee/index.md` and `.palee/hot.md` are derived
 * views of `.palee/sessions/`, and both writers take `topic_id` from the session
 * note rather than from the topic note: `regenerateIndex` enumerates the sessions
 * directory, and `rebuildHotAndIndex` copies the newest session's `topic_id` into
 * hot memory. Un-adopting a note therefore cannot leave either view out of step with
 * its source — a rebuild reproduces the bytes already there, so there is nothing to
 * rebuild and nothing to delete. What it can leave is a canonical session record
 * naming a topic no longer in the vault, which `--undo` has no claim on and must not
 * rewrite. So the reference is reported instead: `valid-hot-memory` already warns on
 * an `active_topic` that names no existing note, and this says it at the moment it
 * becomes true rather than waiting for the next `validate`.
 */
function derivedViewRefs(vaultPath: string, removedIds: Set<string>): DerivedViewRef[] {
  const refs: DerivedViewRef[] = [];
  if (removedIds.size === 0) return refs;

  try {
    const hot = readHotMemory(vaultPath);
    const activeTopic = hot.frontmatter?.active_topic;
    if (typeof activeTopic === 'string' && removedIds.has(activeTopic)) {
      refs.push({ paleeId: activeTopic, location: '.palee/hot.md active_topic' });
    }
  } catch {
    // An unreadable derived view is not this command's to diagnose; `validate` owns it.
  }

  try {
    for (const session of loadSessions(vaultPath)) {
      const topicId = session.frontmatter?.topic_id;
      if (typeof topicId === 'string' && removedIds.has(topicId)) {
        refs.push({ paleeId: topicId, location: session.path });
      }
    }
  } catch {
    // Same: a sessions directory this command cannot read is reported by other means.
  }

  return refs;
}

/**
 * Prints the derived-view notice when a reversal orphaned a `.palee/` reference.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param removedIds - Topic ids actually removed by this run
 */
function reportDerivedViews(vaultPath: string, removedIds: Set<string>): void {
  const refs = derivedViewRefs(vaultPath, removedIds);
  if (refs.length === 0) return;

  const ids = new Set(refs.map((ref) => ref.paleeId));
  console.log(
    `⚠ Warning: ${refs.length} reference(s) in .palee/ still name ${ids.size} un-adopted topic(s).`
  );
  for (const ref of refs.slice(0, 5)) {
    console.log(`    • ${ref.paleeId} — ${ref.location}`);
  }
  if (refs.length > 5) {
    console.log(`    … and ${refs.length - 5} more`);
  }
  console.log('  `.palee/index.md` and `.palee/hot.md` are derived from the session notes');
  console.log('  listed above, and those are canonical: `--undo` neither rewrites them nor');
  console.log('  rebuilds the views, because a rebuild would reproduce them byte for byte.');
  console.log('  `palee validate` reports the reference as a warning; clearing it means');
  console.log('  deleting the session, which is `palee session`\'s to do, not this command\'s.');
}

/**
 * The usage refusals this mode shares with no other flag combination.
 *
 * @param options - Flags as parsed by the CLI
 * @returns A message to print, or `null` when the flag set is coherent
 *
 * @remarks
 * Every refused flag describes something to *write*. Adoption's own batch-only,
 * mutually-exclusive discipline is the precedent: a learner who types
 * `--auto-chain --undo` is asking PALEE to wire dependencies and remove them in one
 * pass, and the answer is a refusal at exit 2, not a silent pick of one half.
 */
function usageRefusal(options: AdoptOptions): string | null {
  const conflicting: string[] = [];
  if (options.autoChain) conflicting.push('--auto-chain');
  if (options.chainTier !== undefined) conflicting.push('--chain-tier');
  if (options.dependsOn !== undefined) conflicting.push('--depends-on');
  if (options.difficulty !== undefined) conflicting.push('--difficulty');
  if (conflicting.length === 0) return null;
  return (
    `${conflicting.join(', ')} cannot be combined with --undo: --undo only removes ` +
    'PALEE-owned frontmatter keys, it never writes any'
  );
}

/**
 * CLI command handler for reversing `palee adopt`.
 *
 * @param targetPath - Optional note or directory path, selected exactly as adoption selects
 * @param options - CLI flags; `undo` is set, and the scope filters are adoption's
 * @returns Promise resolving when the reversal finishes
 *
 * @remarks
 * Reached through `palee adopt --undo`, not through a command of its own:
 * `test/docs-command-matrix.test.ts` pins the documented exit-code table to exactly
 * one row per registered command, so the inverse is a mode of the command it
 * reverses. Scope selection mirrors `adopt` — single file, directory or `--all`,
 * with `--include`, `--exclude` and `--tag` applied the same way — and the write
 * discipline is the storage layer's, not a second one.
 *
 * @example
 * ```typescript
 * await adoptUndoCommand('notes/quantum.md', { undo: true, dryRun: true });
 * ```
 */
async function adoptUndoCommand(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    if (!vaultPath) return;

    const refusal = usageRefusal(options);
    if (refusal !== null) {
      console.error(`Error: ${refusal}`);
      process.exitCode = ExitCode.Usage;
      return;
    }

    // Pattern syntax is refused before any note is opened, as in adoption: a typo
    // in `--exclude` here decides which notes lose their keys.
    for (const pattern of [options.include, options.exclude]) {
      if (!pattern) continue;
      try {
        validatePattern(pattern);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
    }

    const resolvedVault = fs.realpathSync(vaultPath);

    // ─────────────────────────────────────────────────────────────────
    // Mode Detection: Single File vs Batch — the predicate adoption uses
    // ─────────────────────────────────────────────────────────────────
    const isExplicitSingleFile =
      !options.all &&
      Boolean(targetPath) &&
      fs.existsSync(path.resolve(vaultPath, targetPath!)) &&
      fs.statSync(path.resolve(vaultPath, targetPath!)).isFile() &&
      targetPath!.toLowerCase().endsWith('.md');

    if (isExplicitSingleFile) {
      const absolutePath = path.resolve(vaultPath, targetPath!);
      const realPath = fs.realpathSync(absolutePath);
      if (!realPath.startsWith(resolvedVault + path.sep) && realPath !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = ExitCode.Usage;
        return;
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const { frontmatter, error: frontmatterError } = parseFrontmatter(content);
      if (frontmatterError !== undefined) {
        console.error(
          `Error: ${targetPath} has malformed frontmatter (${frontmatterError}); nothing was un-adopted.`
        );
        process.exitCode = ExitCode.Usage;
        return;
      }

      const target = buildTarget(
        absolutePath,
        relativeVaultPath(vaultPath, absolutePath),
        content,
        Boolean(options.dropTitle)
      );
      if (target === null) {
        const why = hasUnclosedFrontmatterOpener(content)
          ? ' — it opens a frontmatter block but never closes it, so no `palee_id` is readable'
          : '';
        console.log(`${targetPath} is not adopted${why}; nothing to un-adopt.`);
        if (frontmatter && frontmatter.palee_id !== undefined && frontmatter.palee_id !== null) {
          console.log(
            '  Note: its `palee_id` is not a usable topic id, so it was left exactly as it is.'
          );
        }
        return;
      }

      if (options.dryRun) {
        prepareUndoWrite(target, content);
        console.log('Dry run: would un-adopt 1 note and remove its PALEE-owned keys.');
        reportPlan([target], options.verbose);
        console.log('\nDry-run complete. No files were modified.');
        return;
      }

      // Re-read once and hold the scan-time fingerprint as the write's OCC
      // expectation: a note edited out-of-band in this window is a collision.
      const freshContent = fs.readFileSync(absolutePath, 'utf8');
      if (computeFingerprint(freshContent) !== target.fingerprint) {
        console.error(
          `Error: OCC conflict: ${targetPath} was modified while this run was reading it; ` +
            'nothing was un-adopted.'
        );
        process.exitCode = ExitCode.Conflict;
        return;
      }

      const prepared = prepareUndoWrite(target, freshContent);
      if (prepared === null) {
        console.log(`${targetPath} is not adopted; nothing to un-adopt.`);
        return;
      }

      const written = await commitBatch(vaultPath, [prepared]);
      if (written === null) return;

      console.log(`✓ Un-adopted topic ${prepared.paleeId}`);
      console.log(`  Path: ${targetPath}`);
      console.log(`  Keys removed: ${prepared.removals.join(', ')}`);
      if (carriesTitle(target)) {
        console.log(options.dropTitle ? TITLE_KEPT_REMOVED : `${TITLE_KEPT_NOTE}\n${TITLE_KEPT_NOTE_2}`);
      }
      for (const line of target.lostComments) {
        console.log(
          `  ⚠ Warning: removed the comment ${line}, written directly above a PALEE key,`
        );
        console.log('    so it left with the key it annotates.');
      }
      reportDerivedViews(vaultPath, new Set([prepared.paleeId]));
      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Batch Reversal
    // ─────────────────────────────────────────────────────────────────
    if (!targetPath && !options.all) {
      console.error(
        'Error: Specify a note path, a directory, or use --all with --undo to un-adopt notes across the vault.'
      );
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
      if (!fs.statSync(candidatePath).isDirectory()) {
        console.error(
          targetPath.toLowerCase().endsWith('.md')
            ? `Error: ${targetPath} is a file — drop --undo's directory scan by passing it alone, or pass a directory`
            : `Error: Not a markdown note: ${targetPath} — pass a .md file or a directory to un-adopt`
        );
        process.exitCode = ExitCode.Usage;
        return;
      }
      scanRoot = candidatePath;
    }

    const allFiles = walkVault(scanRoot);
    if (allFiles.length === 0) {
      console.log('No markdown files found to un-adopt.');
      return;
    }

    const toUndo: UndoTarget[] = [];
    const notAdopted: string[] = [];
    /** Adopted-looking notes that carry owned keys but no usable id: left alone */
    const orphanOwnedKeys: string[] = [];
    /** Notes carrying a truthy but unusable `palee_id`: left alone, named, counted */
    const unusableId: string[] = [];
    /** Notes whose `palee_id` sits under an opener that never closes: left alone */
    const unterminated: string[] = [];
    const skippedByPattern: string[] = [];
    const skippedByTag: string[] = [];
    /** Notes whose frontmatter will not parse: neither reversed nor rewritten */
    const skippedUnreadable = new Map<string, string>();

    for (const filePath of allFiles) {
      const relPath = relativeVaultPath(vaultPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, error: frontmatterError } = parseFrontmatter(content);

      if (frontmatterError !== undefined) {
        skippedUnreadable.set(relPath, frontmatterError);
        continue;
      }
      if (hasUnclosedFrontmatterOpener(content)) {
        unterminated.push(relPath);
        continue;
      }

      const paleeId = trackedPaleeId(frontmatter ?? null);
      if (paleeId === null) {
        const rawId = frontmatter?.palee_id;
        if (rawId !== undefined && rawId !== null) {
          unusableId.push(relPath);
        } else {
          // Not adopted, and that is what the report has to say — even when the note
          // carries keys PALEE owns. A hand-broken note (`palee_id` deleted by hand,
          // or `dependencies` typed by a Phase-2 template) is still a note the CLI
          // does not track, and counting it somewhere other than `Not Adopted` would
          // understate how many notes this run deliberately left alone.
          notAdopted.push(relPath);
          if (ownedKeysPresent(frontmatter ?? null, false).length > 0) {
            orphanOwnedKeys.push(relPath);
          }
        }
        continue;
      }

      // The same three filters over the same vault-relative path, so the scope
      // that adopted a set of notes is a scope that can hand the same set back.
      if (options.include && !matchesPattern(relPath, options.include)) {
        skippedByPattern.push(relPath);
        continue;
      }
      if (options.exclude && matchesPattern(relPath, options.exclude)) {
        skippedByPattern.push(relPath);
        continue;
      }
      if (options.tag && !matchesTags(frontmatter?.tags, options.tag)) {
        skippedByTag.push(relPath);
        continue;
      }

      const target = buildTarget(filePath, relPath, content, Boolean(options.dropTitle));
      if (target === null) {
        notAdopted.push(relPath);
      } else {
        toUndo.push(target);
      }
    }

    const scanLabel = targetPath ? targetPath.replace(/\\/g, '/') : '(Entire Vault)';
    console.log('=== PALEE Batch Un-adoption ===');
    console.log(`Scope:            ${scanLabel}`);
    console.log(`Total Scanned:    ${allFiles.length} files`);
    console.log(`Ready to Undo:    ${toUndo.length} notes`);
    console.log(`Not Adopted:      ${notAdopted.length} notes`);
    if (options.include || options.exclude) {
      console.log(`Excluded (Pattern): ${skippedByPattern.length} notes`);
    }
    if (options.tag) {
      console.log(`Excluded (Tag):     ${skippedByTag.length} notes`);
    }
    if (unusableId.length > 0) {
      console.log(
        `Unusable palee_id:  ${unusableId.length} notes (not a topic id; left alone, not rewritten)`
      );
    }
    if (orphanOwnedKeys.length > 0) {
      console.log(
        `Owned keys, no id:  ${orphanOwnedKeys.length} of them (no topic id, so not adopted; left alone)`
      );
    }
    if (unterminated.length > 0) {
      console.log(
        `Unreadable palee_id:  ${unterminated.length} notes (frontmatter block never closes; left alone)`
      );
    }
    if (skippedUnreadable.size > 0) {
      console.log(
        `Unreadable:         ${skippedUnreadable.size} notes (frontmatter will not parse; not rewritten)`
      );
    }
    const titlesKept = toUndo.filter((t) => !options.dropTitle && carriesTitle(t)).length;
    if (titlesKept > 0) {
      console.log(
        `Titles kept:      ${titlesKept} notes (adoption writes \`title\` but does not own it;` +
          ' --drop-title removes it)'
      );
    }
    console.log('Owned keys only:  every other frontmatter key, comment and body byte is preserved');
    for (const [relPath, reason] of skippedUnreadable) {
      console.error(`Skipped ${relPath}: frontmatter will not parse (${reason})`);
    }

    if (options.verbose) {
      if (toUndo.length > 0) {
        console.log('\nNotes to un-adopt:');
        toUndo.forEach((n) => console.log(`  • ${n.relativePath} (${n.paleeId})`));
      }
      if (notAdopted.length > 0) {
        console.log('\nNot adopted:');
        notAdopted.forEach((f) => console.log(`  = ${f}`));
      }
      if (skippedByPattern.length > 0) {
        console.log('\nSkipped by pattern filter:');
        skippedByPattern.forEach((f) => console.log(`  - ${f}`));
      }
      if (skippedByTag.length > 0) {
        console.log('\nSkipped by tag filter:');
        skippedByTag.forEach((f) => console.log(`  ~ ${f}`));
      }
      if (unusableId.length > 0) {
        console.log('\nSkipped: palee_id is not a usable string (left alone):');
        unusableId.forEach((f) => console.log(`  ! ${f}`));
      }
      if (orphanOwnedKeys.length > 0) {
        console.log('\nSkipped: PALEE-owned keys with no topic id (left alone):');
        orphanOwnedKeys.forEach((f) => console.log(`  ! ${f}`));
      }
      if (unterminated.length > 0) {
        console.log('\nSkipped: the frontmatter block is never closed (left alone):');
        unterminated.forEach((f) => console.log(`  ! ${f}`));
      }
      if (skippedUnreadable.size > 0) {
        console.log('\nSkipped: frontmatter will not parse (not rewritten):');
        for (const relPath of skippedUnreadable.keys()) {
          console.log(`  ? ${relPath}`);
        }
      }
    }

    // Prepare every write before the gate, so what is reviewed is what is written:
    // the removal lists and the comment losses the report below prints are the ones
    // the commit will act on. Preparing touches no file.
    for (const target of toUndo) {
      prepareUndoWrite(target, target.content);
    }

    if (options.dryRun) {
      if (toUndo.length > 0) {
        console.log(`\nDry run: would un-adopt ${toUndo.length} notes and remove their PALEE-owned keys.`);
        reportPlan(toUndo, options.verbose);
      } else {
        console.log('\nDry run: nothing to un-adopt in this scope.');
      }
      console.log('\nDry-run complete. No files were modified.');
      return;
    }

    if (toUndo.length === 0) {
      console.log('\nNo adopted notes matched the criteria to un-adopt.');
      return;
    }

    reportPlan(toUndo, options.verbose);

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error(
          'Error: Non-interactive environment. Use -y or --yes to confirm batch un-adoption.'
        );
        process.exitCode = ExitCode.Usage;
        return;
      }

      console.log(
        `\nThis will remove PALEE tracking from ${toUndo.length} notes. Their own content stays.`
      );
      const confirmed = await promptConfirmation('Proceed with un-adoption? (y/N): ');
      if (!confirmed) {
        console.log('Aborted.');
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: re-read every note and refuse the batch on any movement
    // ─────────────────────────────────────────────────────────────────
    const preparedBatch: PreparedUndoItem[] = [];
    const changedDuringRun: string[] = [];
    for (const target of toUndo) {
      const freshContent = fs.readFileSync(target.absolutePath, 'utf8');
      if (computeFingerprint(freshContent) !== target.fingerprint) {
        changedDuringRun.push(target.relativePath);
        continue;
      }
      try {
        const prepared = prepareUndoWrite(target, freshContent);
        if (prepared) preparedBatch.push(prepared);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Skipped ${target.relativePath}: frontmatter will not parse (${e.message})`);
      }
    }

    if (changedDuringRun.length > 0) {
      // Refused before a single write, so nothing is half-reversed: the plan named
      // these bytes and different bytes are now on disk.
      console.error(
        `Error: OCC conflict: ${changedDuringRun.length} note(s) were modified while this run was ` +
          'planning; nothing was un-adopted.'
      );
      for (const relPath of changedDuringRun.slice(0, 5)) {
        console.error(`  • ${relPath}`);
      }
      if (changedDuringRun.length > 5) {
        console.error(`  • … and ${changedDuringRun.length - 5} more`);
      }
      console.error('  Re-run to plan against the current bytes.');
      process.exitCode = ExitCode.Conflict;
      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: Execution with Rollback Journal
    // ─────────────────────────────────────────────────────────────────
    const written = await commitBatch(vaultPath, preparedBatch);
    if (written === null) return;

    if (written === 0) {
      console.log('\nNo adopted notes matched the criteria to un-adopt.');
      return;
    }

    const removedIds = new Set(preparedBatch.map((item) => item.paleeId));
    console.log(`\n✓ Successfully removed PALEE tracking from ${written} notes.`);
    console.log('  Every other frontmatter key, comment and body byte was left as written.');
    if (options.dropTitle) {
      console.log('  `title` was removed too, as --drop-title asked.');
    } else {
      console.log(
        '  `title` was left in place: adoption writes it but does not own it, and an'
      );
      console.log('  authored title is indistinguishable from a minted one. --drop-title removes it.');
    }
    reportDerivedViews(vaultPath, removedIds);
    return;
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default adoptUndoCommand;
