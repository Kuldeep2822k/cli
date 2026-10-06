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
import {
  extractDeclaredPrerequisites,
  resolveDeclaredPrerequisites,
} from '../engine/prereq-text';
import { AdoptOptions, Difficulty, normalizeDifficulty, normalizeAssessedAt, type TopicNode } from '../types';

import { resolveNoteTitle } from '../storage/note-title';
import { normalizeDependencies } from '../storage/dependencies';

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

    // C4 (PAL-205-C): the tier is a separate option, not an optional value on
    // `--auto-chain`. An optional-value flag swallows the following positional,
    // so `adopt --auto-chain MODULES` would have read `MODULES` as a tier and
    // exited 2 having adopted nothing — a regression of a form this command has
    // always accepted. A bare `--auto-chain` chains the numbered tree only;
    // enumeration order needs `--chain-tier toc|full`. Anything outside the
    // three tiers is a usage error, never a silent default back to chaining.
    let autoChainTier: AutoChainTier | null = null;
    if (options.autoChain) {
      autoChainTier = options.chainTier === undefined ? 'strict' : parseAutoChainTier(options.chainTier);
      if (autoChainTier === null) {
        console.error('Error: --chain-tier expects one of: strict, toc, full');
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

      const flagDeps = options.dependsOn
        ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

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
        console.log(`  Difficulty: ${difficulty}`);
        if (dependsOn.length > 0) {
          console.log(`  Dependencies: ${dependsOn.join(', ')}`);
        }
        console.log('\nDry-run complete. No files were modified.');
        return;
      }

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
    /**
     * The already-adopted notes that passed `--include`/`--exclude`/`--tag`, and
     * therefore the only ones the chain planner may see. Reported separately
     * from {@link alreadyAdopted} because that list is the scan's accounting of
     * the scope, while this one is a set of write-plan participants: a note the
     * user excluded must not become a `depends_on` entry written to a new note.
     */
    const plannableAdopted: string[] = [];
    const skippedByPattern: string[] = [];
    const skippedByTag: string[] = [];
    /** B6 — notes Tier-0 hygiene kept out of an --auto-chain batch, by reason */
    const skippedByHygiene = new Map<Tier0SkipReason, string[]>();
    /** B7 — notes whose `palee_id` is truthy but unusable, so they are neither chained nor adopted */
    const skippedInvalidId: string[] = [];
    /** Raw parsed `palee_id` per already-adopted path, handed to the planner so it re-derives B7 itself */
    const adoptedPaleeId = new Map<string, unknown>();
    /**
     * #258 — the non-empty `depends_on` each candidate note already carries in its
     * own frontmatter, i.e. the prerequisites the learner stated directly rather
     * than in the `## Prerequisites` prose the planner otherwise reads. Collected
     * during the scan because that is where the note is parsed once, and only for
     * an `--auto-chain` batch, which is the pass that synthesizes an edge over it.
     */
    const handAuthoredDeps = new Map<string, string[]>();

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
        // The scan's filters govern the plan, not just the writes. An adopted
        // note that the user excluded still reaches the planner through
        // `planPaths` below, so the next new lesson is given a `depends_on` edge
        // pointing at the very note `--exclude` was written to drop — and that
        // edge is persisted. Same for `--include` and `--tag`.
        const passesFilters =
          (!options.include || matchesPattern(relPath, options.include)) &&
          !(options.exclude && matchesPattern(relPath, options.exclude)) &&
          !(options.tag && !matchesTags(frontmatter.tags, options.tag));
        if (passesFilters) {
          plannableAdopted.push(relPath);
        }
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
        // Read where the frontmatter is already parsed, and only after every
        // filter above has been applied: a note this batch will not write must
        // not contribute an edge to the report either, so the list of surviving
        // candidates is the whole input.
        const ownDeps = normalizeDependencies(frontmatter?.depends_on);
        if (ownDeps.length > 0) {
          handAuthoredDeps.set(relPath, ownDeps);
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
    /** C4 honest refusal: the scope carries no numbering and no chainable enumeration */
    let chainRefused = false;
    /** Set when the selected tier declines to read an enumeration that does exist */
    let tocLinksDeclined = false;
    /** Notes whose own text declares their prerequisites, replacing the inferred edge */
    const declaredDeps = new Map<string, { id: string; path: string }[]>();
    /** Declared names that matched no single note — counted, never fatal */
    let declaredSkippedCount = 0;
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
      for (const relPath of plannableAdopted) {
        planPaths.add(relPath.replace(/\\/g, '/'));
      }
      for (const topic of existingTopics) {
        const rel = topic.path.replace(/\\/g, '/');
        if (planPaths.has(rel) && !toAdoptPaths.has(rel)) {
          idByPath.set(rel, topic.id);
        }
      }

      /**
       * palee_id -> vault-relative path over the *whole* vault, not just this
       * plan: the reverse of `idByPath` cannot resolve the ids a note names by
       * hand, since those may point outside the scanned scope. Used to print a
       * preserved hand-written edge as a path, the way a chain edge is printed.
       */
      const pathOfId = new Map<string, string>();
      for (const topic of existingTopics) {
        pathOfId.set(topic.id, topic.path.replace(/\\/g, '/'));
      }
      for (const [rel, id] of idByPath) {
        pathOfId.set(id, rel);
      }

      // WS6 — a note's own links outrank any inference about it. The name index
      // holds only the notes this batch may point at: the ones being adopted,
      // whose ids were just minted, and the already-adopted notes inside the
      // scanned scope. Deliberately *not* every topic in the vault — a note the
      // learner excluded with `--exclude`, `--include` or `--tag` must not become
      // a new `depends_on` entry because another note linked to it, which is the
      // same guarantee the chain itself already honours.
      type PrereqTarget = { id: string; path: string };
      const prereqByPath = new Map<string, PrereqTarget[]>();
      const prereqByBase = new Map<string, PrereqTarget[]>();
      const addIndexed = (index: Map<string, PrereqTarget[]>, key: string, target: PrereqTarget): void => {
        if (key.length === 0) return;
        const list = index.get(key);
        if (list) {
          if (!list.some((t) => t.id === target.id)) list.push(target);
        } else {
          index.set(key, [target]);
        }
      };
      const addPrereqTarget = (rawPath: string, id: string): void => {
        const relPath = rawPath.replace(/\\/g, '/').toLowerCase().replace(/\.md$/, '');
        if (relPath.length === 0) return;
        const target: PrereqTarget = { id, path: rawPath.replace(/\\/g, '/') };
        addIndexed(prereqByPath, relPath, target);
        addIndexed(prereqByBase, relPath.slice(relPath.lastIndexOf('/') + 1), target);
      };
      for (const [relPath, id] of idByPath) addPrereqTarget(relPath, id);

      /**
       * Folds a markdown link destination against the directory of the note
       * holding it, the way a renderer would. `[home](x1/README.md)` inside
       * `m/03-c.md` names `m/x1/README.md`; keeping only its basename would
       * throw away the directory that made the target unique and turn a precise
       * link into an ambiguous name.
       */
      const foldLinkDestination = (destination: string, noteDir: string): string | null => {
        let raw = destination.trim().replace(/\\/g, '/').toLowerCase();
        if (raw.length === 0) return null;
        if (raw.endsWith('/')) raw += 'readme';
        const withoutSuffix = raw.replace(/\.md$/, '');
        const joined = withoutSuffix.startsWith('/')
          ? withoutSuffix.slice(1)
          : path.posix.join(noteDir, withoutSuffix);
        const folded = path.posix.normalize(joined);
        if (folded === '' || folded === '.' || folded.startsWith('..')) return null;
        return folded;
      };

      for (const note of toAdopt) {
        const refs = extractDeclaredPrerequisites(note.content);
        if (refs.length === 0) continue;
        const selfPath = note.relativePath.replace(/\\/g, '/');
        const noteDir = selfPath.includes('/') ? selfPath.slice(0, selfPath.lastIndexOf('/')) : '';
        const { resolved, skipped } = resolveDeclaredPrerequisites(refs, (ref) => {
          const key = ref.name.trim().replace(/\\/g, '/').toLowerCase().replace(/\.md$/, '');
          if (key.length === 0) return [];
          let candidates: PrereqTarget[] | undefined;
          if (ref.form === 'mdlink') {
            const folded = foldLinkDestination(ref.name, noteDir);
            candidates = folded === null ? undefined : prereqByPath.get(folded);
          } else {
            // A qualified wikilink is a vault path and gets no basename fallback;
            // a bare one is a note name and gets no path match. Guessing between
            // the two is how an unrelated `README` inherits someone's prerequisite.
            candidates = key.includes('/') ? prereqByPath.get(key) : prereqByBase.get(key);
          }
          return (candidates ?? []).filter((t) => t.path !== selfPath);
        });
        declaredSkippedCount += skipped.length;
        if (resolved.length === 0) continue;
        declaredDeps.set(selfPath, resolved.map((r) => r.target));
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
      const tiered = composeTieredChain({
        tier: autoChainTier ?? 'strict',
        numbered: hygienePlan,
        // Passed whole under every tier: the strict tier consumes none of it but
        // still has to report whether the toc tier could have, which is what the
        // refusal advice is keyed to.
        tocPaths: tocEnumeration.documentOrder,
      });
      chainPlan = tiered;
      chainSourceOf.clear();
      for (const [p, s] of tiered.sourceOf) chainSourceOf.set(p, s);
      // C4 honest refusal + the C-defect-1 message fix: the claim is about what
      // this tier could chain, not about whether a README exists. Enumerating a
      // note the plan then refuses to chain is a refusal too — printing
      // `enabled … 0 edge(s) written` for it told the learner chaining had
      // worked. A singleton enumeration keeps its justified numbered edge
      // (compose no longer nulls heads over justified preds), so the written
      // counts still cannot fire this branch on a README that does have links.
      chainRefused =
        !tiered.hasNumberedLayout &&
        tiered.tocEdgeCount === 0 &&
        tiered.numberedEdgeCount === 0 &&
        declaredDeps.size === 0 &&
        // #258 — a hand-written `depends_on` is as much an order signal as a
        // `## Prerequisites` line, and the plan does write its edge, so claiming
        // "no chainable order signal" over it would print `0 edges` on a run
        // that gates a note on an edge the learner authored. Same reason
        // `declaredDeps` is already in this conjunction (#225).
        handAuthoredDeps.size === 0;
      // Distinct from "nothing to chain": under `strict` the enumeration may hold
      // links the selected tier simply does not read, and naming the tier is the
      // useful advice. Keyed on the enumeration's *presence* it lies in the other
      // case — a README linking only to notes no tier will order (a `solution/`
      // subtree, a translation copy) would send the learner to
      // `--chain-tier toc`, which refuses there for the same reason, costing them
      // the roadmap pointer that does apply. `tocCandidateCount` is what a toc/full
      // tier could have ordered, so the advice is only offered when it leads
      // somewhere — and "somewhere" needs more than one note, since a lone
      // candidate is the chain head and `toc` would write no edge either.
      tocLinksDeclined = autoChainTier === 'strict' && tiered.tocCandidateCount > 1;
      // B6 — the warning carries numbers and concrete paths: it is the stop
      // sign telling the learner this vault needs `--exclude`. The count and the
      // examples both come from the set the warning describes, which the coarse
      // `hasUnnumbered` flag is not: `leafPaths` holds numbered notes under
      // phase subtrees and omits unnumbered backbone notes such as `README.md`,
      // so counting it printed "0 of 2 planned notes are not numbered lessons"
      // for a run that had just fallen back to alphabetical order — and the flag
      // itself fires on any plan containing a module README.
      const alphabetical = chainPlan.alphabeticalNotes;
      const ties = chainPlan.alphabeticalTieNotes;
      const affected: string[] = [];
      if (alphabetical.length > 0) {
        affected.push(
          `${alphabetical.length} of ${chainPlan.orderedPaths.length} planned notes have no number or phase in their name and chain in alphabetical order`
        );
      }
      if (ties.length > 0) {
        affected.push(
          `${ties.length} of ${chainPlan.orderedPaths.length} planned notes are placed after the note before them by their filename alone, so nothing in the numbering ordered them`
        );
      }
      if (chainPlan.directoryOrderAlphabetical) {
        affected.push(
          'some directories carry no numeric prefix, so the order between them is alphabetical'
        );
      }
      if (affected.length > 0) {
        console.log(`⚠ Warning: ${affected.join('; ')}.`);
        for (const example of [...alphabetical, ...ties].slice(0, 3)) {
          console.log(`    e.g. ${example}`);
        }
      }

      // The enumeration also declines whole documents, and that has to be said
      // too: a learner whose README was skipped would otherwise be told the
      // vault carries no order signal when the tier in fact refused to read one.
      // Reported only where a tier reads TOC documents — `strict` never does, so
      // a bound it never exercised is not its news.
      const oversizedToc =
        autoChainTier === 'toc' || autoChainTier === 'full'
          ? tocEnumeration.skipped.filter((s) => s.reason === 'oversized')
          : [];
      if (oversizedToc.length > 0) {
        console.log(
          `⚠ Warning: ${oversizedToc.length} README/SUMMARY document(s) were too large to enumerate, ` +
            'so no chain edge was read from them.'
        );
        for (const example of oversizedToc.slice(0, 3)) {
          console.log(`    e.g. ${example.tocFile}`);
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
        const declared = declaredDeps.get(relPath);
        const handAuthored = handAuthoredDeps.get(relPath);
        const predecessorPath = chainPlan.predecessorOf.get(relPath) ?? null;
        const predecessorId = predecessorPath ? idByPath.get(predecessorPath) : undefined;
        const dependsOn: string[] = [];
        if (declared) {
          // The declared list replaces the inferred edge rather than joining it.
          // One `depends_on_source` label covers a note's whole list, so keeping
          // an inferred `toc` edge beside a declared one would quietly promote an
          // enumeration guess into a gate — the exact defect PAL-205 exists to
          // contain. A note that states its prerequisites has no need of a guess.
          dependsOn.push(...declared.map((t) => t.id));
          chainSourceOf.set(relPath, 'declared');
          for (const target of declared) {
            chainWritePlan.push({ path: relPath, dependsOnPath: target.path });
          }
        } else if (handAuthored) {
          // #258 — the note already names its own gates in its frontmatter, so
          // there is nothing for the planner to infer: writing the alphabetical
          // predecessor here *replaced* that list and stamped it `numbered`, and
          // a `numbered` edge gates, so the learner was held off the ready list by
          // a filename collation they never chose. Same replace-don't-merge rule
          // and same `declared` label as the prose branch above, because that is
          // what this is — the note's own claim. Its edges are then counted under
          // `Declared:`, not among the ones this tier authored.
          dependsOn.push(...handAuthored);
          chainSourceOf.set(relPath, 'declared');
          for (const depId of handAuthored) {
            // `dependsOnPath: null` would preview this note as a chain head whose
            // `depends_on` stays empty, which is false, and would drop the edge
            // from the `Declared:` count. An id resolving to no note prints as
            // itself: the edge really is dangling, and `palee validate` is where
            // that gets reported.
            chainWritePlan.push({ path: relPath, dependsOnPath: pathOfId.get(depId) ?? depId });
          }
        } else if (predecessorId) {
          dependsOn.push(predecessorId);
          chainWritePlan.push({ path: relPath, dependsOnPath: predecessorPath });
        } else {
          if (predecessorPath) {
            console.log(
              `⚠ Warning: chain predecessor ${predecessorPath} has no resolvable topic id; ` +
                `${relPath} keeps an empty depends_on.`
            );
          }
          chainWritePlan.push({ path: relPath, dependsOnPath: null });
        }
        chainDependsOn.set(relPath, dependsOn);
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
        const declaredIds = new Set(
          [...declaredDeps.keys()].map((p) => idByPath.get(p)).filter(Boolean)
        );
        const involvesDeclared = cycles.some((c) => c.some((id) => declaredIds.has(id)));
        if (cycles.length > 0 && involvesDeclared) {
          console.error("  A cycle includes edges declared in the notes' own prerequisite text.");
        } else if (cycles.length > 0) {
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
        // C4 honest refusal: nothing in scope was chainable under this tier —
        // exit 0 with zero edges instead of inventing alphabetical
        // prerequisites. Phrased about what the plan could chain rather than
        // about whether a README exists, because a listing document whose every
        // link resolves to a note this tier will not order is the same refusal.
        console.log(
          tocLinksDeclined
            ? 'Auto-chain:       0 edges (no numbered layout; --chain-tier strict does not read a README enumeration) — try --chain-tier toc'
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

      // #258 — `depends_on` a note already states is not adoption's to clear. The
      // planned edge wins when the chain authored one for this note; otherwise the
      // note's own list is what gets written back. Under a plain `adopt --all` the
      // plan is empty for every note, so this is what stops that invocation — the
      // commonest one — from flattening a hand-written gate to `[]`. A note the
      // planner visited keeps the ids the planner chose for it, which for a
      // hand-authored note are the same ids (see `handAuthoredDeps`).
      const ownDeps = normalizeDependencies(frontmatter?.depends_on);
      const chainDeps = chainDependsOn.get(note.relativePath) ?? [];
      const preservedOwnDeps = chainDeps.length === 0 && ownDeps.length > 0;
      const plannedDeps = preservedOwnDeps ? ownDeps : chainDeps;
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
        } else if (preservedOwnDeps) {
          // Same label the prose branch uses for a list the author wrote, so both
          // adopt paths describe a preserved hand-written gate the same way rather
          // than one labelling it and the other leaving it absent.
          paleeData.depends_on_source = 'declared';
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
