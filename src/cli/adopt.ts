/**
 * Adopt Command Handler
 * Adopts existing notes as PALEE topics (single-file or batch mode)
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
  loadTopics,
  deriveTocEnumeration,
} from '../storage';
import { resolveTopicMastery, normalizeScore } from '../engine/mastery';
import { generateTopicId } from '../engine/topic-id';
import { planAutoChainWithHygiene } from '../engine/auto-chain';
import { classifyNoteForChain, isValidPaleeId, type Tier0SkipReason } from '../engine/tier0-hygiene';
import {
  composeTieredChain,
  parseAutoChainTier,
  type AutoChainTier,
  type DependsOnSource,
  type TieredChainPlan,
} from '../engine/toc-chain';
import { detectCyclesBounded } from '../engine/dependency';
import { AdoptOptions, Difficulty, normalizeDifficulty, normalizeAssessedAt, type TopicNode } from '../types';

import { resolveNoteTitle } from '../storage/note-title';

/**
 * Prompts user for interactive confirmation via CLI stdin.
 *
 * @param message - Confirmation prompt question displayed to user
 * @returns Promise resolving to `true` if user answered 'y' or 'yes', otherwise `false`
 *
 * @remarks
 * Creates a standard readline interface on `process.stdin` and `process.stdout`.
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
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

interface StagedNote {
  absolutePath: string;
  relativePath: string;
  content: string;
  fingerprint: string;
  /** Pre-minted topic ID, assigned when --auto-chain plans the dependency graph up front */
  topicId?: string;
}

interface RollbackRecord {
  absolutePath: string;
  relativePath: string;
  originalContent: string;
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
      await atomicWrite(vaultPath, item.absolutePath, item.originalContent);
    } catch (err: unknown) {
      const e = err as Error;
      console.error(`  Failed to revert ${item.relativePath}: ${e.message}`);
    }
  }
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
 *
 * @example
 * ```typescript
 * await adoptCommand('notes/quantum.md', { difficulty: 'advanced' });
 * ```
 */
async function adoptCommand(targetPath?: string, options: AdoptOptions = {}): Promise<void> {
  try {
    const config = loadConfig();
    const vaultPath = validateVaultPath(config.vaultPath);
    if (!vaultPath) return;

    const resolvedVault = fs.realpathSync(vaultPath);

    // Validate difficulty if provided
    let difficulty: Difficulty = 'intermediate';
    if (options.difficulty !== undefined) {
      const rawInput = String(options.difficulty).trim().toLowerCase();
      const validInputs = ['beginner', 'intermediate', 'advanced', '1', '2', '3', '4', '5'];
      if (!validInputs.includes(rawInput)) {
        console.error('Error: Invalid difficulty. Must be one of: beginner, intermediate, advanced');
        process.exitCode = 2;
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
        process.exitCode = 2;
        return;
      }
    }
    if (options.exclude) {
      try {
        validatePattern(options.exclude);
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`Error: ${e.message}`);
        process.exitCode = 2;
        return;
      }
    }

    // --auto-chain is batch-only and synthesizes depends_on itself
    if (options.autoChain && options.dependsOn) {
      console.error('Error: --auto-chain is batch-only and conflicts with --depends-on');
      process.exitCode = ExitCode.Usage;
      return;
    }

    // C4 (PAL-205-C): --auto-chain[=strict|toc|full]. A bare flag is `full`;
    // anything outside the three tiers is a usage error, never a silent
    // default back to chaining.
    let autoChainTier: AutoChainTier | null = null;
    if (options.autoChain !== undefined && options.autoChain !== false) {
      autoChainTier = parseAutoChainTier(options.autoChain);
      if (autoChainTier === null) {
        console.error('Error: --auto-chain expects one of: strict, toc, full');
        process.exitCode = ExitCode.Usage;
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Mode Detection: Single File vs Batch
    // ─────────────────────────────────────────────────────────────────
    const isExplicitSingleFile =
      !options.all &&
      Boolean(targetPath) &&
      fs.existsSync(path.resolve(vaultPath, targetPath!)) &&
      fs.statSync(path.resolve(vaultPath, targetPath!)).isFile() &&
      targetPath!.endsWith('.md');

    if (isExplicitSingleFile) {
      // Single-file adoption mode
      if (options.autoChain) {
        console.error('Error: --auto-chain is batch-only; it cannot be used with a single note path');
        process.exitCode = ExitCode.Usage;
        return;
      }
      const absolutePath = path.resolve(vaultPath, targetPath!);
      const realPath = fs.realpathSync(absolutePath);

      if (!realPath.startsWith(resolvedVault + path.sep) && realPath !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = 2;
        return;
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      if (frontmatter && frontmatter.palee_id) {
        console.error(`Error: Note already adopted as topic ${frontmatter.palee_id}`);
        process.exitCode = 2;
        return;
      }

      const dependsOn = options.dependsOn
        ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

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

      const conceptual = normalizeScore(frontmatter?.conceptual);
      const practical = normalizeScore(frontmatter?.practical);
      const debug = normalizeScore(frontmatter?.debug);
      const feynman = normalizeScore(frontmatter?.feynman);

      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        title,
        difficulty,
        depends_on: dependsOn,
        topic_mastery: topicMastery,
        assessed_at: normalizeAssessedAt(frontmatter?.assessed_at),
        conceptual,
        practical,
        debug,
        feynman,
        ease_factor: 2.5,
        interval_days: 1,
        repetition: 0,
        lapses: 0,
        last_quality: null,
        last_reviewed_at: null,
        due_at: null,
      };

      const updatedContent = updateFrontmatter(content, paleeData);
      const fingerprint = computeFingerprint(content);

      await atomicWrite(vaultPath, absolutePath, updatedContent, fingerprint);

      console.log(`✓ Adopted as topic ${topicId}`);
      console.log(`  Title: ${title}`);
      console.log(`  Path: ${targetPath}`);
      console.log(`  Difficulty: ${difficulty}`);
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
      process.exitCode = 2;
      return;
    }

    let scanRoot = vaultPath;
    if (targetPath) {
      const candidatePath = path.resolve(vaultPath, targetPath);
      if (!fs.existsSync(candidatePath)) {
        console.error(`Error: Target directory not found: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      const realCandidate = fs.realpathSync(candidatePath);
      if (!realCandidate.startsWith(resolvedVault + path.sep) && realCandidate !== resolvedVault) {
        console.error(`Error: Path escapes vault: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      if (!fs.statSync(candidatePath).isDirectory()) {
        console.error(`Error: Expected directory path for batch adoption: ${targetPath}`);
        process.exitCode = 2;
        return;
      }
      scanRoot = candidatePath;
    }

    // Scan vault markdown files
    const allFiles = walkVault(scanRoot);

    if (allFiles.length === 0) {
      console.log('No markdown files found to adopt.');
      return;
    }

    const toAdopt: StagedNote[] = [];
    const alreadyAdopted: string[] = [];
    const skippedByPattern: string[] = [];
    const skippedByTag: string[] = [];
    /** B6 — notes Tier-0 hygiene kept out of an --auto-chain batch, by reason */
    const skippedByHygiene = new Map<Tier0SkipReason, string[]>();
    /** B7 — notes whose `palee_id` is truthy but unusable, so they are neither chained nor adopted */
    const skippedInvalidId: string[] = [];
    /** Raw parsed `palee_id` per already-adopted path, handed to the planner so it re-derives B7 itself */
    const adoptedPaleeId = new Map<string, unknown>();

    const recordHygieneSkip = (reason: Tier0SkipReason, relPath: string): void => {
      const list = skippedByHygiene.get(reason);
      if (list) {
        list.push(relPath);
      } else {
        skippedByHygiene.set(reason, [relPath]);
      }
    };

    for (const filePath of allFiles) {
      const relPath = relativeVaultPath(vaultPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // Check if already adopted
      if (frontmatter && frontmatter.palee_id) {
        // B7 — a truthy non-string `palee_id` (e.g. `palee_id: 12345`, which YAML
        // parses as a number) is invisible to `loadTopics`, which requires a
        // non-empty string. Under `--auto-chain` such a note used to be treated
        // as an adopted bridge note and then resolve to no id at all, making it
        // an unsatisfiable predecessor that silently blocked everything chaining
        // after it. It is now skipped with a counted reason: never rewritten
        // (the learner's frontmatter is left alone) and never chained.
        if (options.autoChain && !isValidPaleeId(frontmatter.palee_id)) {
          skippedInvalidId.push(relPath);
          continue;
        }
        alreadyAdopted.push(relPath);
        adoptedPaleeId.set(relPath, frontmatter.palee_id);
        continue;
      }

      // Check include filter
      if (options.include && !matchesPattern(relPath, options.include)) {
        skippedByPattern.push(relPath);
        continue;
      }

      // Check exclude filter
      if (options.exclude && matchesPattern(relPath, options.exclude)) {
        skippedByPattern.push(relPath);
        continue;
      }

      // Check tag filter
      if (options.tag && !matchesTags(frontmatter?.tags, options.tag)) {
        skippedByTag.push(relPath);
        continue;
      }

      // B1-B4 — repo meta, translation copies and templates are out of an
      // auto-chain batch entirely: they must not become topics, and they must
      // not be able to gate a real lesson. These filters are always on, so an
      // explicit `--include` narrows the candidate set but does not re-admit a
      // note hygiene excludes; a learner who really wants one of those adopts
      // it directly in single-file mode, which has no batch hygiene pass.
      if (options.autoChain) {
        const decision = classifyNoteForChain(relPath);
        if (decision.cls === 'excluded') {
          recordHygieneSkip(decision.reason ?? 'repo-meta', relPath);
          continue;
        }
      }

      toAdopt.push({
        absolutePath: filePath,
        relativePath: relPath,
        content,
        fingerprint: computeFingerprint(content),
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // Auto-chain planning (#73, INV-46)
    // ─────────────────────────────────────────────────────────────────
    // When --auto-chain is set, derive each note's depends_on predecessor
    // from numbered directory/file prefixes BEFORE the dry-run/confirmation
    // gate, so the planned graph is cycle-checked with zero writes and the
    // dry-run prints the exact edge plan. The plan spans every note in the
    // scanned scope — including notes already adopted there — so the chain
    // bridges over an adopted note instead of restarting; already-adopted
    // notes only ever appear as predecessors, never as write targets.
    let chainPlan: TieredChainPlan | null = null;
    /** Note → tier that authored its planned edge (C5 `depends_on_source`) */
    const chainSourceOf: Map<string, DependsOnSource> = new Map();
    /** C4 honest refusal: the scope carries no numbering and no TOC enumeration */
    let chainRefused = false;
    const chainDependsOn = new Map<string, string[]>();
    // Dry-run preview must show exactly what the commit will write, so the plan
    // is recorded here at graph-build time rather than re-derived from
    // `chainPlan.predecessorOf`, which also spans already-adopted notes.
    /** Edges the commit writes, in chain order: new note -> the predecessor it depends on */
    const chainWritePlan: { path: string; dependsOnPath: string | null }[] = [];
    /** In-scope already-adopted notes the chain bridges over; listed, never written */
    const chainBridgedPaths: string[] = [];
    if (options.autoChain && toAdopt.length > 0) {
      // Existing topics are loaded once: they supply the canonical ids for the
      // in-scope already-adopted notes the chain bridges over, and are merged
      // into the graph below for cycle checking.
      const existingTopics = loadTopics(vaultPath);

      // Mint IDs up front: the planned graph is keyed by palee_id. Only notes
      // being adopted get a fresh id — an adopted note keeps the id it already
      // has on disk.
      const idByPath = new Map<string, string>();
      const toAdoptPaths = new Set<string>();
      const planPaths = new Set<string>();
      for (const note of toAdopt) {
        note.topicId = generateTopicId();
        idByPath.set(note.relativePath, note.topicId);
        toAdoptPaths.add(note.relativePath);
        planPaths.add(note.relativePath);
      }

      // Planner input is the whole curriculum being laid, not just the rows
      // being inserted: notes already adopted inside the scanned scope join the
      // plan so the first new note after them chains onto them.
      for (const relPath of alreadyAdopted) {
        planPaths.add(relPath.replace(/\\/g, '/'));
      }
      for (const topic of existingTopics) {
        const rel = topic.path.replace(/\\/g, '/');
        if (planPaths.has(rel) && !toAdoptPaths.has(rel)) {
          idByPath.set(rel, topic.id);
        }
      }

      // The planner re-derives B7 from the ids the scan already parsed rather
      // than trusting the scan's pre-filter: the two then cannot disagree about
      // what is allowed to gate, and any other caller of this API inherits the
      // same rule.
      const hygienePlan = planAutoChainWithHygiene(
        [...planPaths],
        (relPath) => adoptedPaleeId.get(relPath)
      );
      // TOC tier (PAL-205-C): the repo's own README/SUMMARY enumeration orders
      // what the numbered tree does not cover; under C2 numbering dominance,
      // numbered-tree paths keep their numbering edges no matter what a
      // README lists.
      // Enumerate the repo's own TOC once; `strict` simply refuses to consume
      // it, but the honest-refusal message must know whether a TOC signal
      // exists before claiming that none does.
      const tocEnumeration = deriveTocEnumeration(vaultPath, planPaths);
      const tocSignalInScope = tocEnumeration.documentOrder.length > 1;
      const tiered = composeTieredChain({
        tier: autoChainTier ?? 'full',
        numbered: hygienePlan,
        tocPaths: autoChainTier === 'strict' ? [] : tocEnumeration.documentOrder,
      });
      chainPlan = tiered;
      chainSourceOf.clear();
      for (const [p, s] of tiered.sourceOf) chainSourceOf.set(p, s);
      // C4 honest refusal means *no order signal exists at all* — under
      // `strict` a usable TOC enumeration still exists in the vault; strict
      // just declines it, which is a configuration outcome, not the
      // no-signal case the roadmap pointer is for.
      chainRefused = !tiered.hasNumberedLayout && !tocSignalInScope && !tiered.hasTocLayout;
      if (chainPlan.hasUnnumbered) {
        // B6 — the warning now carries numbers and concrete paths: it is the
        // stop sign telling the learner this vault needs `--exclude`.
        const examples = chainPlan.leafPaths.slice(0, 3);
        console.log(
          `⚠ Warning: ${chainPlan.leafPaths.length} of ${chainPlan.orderedPaths.length} ` +
            `planned notes are not numbered lessons and chain in alphabetical order.`
        );
        for (const example of examples) {
          console.log(`    e.g. ${example}`);
        }
      }

      const plannedGraph = new Map<string, TopicNode>();
      for (const relPath of chainPlan.orderedPaths) {
        const id = idByPath.get(relPath);
        if (!id) {
          continue;
        }
        if (!toAdoptPaths.has(relPath)) {
          // An already-adopted note is never rewritten, so it gets no
          // chainDependsOn entry and its planned node keeps the depends_on it
          // has on disk (merged in below) rather than the chain-derived one.
          // It is still part of the chain, so the preview lists it separately.
          chainBridgedPaths.push(relPath);
          continue;
        }
        const predecessorPath = chainPlan.predecessorOf.get(relPath) ?? null;
        const predecessorId = predecessorPath ? idByPath.get(predecessorPath) : undefined;
        const dependsOn: string[] = [];
        if (predecessorId) {
          dependsOn.push(predecessorId);
        } else if (predecessorPath) {
          console.log(
            `⚠ Warning: chain predecessor ${predecessorPath} has no resolvable topic id; ` +
              `${relPath} keeps an empty depends_on.`
          );
        }
        chainDependsOn.set(relPath, dependsOn);
        chainWritePlan.push({ path: relPath, dependsOnPath: predecessorId ? predecessorPath : null });
        plannedGraph.set(id, { palee_id: id, depends_on: dependsOn, topic_mastery: 0 });
      }

      // Merge existing vault topics so a pre-existing cycle blocks the
      // commit instead of being silently extended.
      for (const topic of existingTopics) {
        if (!plannedGraph.has(topic.id)) {
          plannedGraph.set(topic.id, {
            palee_id: topic.id,
            depends_on: topic.depends_on,
            topic_mastery: 0,
          });
        }
      }

      const { cycles, truncated } = detectCyclesBounded(plannedGraph);
      if (cycles.length > 0 || truncated) {
        // Cycles are reported by vault-relative path, not just opaque
        // `T-...` ids: the check merges the whole vault, so a cycle the learner
        // authored months ago in a 300-note vault would otherwise be greppable
        // only by id. The id stays in the line for cross-referencing
        // `palee validate` output, and is all that is available for a topic
        // outside the scanned scope.
        const pathById = new Map<string, string>();
        for (const [relPath, id] of idByPath) {
          pathById.set(id, relPath);
        }
        const label = (id: string): string => {
          const rel = pathById.get(id);
          return rel ? `${rel} (${id})` : id;
        };
        console.error('Error: auto-chain dependency graph contains cycles; no notes were adopted.');
        for (const cycle of cycles) {
          console.error(`  • ${cycle.map(label).join(' → ')}`);
        }
        // Every edge `--auto-chain` adds here points strictly backward in the
        // plan's total order, onto an id that either belongs to an already
        // adopted note or was minted moments ago from `crypto.randomBytes` — so
        // no pre-existing `depends_on` can name it. A chain edge therefore
        // cannot close a cycle, and any loop reported below predates this run.
        // (Contrast `roadmap --auto-chain`, where a synthesized edge CAN close a
        // cycle against authored deps; that path labels its own edges.)
        if (cycles.length > 0) {
          console.error('  These edges are pre-existing vault dependencies, not chain-synthesized ones.');
        }
        if (truncated) {
          console.error('  • … cycle enumeration truncated at 1000; more cycles may exist');
        }
        console.error('  Fix the cycle, then re-run: `palee validate` reports the offending edges.');
        process.exitCode = ExitCode.Validation;
        return;
      }

      // Adopt in chain order so verbose/dry-run output reads head-to-tail.
      const orderIndex = new Map(chainPlan.orderedPaths.map((p, i) => [p, i]));
      toAdopt.sort(
        (a, b) => (orderIndex.get(a.relativePath) ?? 0) - (orderIndex.get(b.relativePath) ?? 0)
      );
    }

    // Display summary preview
    const scanLabel = targetPath ? targetPath.replace(/\\/g, '/') : '(Entire Vault)';
    console.log('=== PALEE Batch Adoption ===');
    console.log(`Scope:            ${scanLabel}`);
    console.log(`Total Scanned:    ${allFiles.length} files`);
    console.log(`Ready to Adopt:   ${toAdopt.length} notes`);
    console.log(`Already Adopted:  ${alreadyAdopted.length} notes`);
    if (options.include || options.exclude) {
      console.log(`Excluded (Pattern): ${skippedByPattern.length} notes`);
    }
    if (options.tag) {
      console.log(`Excluded (Tag):     ${skippedByTag.length} notes`);
    }
    console.log(`Difficulty:       ${difficulty}`);
    if (options.autoChain) {
      if (chainRefused) {
        // C4 honest refusal: no order signal anywhere in scope — exit 0 with
        // zero edges instead of inventing alphabetical prerequisites.
        console.log(
          'Auto-chain:       0 edges (no numbered layout, no README TOC links) — consider palee roadmap'
        );
      } else {
        const tocSuffix =
          chainPlan && chainPlan.tocEdgeCount > 0 ? `, ${chainPlan.tocEdgeCount} from TOC` : '';
        console.log(
          `Auto-chain:       enabled (${autoChainTier ?? 'full'} tier — ${toAdopt.length} notes chained by prefix order${tocSuffix})`
        );
      }
      // B6 — per-tier hygiene report, printed identically on the dry-run and
      // the confirmation screen so what is reviewed is what is written. It is
      // printed even when nothing survived filtering: silently discarding the
      // learner's notes is the failure mode this whole work order exists to
      // remove, so an empty plan must still account for every skipped file.
      if (
        chainPlan ||
        skippedByHygiene.size > 0 ||
        skippedInvalidId.length > 0
      ) {
        const excludedFromPlan = chainPlan ? chainPlan.excluded : new Map<string, Tier0SkipReason>();
        const countFor = (reason: Tier0SkipReason): number => {
          const scanList = skippedByHygiene.get(reason);
          let count = scanList ? scanList.length : 0;
          for (const r of excludedFromPlan.values()) {
            if (r === reason) count += 1;
          }
          return count;
        };
        const excludedTotal =
          countFor('repo-meta') + countFor('translation') + countFor('template');
        console.log('Tier-0 hygiene:');
        if (chainPlan) {
          console.log(`  Backbone:       ${chainPlan.counts.backbone} notes (may gate the chain)`);
          console.log(`  Leaves:         ${chainPlan.counts.leaf} notes (attached, never gate)`);
        } else {
          console.log('  Backbone:       0 notes (may gate the chain)');
          console.log('  Leaves:         0 notes (attached, never gate)');
        }
        console.log(`  Skipped (meta): ${countFor('repo-meta')} notes`);
        console.log(`  Skipped (translations): ${countFor('translation')} notes`);
        console.log(`  Skipped (template): ${countFor('template')} notes`);
        console.log(
          `  Phase subtrees: ${chainPlan ? chainPlan.counts.byReason['phase-subtree'] : 0} notes collapsed to leaves`
        );
        if (skippedInvalidId.length > 0) {
          console.log(
            `  Invalid palee_id: ${skippedInvalidId.length} notes (not adopted, not chained)`
          );
        }
        console.log(`  Excluded total: ${excludedTotal} notes`);
        if (!chainPlan && excludedTotal + skippedInvalidId.length > 0) {
          console.log(
            '  → Nothing left to chain. Tier-0 hygiene is always on; to keep one of ' +
              'these notes anyway, adopt it directly: palee adopt "<path>"'
          );
        }
      }
    }

    if (options.verbose) {
      if (toAdopt.length > 0) {
        console.log('\nNotes to adopt:');
        toAdopt.forEach((n) => console.log(`  + ${n.relativePath}`));
      }
      if (alreadyAdopted.length > 0) {
        console.log('\nAlready adopted:');
        alreadyAdopted.forEach((f) => console.log(`  = ${f}`));
      }
      if (skippedByPattern.length > 0) {
        console.log('\nSkipped by pattern filter:');
        skippedByPattern.forEach((f) => console.log(`  - ${f}`));
      }
      if (skippedByTag.length > 0) {
        console.log('\nSkipped by tag filter:');
        skippedByTag.forEach((f) => console.log(`  ~ ${f}`));
      }
      if (options.autoChain) {
        for (const [reason, list] of skippedByHygiene) {
          console.log(`\nSkipped by Tier-0 hygiene (${reason}):`);
          list.forEach((f) => console.log(`  ! ${f}`));
        }
        if (chainPlan && chainPlan.excluded.size > 0) {
          console.log('\nExcluded from the chain by Tier-0 hygiene:');
          for (const [relPath, reason] of chainPlan.excluded) {
            console.log(`  ! ${relPath} (${reason})`);
          }
        }
        if (skippedInvalidId.length > 0) {
          console.log('\nSkipped: palee_id is not a usable string (B7):');
          skippedInvalidId.forEach((f) => console.log(`  ! ${f}`));
        }
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

    if (toAdopt.length === 0) {
      console.log('\nNo new notes matched the criteria to adopt.');
      return;
    }

    // Confirmation gate
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Error: Non-interactive environment. Use -y or --yes to confirm batch adoption.');
        process.exitCode = 2;
        return;
      }

      console.log(`\nThis will initialize PALEE tracking for ${toAdopt.length} notes.`);
      const confirmed = await promptConfirmation('Proceed with adoption? (y/N): ');
      if (!confirmed) {
        console.log('Aborted.');
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 1: Preflight & Preparation
    // ─────────────────────────────────────────────────────────────────
    interface PreparedBatchItem {
      absolutePath: string;
      relativePath: string;
      originalContent: string;
      fingerprint: string;
      updatedContent: string;
    }

    const preparedBatch: PreparedBatchItem[] = [];
    for (const note of toAdopt) {
      // Re-read fresh content to minimize TOCTOU window
      const freshContent = fs.readFileSync(note.absolutePath, 'utf8');
      const freshFingerprint = computeFingerprint(freshContent);
      const { frontmatter } = parseFrontmatter(freshContent);

      const topicId = note.topicId ?? generateTopicId();
      const title = resolveNoteTitle(freshContent, note.absolutePath, frontmatter);

      const topicMastery = resolveTopicMastery({
        conceptual: frontmatter?.conceptual,
        practical: frontmatter?.practical,
        debug: frontmatter?.debug,
        feynman: frontmatter?.feynman,
        existing: frontmatter?.topic_mastery,
        precedence: 'existing-first',
      });

      const conceptual = normalizeScore(frontmatter?.conceptual);
      const practical = normalizeScore(frontmatter?.practical);
      const debug = normalizeScore(frontmatter?.debug);
      const feynman = normalizeScore(frontmatter?.feynman);

      const plannedDeps = options.autoChain ? (chainDependsOn.get(note.relativePath) ?? []) : [];
      const paleeData: Record<string, unknown> = {
        palee_id: topicId,
        palee_schema: 1,
        title,
        difficulty,
        depends_on: plannedDeps,
        topic_mastery: topicMastery,
        assessed_at: normalizeAssessedAt(frontmatter?.assessed_at),
        conceptual,
        practical,
        debug,
        feynman,
        ease_factor: 2.5,
        interval_days: 1,
        repetition: 0,
        lapses: 0,
        last_quality: null,
        last_reviewed_at: null,
        due_at: null,
      };

      // C5 (PAL-205-C): additive provenance label. Only notes whose chain
      // edge was actually written carry it; old PALEE builds parse the file
      // unchanged (unknown frontmatter keys are preserved, never rejected),
      // and gating behavior is untouched by this field.
      if (plannedDeps.length > 0) {
        const edgeSource = chainSourceOf.get(note.relativePath);
        if (edgeSource) {
          paleeData.depends_on_source = edgeSource;
        }
      }

      const updatedContent = updateFrontmatter(freshContent, paleeData);
      preparedBatch.push({
        absolutePath: note.absolutePath,
        relativePath: note.relativePath,
        originalContent: freshContent,
        fingerprint: freshFingerprint,
        updatedContent,
      });
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
        });
      }

      console.log(`\n✓ Successfully adopted ${journal.length} notes into PALEE.`);
      if (options.autoChain) {
        let edges = 0;
        for (const deps of chainDependsOn.values()) {
          edges += deps.length;
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
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default adoptCommand;
