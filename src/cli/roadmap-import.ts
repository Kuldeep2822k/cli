/**
 * Roadmap Import — Preflight Graph Check and Write Loop
 *
 * @remarks
 * The execution phase of `palee roadmap --from`, extracted from the handler in
 * `src/cli/roadmap.ts` by the P3-14 phase split (#565): the inspection and
 * composition both the pre-write graph check and the write loop share (so the
 * verdict the import refuses on before writing anything is the verdict it
 * would have skipped on mid-batch), the skipped-note graph survival check
 * (#267), and the OCC-tracked batch write with its dangling-edge report. The
 * field values this phase writes are derived only through
 * `resolveTopicUpdates` in `./roadmap-resolve`; the note IO primitives live in
 * `./roadmap-note`; chain synthesis in `./roadmap-chain`.
 */

import fs from 'fs';
import path from 'path';
import {
  updateFrontmatter,
  computeFingerprint,
  parseFrontmatter,
  ensureVaultDirectory,
  atomicWrite,
  isConflictError,
  type LoadedTopic,
} from '../storage';
import { isWithinVault } from '../storage/wikilink';
import { noteContentExceedsReadCap, oversizedWriteDiagnostic } from '../storage/source-cap';
import type { AtomicWriteOptions } from '../storage/atomic-write';
import { detectCyclesBounded } from '../engine/dependency';
import { ExitCode } from './exit-codes';
import { canonicalDeclaredPath, readBoundNote } from './roadmap-note';
import { resolveTopicUpdates } from './roadmap-resolve';
import { RoadmapTopic, TopicNode } from '../types';

/**
 * The vault-facing state an import's preflight and write loop share: the
 * canonical vault root, the roadmap's topics, the existing topics by id, and
 * the declared graph validation cleared.
 */
export interface RoadmapWriteContext {
  /** Canonical vault root (`fs.realpathSync`ed, or the lexical form when absent) */
  resolvedVault: string;
  /** The roadmap's parsed topics, in file order (already chain-synthesized) */
  topics: RoadmapTopic[];
  /** Existing vault topics keyed by `palee_id` */
  existingTopicsById: Map<string, LoadedTopic>;
  /** The declared graph the validator cleared: roadmap ids plus every other vault topic */
  topicsMap: Map<string, TopicNode>;
}

/**
 * The existence claim a roadmap write makes about its target.
 *
 * @param isNew - Whether `inspectExistingNote` found no file at the target
 * @returns `{ expectExists: false }` for a first creation, `undefined` otherwise
 *
 * @remarks
 * #565 P1-08: "the inspection found nothing" is a claim, not the absence of one, and
 * `atomicWrite` only re-tests it when it is stated. Left implicit, a note created
 * between the inspection and the rename was replaced silently — the #327 lost update,
 * in a note writer. The overwrite branch states nothing because the fingerprint it
 * already passes is the stronger claim, and leaving it unstated keeps this write shaped
 * like every other overwrite in the CLI.
 */
function writeExistenceClaim(isNew: boolean): AtomicWriteOptions | undefined {
  return isNew ? { expectExists: false } : undefined;
}

/**
 * Inspects the note one topic would write over, without creating anything.
 *
 * @param resolvedVault - Canonical vault root the containment check resolves against
 * @param targetPath - The topic's path resolved against the vault
 * @returns The target's `lstat` (`null` when it does not exist yet) and the
 * reason it cannot be used, if there is one
 *
 * @remarks
 * One implementation for two callers, so the verdict the import refuses on
 * before writing anything is the verdict it would have skipped on mid-batch:
 * {@link blockedWriteIds} and the write loop both ask this. The
 * existence test is `lstat` for the reason #264 established — `existsSync`
 * follows a link and reports `false` for a dangling one, which would let the
 * writer replace the link unseen — and a symlink whose target is inside the
 * vault stays legal here because the boundary check below is what decides it.
 */
function inspectExistingNote(
  resolvedVault: string,
  targetPath: string
): { stat: fs.Stats | null; blocker: string | null } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { stat: null, blocker: null };
    return { stat: null, blocker: `could not be inspected: ${(e as Error).message}` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { stat, blocker: 'is not a regular file' };
  }
  const relRealTarget = path.relative(resolvedVault, fs.realpathSync(targetPath));
  if (
    path.isAbsolute(relRealTarget) ||
    relRealTarget === '..' ||
    relRealTarget.startsWith('..' + path.sep) ||
    relRealTarget.split(path.sep).includes('..')
  ) {
    return { stat, blocker: 'resolves outside the vault' };
  }
  return { stat, blocker: null };
}

/**
 * Composes the note one roadmap topic writes, from bytes already read.
 *
 * @param ctx - The write context supplying the existing topics by id
 * @param topic - The roadmap entry being written
 * @param content - The note's current text, or the skeleton for a new one
 * @param existingData - That note's frontmatter, as the write reads it
 * @returns The managed keys and the exact text the write would land
 *
 * @remarks
 * Single source of truth for both the pre-write graph check and the write loop
 * (#139): the bytes the check sizes are the bytes the loop stores, so a verdict
 * derived from one cannot disagree with the other.
 */
function composeTopicWrite(
  ctx: RoadmapWriteContext,
  topic: RoadmapTopic,
  content: string,
  existingData: Record<string, unknown>
): { paleeData: Record<string, unknown>; updatedContent: string } {
  // A pillar absent from the note resolves to `undefined` and is
  // dropped here, so an import never writes an assessment score the
  // learner does not have (#191).
  const paleeData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    resolveTopicUpdates({
      topic,
      existingById: ctx.existingTopicsById.get(topic.id),
      existingAtPath: existingData,
    })
  )) {
    if (value !== undefined) paleeData[key] = value;
  }

  // Authorship rather than list comparison. A roadmap entry that declares
  // prerequisites is making the learner's claim, whatever was stored
  // before, so a leftover `toc` label would make them advisory and the
  // gate would never bite. Comparing the written list against what the note
  // held gets both directions wrong: an identical declaration kept a stale
  // label, and a title-only import — whose preserved list comes back
  // unioned with the legacy `dependencies` key — looked like a change and
  // silently turned advisory edges back into gates, re-locking the note.
  // An entry that omits `depends_on` preserves the note's own edges and the
  // label recording who authored them.
  const removals = topic.depends_on !== undefined
    ? ['dependencies', 'depends_on_source']
    : ['dependencies'];
  return { paleeData, updatedContent: updateFrontmatter(content, paleeData, removals) };
}

/**
 * The ids whose note this import will not write, each with the reason it will not.
 *
 * @param ctx - The write context: topics, canonical vault root, existing topics
 * @returns Every roadmap id the write loop will skip, mapped to the reason it
 *   will skip it, decided from the bytes on disk
 *
 * @remarks
 * The write loop fails such a topic per topic rather than storing a file every
 * reader then skips (#565 P1-10). A topic that fails keeps the `depends_on` it
 * already carries, so the graph that lands is not the graph validation cleared —
 * the hole the pass below closes. The verdict is computed here, before the first
 * write, through the very inspection and the very composer the loop uses, so the
 * two cannot disagree about which notes those are.
 *
 * Three causes, tested in the order the loop reaches them: the target is not a
 * note this command may write, the target is a regular in-vault file whose bytes
 * cannot be opened, or the composed result crosses `MAX_NOTE_SOURCE_BYTES`. The
 * middle one is the failure no metadata or size probe predicts — an over-cap
 * *target* is refused by validation and a non-regular target is the first cause —
 * so leaving it out of this set was the case where the documentation promised
 * all-or-nothing for an unreadable note while the check did not model it.
 *
 * A target that does not exist composes the skeleton the loop would create and
 * cannot trip the cap. A note whose managed block will not parse is deliberately
 * absent: the same malformed YAML keeps `loadTopics` from indexing it, so the
 * edges it holds are in no reading command's graph and modeling it could only ever
 * remove edges from the projected graph. Nothing here creates a directory or
 * writes a byte — a preflight that did either would make its own verdict stale.
 */
function blockedWriteIds(ctx: RoadmapWriteContext): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const topic of ctx.topics) {
    const absolutePath = canonicalDeclaredPath(ctx.resolvedVault, topic.path);
    if (!isWithinVault(ctx.resolvedVault, absolutePath)) continue;
    const { stat, blocker } = inspectExistingNote(ctx.resolvedVault, absolutePath);
    if (blocker !== null) {
      blocked.set(topic.id, 'cannot be read');
      continue;
    }
    // No existing file: the loop creates the note from a skeleton, which cannot
    // cross the cap.
    if (stat === null) continue;
    let content: string;
    try {
      content = readBoundNote(absolutePath, stat);
    } catch {
      // A regular in-vault note the loop will not be able to open either. It keeps
      // the `depends_on` it holds, so this is the graph check's own case.
      blocked.set(topic.id, 'its content could not be read');
      continue;
    }
    const parsed = parseFrontmatter(content);
    let updatedContent: string;
    try {
      ({ updatedContent } = composeTopicWrite(ctx, topic, content, parsed.frontmatter ?? {}));
    } catch {
      // A note whose block will not parse has always failed on its own in the
      // write loop, which the import is built to absorb. Deciding it here would
      // turn one unparseable note into a refused batch.
      continue;
    }
    if (noteContentExceedsReadCap(updatedContent)) {
      blocked.set(topic.id, 'would be written past the read cap');
    }
  }
  return blocked;
}

/**
 * Refuses the import only when a note this command will not write changes the graph
 * the validator just cleared (#267, #565).
 *
 * @param ctx - The write context: topics, canonical vault root, existing topics, declared graph
 * @returns `true` when the pre-write verdict still describes the graph that would
 * land; `false` when it does not and nothing has been written
 *
 * @remarks
 * A topic whose existing note this command cannot use — one it may not write over,
 * one whose bytes it cannot open, or one whose composed result would cross the
 * read cap — is skipped by the write loop, and a skipped note keeps whatever
 * `depends_on` it already carries — not the list the roadmap declared for it, and
 * not what the validator ran with. One stored backward hop closes a loop the check
 * never saw: the import writes, exits `1`, and leaves the vault in exactly the
 * state INV-46 says means exit `3` and no writes.
 *
 * So the declared graph is rebuilt with each skipped topic contributing the edges
 * its note *holds* rather than the edges the roadmap meant for it, and checked
 * again. A cycle appearing only under that reading is the case refused here, with
 * the ids and the reason named, because "the plan changed" is why. When nothing
 * closes, the import proceeds as it always has: the skip costs its own topic and
 * the edge-integrity report still names whatever dangles. Refusing every skipped
 * note would have been the simpler rule and the worse one — it throws away a
 * partial import the user can act on.
 *
 * A skipped note the loader could not read either is modeled with no edges at all,
 * which is the honest reading: the `depends_on` on its disk is in no reading
 * command's graph, so it cannot close a loop `palee validate` would ever report.
 * The skips this refusal catches are the ones whose bytes were readable when the
 * vault was scanned and cannot be opened on the write path — which is why
 * {@link blockedWriteIds} asks the read itself and not only the target's metadata.
 */
export function planSurvivesSkippedNotes(ctx: RoadmapWriteContext): boolean {
  const blocked = blockedWriteIds(ctx);
  if (blocked.size === 0) return true;

  const effectiveIfSkipped = new Map(ctx.topicsMap);
  for (const id of blocked.keys()) {
    const stored = ctx.existingTopicsById.get(id);
    effectiveIfSkipped.set(id, {
      palee_id: id,
      depends_on: stored?.depends_on ?? [],
      topic_mastery: 0,
    });
  }
  const { cycles } = detectCyclesBounded(effectiveIfSkipped);
  if (cycles.length === 0) return true;

  console.error(
    'Error: refusing to import — the roadmap validates only if these notes are rewritten, and they will be skipped:'
  );
  for (const [id, reason] of blocked) console.error(`  • ${id} (${reason})`);
  for (const cycle of cycles.slice(0, 5)) {
    console.error(`  Cycle the skipped notes would leave behind: ${cycle.join(' → ')}`);
  }
  console.error(
    'Nothing was written. A note skipped mid-import keeps the `depends_on` it already carries.'
  );
  process.exitCode = ExitCode.Validation;
  return false;
}

/**
 * Executes batch import of parsed roadmap topics into vault notes with error isolation and OCC tracking.
 *
 * @param input - The write context plus the vault root the writes resolve through
 * @returns Promise resolving when all topics have been processed; every failure
 *   mode has set `process.exitCode` on the way out
 *
 * @remarks
 * Iterates through all roadmap topics, validating vault path boundaries and writing topic notes with frontmatter.
 * Catches and isolates per-topic errors (logging OCC conflicts vs standard write errors) and assigns exit codes (4 for conflict, 1 for other failures).
 *
 * @example
 * ```typescript
 * await importRoadmapTopics({ vaultPath, ...ctx });
 * ```
 */
export async function importRoadmapTopics(
  input: RoadmapWriteContext & { vaultPath: string }
): Promise<void> {
  const { vaultPath, resolvedVault, topics, existingTopicsById } = input;

  // #267: a note this command cannot read keeps the edges it already carries, so
  // the declared graph has to still be acyclic with those edges in it before any
  // of this batch writes.
  if (!planSurvivesSkippedNotes(input)) return;

  let created = 0;
  let updated = 0;
  let failed = 0;
  let conflicts = 0;
  // Chain synthesis and validation both run against the *declared* topic
  // list, so a topic whose note write fails still leaves its successors
  // holding a `depends_on` that points at nothing — and the dependent note
  // then disappears from `palee plan` with only a `validate` warning to say
  // why. Track what actually landed so the batch can report its own edges.
  /**
   * Final writer of each note this import touched, keyed by the path resolved
   * against the vault. Keyed on where the bytes actually landed rather than on
   * the declared path: an absolute in-vault path, and a `n/./1.md` spelling,
   * both write the one note the loader knows by a single relative path — and
   * only the last id to win a path is a topic that still exists, with edges
   * that survive on disk.
   */
  const finalIdByPath = new Map<string, string>();
  const writtenEdges: { from: string; to: string }[] = [];

  for (const topic of topics) {
    const absolutePath = canonicalDeclaredPath(resolvedVault, topic.path);

    if (!isWithinVault(resolvedVault, absolutePath)) {
      console.error(`Roadmap path escapes vault: ${topic.path}`);
      failed++;
      continue;
    }

    let resolvedTargetPath: string;

    try {
      // The canonical path, not the declared spelling: under a symlinked
      // parent the lexical form fails `ensureVaultDirectory`'s own
      // boundary check even though validation just accepted it.
      const canonicalDir = ensureVaultDirectory(vaultPath, absolutePath);
      resolvedTargetPath = path.join(canonicalDir, path.basename(absolutePath));
    } catch (e) {
      console.error(`Error creating directory for ${topic.path}: ${(e as Error).message}`);
      failed++;
      continue;
    }

    try {
      let content = '';
      let fingerprint: string | null = null;
      let isNew = false;
      let existingData: Record<string, unknown> = {};

      // The same inspection the pre-flight ran (#267). Reaching `blocker` here
      // means the target changed between the two looks — the race this layer
      // cannot close — so it still costs its own topic rather than the batch.
      // See {@link inspectExistingNote} for why the existence test is `lstat`.
      const { stat: targetStat, blocker } = inspectExistingNote(resolvedVault, resolvedTargetPath);
      if (blocker !== null) {
        console.error(`Skipped ${topic.id}: ${topic.path} ${blocker}`);
        failed++;
        continue;
      }

      if (targetStat !== null) {
        try {
          content = readBoundNote(resolvedTargetPath, targetStat);
        } catch (e: unknown) {
          // The pre-write graph check models this skip too and proceeds when the
          // edges the note holds cannot close a loop, so arriving here is the
          // expected outcome for such a topic: the skip costs this topic alone.
          console.error(`Skipped ${topic.id}: ${(e as Error).message}`);
          failed++;
          continue;
        }
        fingerprint = computeFingerprint(content);
        const parsed = parseFrontmatter(content);
        if (parsed.frontmatter) {
          existingData = parsed.frontmatter;
        }
      } else {
        isNew = true;
        content = `# ${topic.title}\n\n(Add your notes here)`;
      }


      // One composition for the pre-write graph check and this write, so the
      // bytes the check sized are the bytes that land.
      const { paleeData, updatedContent } = composeTopicWrite(input, topic, content, existingData);
      // #565 P1-10 review: validation bounded the note that was there, not the note
      // this write produces. The pre-write graph check predicts this verdict from
      // the bytes on disk (`blockedWriteIds`), so reaching it means the note
      // changed between that look and this one — the race no layer here can close.
      // It still fails this topic rather than writing a file every reader then skips.
      if (noteContentExceedsReadCap(updatedContent)) {
        throw new Error(oversizedWriteDiagnostic(Buffer.byteLength(updatedContent, 'utf8')));
      }
      await atomicWrite(
        vaultPath,
        resolvedTargetPath,
        updatedContent,
        fingerprint,
        writeExistenceClaim(isNew),
      );

      if (isNew) {
        created++;
      } else {
        updated++;
      }
      finalIdByPath.set(
        path.relative(resolvedVault, resolvedTargetPath).replace(/\\/g, '/'),
        topic.id
      );
      const writtenDeps = Array.isArray(paleeData.depends_on) ? (paleeData.depends_on as unknown[]) : [];
      for (const dep of writtenDeps) {
        if (typeof dep === 'string') writtenEdges.push({ from: topic.id, to: dep });
      }
    } catch (err: unknown) {
      const targetPath = topic.path;
      const isConflict = isConflictError(err);
      if (isConflict) {
        conflicts++;
        console.error(`  - Failed ${topic.id} (${targetPath}): OCC conflict (file locked or concurrently modified)`);
      } else {
        console.error(`  - Failed ${topic.id} (${targetPath}): ${(err as Error).message}`);
      }
      failed++;
      continue;
    }
  }

  // A topic stops existing when this import writes a different id over the note
  // it lived on, so it cannot count as a known target just because the vault
  // scan saw it before the batch. An edge naming the superseded id is dangling,
  // and this check exists to say so.
  const survivingExistingIds = [...existingTopicsById.entries()]
    .filter(([id, t]) => {
      const finalId = finalIdByPath.get((t.path ?? '').replace(/\\/g, '/'));
      return finalId === undefined || finalId === id;
    })
    .map(([id]) => id);
  // An id that lost its note later in the same batch has no edges left on
  // disk either — the file was rewritten under another id — so reporting its
  // edges would name a dependency that no longer exists anywhere, and counting
  // it as known would hide the edges pointing at it.
  const finalWriters = new Set(finalIdByPath.values());
  const knownIds = new Set<string>([...finalWriters, ...survivingExistingIds]);
  const danglingEdges = writtenEdges.filter(
    (edge) => finalWriters.has(edge.from) && !knownIds.has(edge.to)
  );
  if (danglingEdges.length > 0) {
    console.error(
      `⚠ ${danglingEdges.length} dependency edge(s) point at topics that do not exist:`
    );
    for (const edge of danglingEdges.slice(0, 10)) {
      console.error(`    ${edge.from} → ${edge.to}`);
    }
    if (danglingEdges.length > 10) {
      console.error(`    ... and ${danglingEdges.length - 10} more`);
    }
    console.error('    Those notes stay out of `palee plan` until the edge is removed or its target exists. Run palee validate.');
  }

  console.log();
  if (failed > 0) {
    console.error(`Failed to import ${failed} topics.`);
    console.log(`  Created: ${created} notes`);
    console.log(`  Updated: ${updated} notes`);
    process.exitCode = conflicts > 0 ? ExitCode.Conflict : ExitCode.PartialImport;
    return;
  } else {
    console.log('✓ Roadmap imported successfully');
    console.log(`  Created: ${created} notes`);
    console.log(`  Updated: ${updated} notes`);
    process.exitCode = ExitCode.Success;
    return;
  }
}
