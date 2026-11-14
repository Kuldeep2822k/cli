/**
 * Batch Adoption Execute
 *
 * The execution phases of `palee adopt`'s batch mode, extracted from the
 * handler in `src/cli/adopt.ts` (P3-14 of audit issue #565): the Phase-1
 * preflight (re-read, drift refusal, compose, result-cap re-check), the
 * OCC-conflict gate, and the Phase-2 write loop with its rollback journal.
 * The plan this consumes is built in `./adopt-plan`; the handler owns the
 * preview and the confirmation gate that run before any of this.
 */

import fs from 'fs';
import {
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
  atomicWrite,
} from '../storage';
import { normalizeDependencies } from '../storage/dependencies';
import { extractDeclaredPrerequisites } from '../engine/prereq-text';
import { generateTopicId } from '../engine/topic-id';
import { noteExceedsReadCap, noteContentExceedsReadCap, oversizedNoteDiagnostic, oversizedWriteDiagnostic } from '../storage/source-cap';
import { ExitCode, exitCodeFor } from './exit-codes';
import { hasUnclosedFrontmatterOpener, type BatchScanResult } from './adopt-scan';
import {
  composeAdoptedNote,
  printOversizedResults,
  printSeveredEdges,
  formatDiagnosticPath,
  type ChainPlanState,
  type BatchComposeContext,
} from './adopt-plan';

interface RollbackRecord {
  absolutePath: string;
  relativePath: string;
  originalContent: string;
  /**
   * Fingerprint of the content this process wrote while adopting, i.e. what the note
   * should hold right now. Reverting is an overwrite of that, so it is the value the
   * restore is verified against (#334).
   */
  writtenFingerprint: string;
}

/**
 * Rolls back a partially-completed batch adoption by restoring each journaled
 * note to its original content, in reverse journal order.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param journal - Rollback journal of successfully-written notes from the current batch
 * @returns Promise resolving when all restoration attempts complete
 *
 * @remarks
 * Restoration is best-effort: a failed revert logs the error and continues with
 * the remaining journal entries so as much of the batch as possible is undone.
 *
 * @example
 * ```typescript
 * await rollbackBatch('/vault', journal);
 * ```
 */
async function rollbackBatch(vaultPath: string, journal: RollbackRecord[]): Promise<void> {
  if (journal.length === 0) return;

  console.error('\nRolling back adopted notes...');
  for (const item of [...journal].reverse()) {
    try {
      // #334: this restore used to be the one unguarded vault write in the CLI — three
      // arguments, so `expectedFingerprint` defaulted to null and nothing could tell
      // that the note had been adopted, reverted, or rewritten by a process that took
      // the lock over while this one was stalled. The revert now states its expectation:
      // the note exists, and it must still hold exactly what our adoption wrote.
      await atomicWrite(
        vaultPath,
        item.absolutePath,
        item.originalContent,
        item.writtenFingerprint,
        { expectExists: true }
      );
    } catch (err: unknown) {
      const e = err as Error;
      console.error(`  Failed to revert ${item.relativePath}: ${e.message}`);
    }
  }
}

/**
 * Runs the batch adoption's execution phases against the settled plan.
 *
 * @param input.vaultPath - Absolute path to the vault root
 * @param input.scan - The scan result; supplies the staged candidates and the
 *   dependency declarations the drift check compares against
 * @param input.chain - The plan state whose compose choices the preflight applies
 * @param input.ctx - The run-level flags the composer applies
 * @returns Resolves when the batch is written, refused, or rolled back; every
 *   failure mode has set `process.exitCode` on the way out
 *
 * @remarks
 * Phase 1 re-reads each staged note to minimize the TOCTOU window, refuses the
 * whole batch (exit `4`) when any note drifted since the scan — an identity
 * that appeared, an unclosed opener, a dependency declaration that changed, or
 * a file that grew past the read cap — re-checks the projected result cap
 * against the fresh bytes, and severs every planned edge that named a note the
 * re-check dropped. Phase 2 writes the prepared batch through `atomicWrite`
 * with an optimistic-concurrency fingerprint, journals each success, and on a
 * write error restores everything journaled so far before reporting.
 *
 * An exception escaping Phase 1's own re-read (a note deleted mid-run) is
 * deliberately not caught here: it propagates to the handler's fatal catch,
 * which reports it exactly as it always did.
 *
 * @example
 * ```typescript
 * await executeBatchAdoption({ vaultPath, scan, chain, ctx });
 * ```
 */
export async function executeBatchAdoption(input: {
  vaultPath: string;
  scan: BatchScanResult;
  chain: ChainPlanState;
  ctx: BatchComposeContext;
}): Promise<void> {
  const { vaultPath, scan, chain, ctx } = input;
  const { options } = ctx;
  const { toAdopt, scanDependencyDeclarations } = scan;

  // ─────────────────────────────────────────────────────────────────
  // Phase 1: Preflight & Preparation
  // ─────────────────────────────────────────────────────────────────
  interface PreparedBatchItem {
    absolutePath: string;
    relativePath: string;
    originalContent: string;
    fingerprint: string;
    updatedContent: string;
    /** The `depends_on` list this write carries, before any dropped note is severed */
    plannedDeps: string[];
  }

  const preparedBatch: PreparedBatchItem[] = [];
  /**
   * #565 P1-10 review — notes whose managed keys would push the file past the read
   * cap. They are dropped here rather than written, because a note no reader will load
   * is worse than a note that was not adopted: the topic would vanish silently.
   */
  const oversizedResults: Array<{ relativePath: string; reason: string }> = [];
  /**
   * Ids minted for notes this run drops. A planned edge naming one of them is an
   * edge the plan promised and the vault will not get, so the survivors carrying
   * it are re-rendered without it.
   */
  const droppedIds = new Set<string>();
  /** The note each dropped id was minted for, so the severed edge can name both sides */
  const droppedPathById = new Map<string, string>();
  /**
   * Notes whose identity moved after the scan. The scan only stages notes with
   * no `palee_id` of their own (frontmatter check above), so a truthy id on the
   * Phase-1 re-read is another process's adoption landing inside the TOCTOU
   * window. The OCC fingerprint is computed from these same bytes, so the write
   * would succeed and silently clobber that identity — exactly the scan-keyed
   * rename ADR-0015 forbids. An unclosed opener is the same loss with the id
   * hidden from the parser (the shape the scan's own guard refuses), so fresh
   * bytes in that shape refuse here too.
   */
  const driftedDuringRun: Array<{ relativePath: string; reason: string }> = [];
  for (const note of toAdopt) {
    // #565 P1-10: the scan refused oversized notes; this re-read is the same write path
    // one step later, so a note that grew past the cap joins the drift list — refused,
    // named, and the whole batch aborts before a single write (exit 4), exactly like the
    // identity and opener drifts it is listed beside.
    const { size: sourceSize } = fs.statSync(note.absolutePath);
    if (noteExceedsReadCap(sourceSize)) {
      driftedDuringRun.push({ relativePath: note.relativePath, reason: oversizedNoteDiagnostic(sourceSize) });
      continue;
    }
    // Re-read fresh content to minimize TOCTOU window
    const freshContent = fs.readFileSync(note.absolutePath, 'utf8');
    const freshFingerprint = computeFingerprint(freshContent);
    const { frontmatter } = parseFrontmatter(freshContent);

    if (frontmatter && frontmatter.palee_id) {
      // Any truthy id, of any YAML type: the scan's B7 rule treats a
      // non-string id as identity too, and neither is this command's to overwrite.
      driftedDuringRun.push({ relativePath: note.relativePath, reason: 'a palee_id is now declared' });
      continue;
    }
    if (hasUnclosedFrontmatterOpener(freshContent)) {
      driftedDuringRun.push({
        relativePath: note.relativePath,
        reason: 'the frontmatter opener is unclosed',
      });
      continue;
    }
    if (options.autoChain) {
      const scannedDeclarations = scanDependencyDeclarations.get(note.relativePath);
      const freshDeclarations = {
        dependsOn: normalizeDependencies(frontmatter?.depends_on),
        prerequisites: extractDeclaredPrerequisites(freshContent),
      };
      if (
        scannedDeclarations === undefined ||
        JSON.stringify(freshDeclarations) !== JSON.stringify(scannedDeclarations)
      ) {
        driftedDuringRun.push({
          relativePath: note.relativePath,
          reason: 'a dependency declaration changed',
        });
        continue;
      }
    }

    const topicId = note.topicId ?? generateTopicId();
    const { updatedContent, plannedDeps } = composeAdoptedNote(
      chain,
      ctx,
      note,
      freshContent,
      frontmatter,
      topicId
    );
    // #565 P1-10 review: the scan bounded the source bytes, not the result. A note
    // within a few hundred bytes of the cap crosses it once its PALEE keys are added,
    // so it is dropped here — never written — and reported by name below. The plan
    // printed above was severed for the projected drops; this branch is the re-check
    // against the bytes actually read.
    if (noteContentExceedsReadCap(updatedContent)) {
      oversizedResults.push({
        relativePath: note.relativePath,
        reason: oversizedWriteDiagnostic(Buffer.byteLength(updatedContent, 'utf8')),
      });
      droppedIds.add(topicId);
      droppedPathById.set(topicId, note.relativePath);
      continue;
    }
    preparedBatch.push({
      absolutePath: note.absolutePath,
      relativePath: note.relativePath,
      originalContent: freshContent,
      fingerprint: freshFingerprint,
      updatedContent,
      plannedDeps,
    });
  }

  // A planned edge naming a note this run will not write is an edge the plan
  // promised and the vault will not get: the dependent note would be written with
  // a `depends_on` pointing at nothing and drop out of `palee plan` with only a
  // `validate` warning to say why. Strip those ids from every survivor and
  // re-render, so what is written is the plan minus the notes that could not be.
  // Filtered here rather than in the loop because a declared prerequisite may name
  // a note prepared after it — a running "dropped so far" set would miss that edge.
  const severedEdges: { relativePath: string; droppedPath: string }[] = [];
  if (droppedIds.size > 0) {
    for (const item of preparedBatch) {
      const kept = item.plannedDeps.filter((id) => !droppedIds.has(id));
      if (kept.length === item.plannedDeps.length) continue;
      for (const id of item.plannedDeps) {
        if (droppedIds.has(id)) {
          severedEdges.push({
            relativePath: item.relativePath,
            droppedPath: droppedPathById.get(id) ?? id,
          });
        }
      }
      item.plannedDeps = kept;
      // Re-rendering the note updateFrontmatter already produced is the same
      // parse/set/stringify pass that made it, and the list can only shrink here,
      // so the cap verdict above still holds. An emptied list drops its provenance
      // label too — `depends_on_source` only ever describes edges that exist.
      item.updatedContent = updateFrontmatter(
        item.updatedContent,
        { depends_on: kept },
        kept.length === 0 ? ['depends_on_source'] : []
      );
    }
  }

  printOversizedResults(oversizedResults);
  printSeveredEdges(severedEdges);

  if (driftedDuringRun.length > 0) {
    // Refused before a single write, mirroring `adopt --undo`'s drift refusal:
    // the plan was built for notes with no identity, and these were rewritten
    // under it. Preserving a found id instead would strand every planned
    // `depends_on` edge that names the id this run had minted for the note.
    console.error(
      `Error: OCC conflict: ${driftedDuringRun.length} note(s) were modified while this run was ` +
        'planning; nothing was adopted.'
    );
    for (const { relativePath, reason } of driftedDuringRun.slice(0, 5)) {
      console.error(`  • ${formatDiagnosticPath(relativePath)} (${reason})`);
    }
    if (driftedDuringRun.length > 5) {
      console.error(`  • … and ${driftedDuringRun.length - 5} more`);
    }
    console.error('  Re-run to plan against the current bytes.');
    // A note that merely grew past the read cap reaches this same refusal. The banner
    // above talks about modification because that is the common case; the per-note
    // reason is what names the oversized one.
    process.exitCode = ExitCode.Conflict;
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 2: Execution with Rollback Journal
  // ─────────────────────────────────────────────────────────────────
  const journal: RollbackRecord[] = [];
  try {
    for (const item of preparedBatch) {
      await atomicWrite(vaultPath, item.absolutePath, item.updatedContent, item.fingerprint);
      journal.push({
        absolutePath: item.absolutePath,
        relativePath: item.relativePath,
        originalContent: item.originalContent,
        writtenFingerprint: computeFingerprint(item.updatedContent),
      });
    }

    console.log(`\n✓ Successfully adopted ${journal.length} notes into PALEE.`);
    if (options.autoChain) {
      // Counted from what was written, not from the plan: a note dropped for
      // crossing the cap never carried its edges, and the survivors carry the
      // severed remainder.
      const preparedPaths = new Set(preparedBatch.map((item) => item.relativePath));
      let edges = 0;
      for (const [relativePath, deps] of chain.chainDependsOn) {
        if (!preparedPaths.has(relativePath)) continue;
        edges += deps.filter((id) => !droppedIds.has(id)).length;
      }
      console.log(`  Auto-chained: ${edges} dependency edges wired across ${journal.length} notes.`);
    }
    return;
  } catch (writeErr: unknown) {
    const err = writeErr as Error;
    console.error(`\nBatch adoption write error: ${err.message}`);
    await rollbackBatch(vaultPath, journal);
    process.exitCode = exitCodeFor(writeErr);
    return;
  }
}
