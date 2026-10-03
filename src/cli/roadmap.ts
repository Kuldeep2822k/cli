/**
 * Roadmap Command Handler
 * Manages learning roadmaps (Phase 1: deterministic --from only)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { validateVaultPath } from './onboarding';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  updateFrontmatter,
  computeFingerprint,
  parseFrontmatter,
  parseRoadmapContent,
  resolveWikilinkRoadmap,
  atomicWrite,
  isConflictError,
  loadTopics,
  ensureVaultDirectory,
} from '../storage';
import { isWithinVault } from '../storage/wikilink';
import { detectCyclesBounded } from '../engine/dependency';
import { RoadmapOptions, RoadmapTopic, RoadmapFile, TopicNode, ResolvedTopicUpdates } from '../types';

/**
 * Canonical absolute form of a roadmap-declared topic path for boundary checks.
 *
 * @param resolvedVault - Canonical vault root (`fs.realpathSync`ed)
 * @param declared - The `path` as written in the roadmap (vault-relative or absolute)
 * @returns Absolute canonical path, so it compares equal to `resolvedVault`
 *
 * @remarks
 * `isWithinVault` requires both endpoints canonical, but an absolute declared
 * path was only lexically resolved. On a machine whose temp dir passes through
 * a symlink (macOS `/var` → `/private/var`) the lexical form never sits under
 * the resolved vault, so every absolute declaration read as an escape. An
 * existing file resolves directly; a note this import is about to create
 * resolves through its nearest existing ancestor. That stays fail-closed: a
 * symlinked ancestor pointing out of the vault still fails the check rather
 * than slipping through.
 */
function canonicalDeclaredPath(resolvedVault: string, declared: string): string {
  const absolute = path.isAbsolute(declared)
    ? path.resolve(declared)
    : path.resolve(resolvedVault, declared);
  // A symlinked final component is never followed here: a symlinked target
  // is never a note, and the importer's `lstat` guard owns that case ("not a
  // regular file", skipping one topic). Following it would re-report it as
  // an escape and fail validation for the whole batch instead. Only the
  // parent chain is canonicalized, which is also what a symlinked temp root
  // needs. Missing leaves resolve through the nearest existing ancestor, so
  // a note this import is about to create still compares against the vault.
  let leaf = absolute;
  const suffix: string[] = [];
  while (true) {
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(leaf);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink() && suffix.length === 0) {
        try {
          return path.join(fs.realpathSync(path.dirname(leaf)), path.basename(leaf));
        } catch {
          return absolute;
        }
      }
      try {
        const canonicalBase = fs.realpathSync(leaf);
        return suffix.length > 0 ? path.join(canonicalBase, ...suffix) : canonicalBase;
      } catch {
        return absolute;
      }
    }
    const parent = path.dirname(leaf);
    if (parent === leaf) return absolute;
    suffix.unshift(path.basename(leaf));
    leaf = parent;
  }
}

/**
 * Whether a roadmap-declared topic path names a usable note file.
 *
 * @param declared - The `path` as written in the roadmap
 * @returns True when the path names a note file rather than a degenerate entry
 *
 * @remarks
 * `path.extname('.md')` is `''`, so a topic path of `.md` slipped past the
 * extension-based directory check in `ensureVaultDirectory`, created a `.md/`
 * directory, and wrote `vault/.md/.md` with exit 0. The basename check here
 * rejects that degenerate name (and its case variants) before anything is
 * written. Kept narrow on purpose: visibility rules stay owned by the walker.
 *
 * @example
 * ```typescript
 * isValidRoadmapTopicPath('.md'); // false
 * isValidRoadmapTopicPath('notes/a.md'); // true
 * ```
 */
export function isValidRoadmapTopicPath(declared: string): boolean {  const normalized = declared.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base.length === 0) return false;
  if (base.toLowerCase() === '.md') return false;
  return true;
}

/**
 * Reads the adopted topic id already stored at a roadmap target path, if any.
 *
 * @param absoluteTarget - Canonical absolute path of the note the import would write
 * @returns The stored `palee_id` when the target is an existing note carrying one, else null
 *
 * @remarks
 * Used to gate silent re-IDs: a roadmap entry that declares `T-review-bash`
 * over a note adopted as `T-...` used to overwrite the id, orphaning the old
 * id while dependents still named it. A mismatch is now a validation error
 * with zero writes. Symlinks, directories, and unreadable files yield null so
 * the write path's own `lstat` guard still owns those cases.
 */
function readTargetPaleeId(absoluteTarget: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absoluteTarget);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  let content: string;
  try {
    content = readBoundNote(absoluteTarget, stat);
  } catch {
    return null;
  }
  const { frontmatter } = parseFrontmatter(content);
  const id = frontmatter?.palee_id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/** Outcome of {@link applyRoadmapAutoChain}, used for deferred logging and cycle labels. */
interface RoadmapChainResult {
  /** Every edge this pass synthesized, keyed `childId\u0000predecessorId` */
  synthesizedEdges: Set<string>;
  /** Edges dropped because they would have closed a cycle */
  skippedEdges: { from: string; to: string }[];
}

/**
 * Chains roadmap topics by their `order` field (#73, INV-47).
 *
 * @param topics - Roadmap topics, mutated in place
 * @returns Which edges were synthesized, and which were dropped as cycle-closing
 *
 * @remarks
 * Topics with an `order` sort first (ascending); topics without one keep
 * their file order and are appended after the ordered ones. A topic with no
 * (or an empty) `depends_on` is chained to the previous topic's ID — the
 * chain head gets an explicit `[]`. An explicit non-empty `depends_on`
 * always wins over the synthesized chain, and a topic whose dependencies are
 * already final (`chained`) is left alone.
 *
 * A synthesized edge is dropped, with a warning, when the predecessor already
 * reaches the topic through explicit or earlier synthesized deps: adding it
 * would close a cycle. The chain then simply restarts at that topic, whose own
 * `depends_on` is left exactly as authored, so an authored dependency and an
 * ordering coincidence cannot abort the import.
 * This reachability view covers the roadmap's own topics; a cycle that closes
 * only once existing vault topics are merged is still caught, fail-closed, by
 * the caller's graph validation.
 */
function applyRoadmapAutoChain(topics: RoadmapTopic[]): RoadmapChainResult {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const synthesizedEdges = new Set<string>();
  const skippedEdges: { from: string; to: string }[] = [];

  const indexed = topics.map((topic, index) => ({ topic, index }));
  indexed.sort((a, b) => {
    const orderA = a.topic.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.topic.order ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.index - b.index;
  });

  /** True when `start` already reaches `target` through dependencies assigned so far. */
  const reaches = (start: string, target: string): boolean => {
    const stack = [start];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === target) {
        return true;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      for (const dep of byId.get(id)?.depends_on ?? []) {
        stack.push(dep);
      }
    }
    return false;
  };

  indexed.forEach(({ topic }, rank) => {
    if (topic.chained || (topic.depends_on && topic.depends_on.length > 0)) {
      return;
    }
    if (rank === 0) {
      topic.depends_on = [];
      return;
    }
    const predecessorId = indexed[rank - 1].topic.id;
    if (reaches(predecessorId, topic.id)) {
      // Left unassigned rather than set to `[]`: skipping an edge must not
      // also erase dependencies the note already had on disk, which an
      // explicit empty list would do (see `resolveTopicUpdates`).
      skippedEdges.push({ from: topic.id, to: predecessorId });
      console.log(
        `⚠ Warning: chain edge ${topic.id} -> ${predecessorId} skipped: would close a cycle. ` +
          `${topic.id} starts a new chain.`
      );
      return;
    }
    topic.depends_on = [predecessorId];
    synthesizedEdges.add(`${topic.id}\u0000${predecessorId}`);
  });

  return { synthesizedEdges, skippedEdges };
}

/**
 * Effective-input bundle for one roadmap topic, used by `resolveTopicUpdates`.
 *
 * @remarks
 * "Existing" identity is two-keyed on purpose (#137 follow-up): `depends_on`'s
 * preserve-existing rule looks the topic up BY `palee_id` (the roadmap topic may
 * not exist on disk yet, so its pre-import identity is its future ID), while
 * frontmatter pass-through fields come from the note AT THE TARGET PATH (the
 * file the import will actually write).
 */
interface ResolveTopicInput {
  /** Roadmap-declared topic */
  topic: RoadmapTopicAlias;
  /** Existing vault topic with the same `palee_id` (for depends_on preservation), or undefined */
  existingById: LoadedTopicAlias | undefined;
  /** Raw frontmatter of the note at the target path, or `{}` for new notes */
  existingAtPath: Record<string, unknown>;
}

type RoadmapTopicAlias = import('../types').RoadmapTopic;
type LoadedTopicAlias = { id: string; depends_on?: string[] };

/**
 * Single derivation of the effective frontmatter values a roadmap import
 * writes for one topic (#139).
 *
 * @remarks
 * SINGLE SOURCE OF TRUTH for both passes: `roadmapCommand`'s validation pass
 * (graph + field checks) AND `doImport`'s writeback both consume this helper.
 * Never re-derive an import field at a call site — any new field added to the
 * roadmap import path must be added HERE (and to `ResolvedTopicUpdates`), or
 * the validation-vs-writeback divergence pattern returns (the class of bug that
 * produced the #137 cycle-on-import defect).
 *
 * This function is PURE: it derives from the inputs it is given. The writeback
 * pass calls it with the FRESH at-path frontmatter re-read just before the
 * atomic write (OCC requires re-reading the target at write time), while the
 * validation pass calls it earlier with the pre-import snapshot. Same rules,
 * fresh data per pass — the divergence being removed is in the RULES, not in
 * when the data is read.
 *
 * `depends_on` semantics (unchanged since #137): explicit `[]` clears,
 * omitted preserves the existing topic's deps (by ID), populated replaces.
 *
 * A pillar score the note does not carry resolves to `undefined` rather than
 * `0.0`: `doImport` drops `undefined` keys so the import cannot mint assessment
 * data, which is the precondition `valid-topic-mastery` (#37) skips on (#191).
 *
 * @param input - Roadmap topic plus its existing on-disk context
 * @returns Effective values for every frontmatter field the import writes;
 * `undefined` for a field that must be left unwritten
 */
function resolveTopicUpdates(input: ResolveTopicInput): ResolvedTopicUpdates {
  const { topic, existingById, existingAtPath } = input;

  return {
    palee_id: topic.id,
    palee_schema: existingAtPath.palee_schema ?? 1,
    title: topic.title,
    difficulty: topic.difficulty || existingAtPath.difficulty || 'intermediate',
    depends_on: topic.depends_on ?? existingById?.depends_on ?? [],
    topic_mastery: existingAtPath.topic_mastery ?? 0.0,
    assessed_at: existingAtPath.assessed_at ?? null,
    conceptual: existingAtPath.conceptual,
    practical: existingAtPath.practical,
    debug: existingAtPath.debug,
    feynman: existingAtPath.feynman,
    ease_factor: existingAtPath.ease_factor ?? 2.5,
    interval_days: existingAtPath.interval_days ?? 1,
    repetition: existingAtPath.repetition ?? 0,
    lapses: existingAtPath.lapses ?? 0,
    last_quality: existingAtPath.last_quality ?? null,
    last_reviewed_at: existingAtPath.last_reviewed_at ?? null,
    due_at: existingAtPath.due_at ?? null,
  };
}

/**
 * Reads a vault note through a descriptor bound to the file `lstat` validated.
 *
 * @param targetPath - The note path the caller checked
 * @param expected - The `lstat` result that established it as a regular file inside the vault
 * @returns The note's text
 * @throws Error when the path cannot be opened, or no longer holds the file that was validated
 *
 * @remarks
 * Every vault check above a read is check-then-use, so a symlink planted after
 * them is still followed and its outside content imported as the note's own
 * text. Opening first and comparing the descriptor's identity against the
 * earlier `lstat` closes that for the read: the bytes come from the object that
 * was validated, and a swap underneath shows up as a different inode before
 * anything is read.
 *
 * Identity comparison is the form that works everywhere this CLI ships. A
 * no-follow open does not: `fs.constants.O_NOFOLLOW` is undefined on win32, so
 * the open follows the link anyway. Nor does resolving a descriptor —
 * `fs.realpathSync` reads a number as a path relative to the working directory
 * on win32 rather than reporting the open file.
 *
 * A planted *hard* link stays invisible to this and to every path-based check:
 * it is not a reference to another file but a second name for the same one.
 */
export function readBoundNote(targetPath: string, expected: fs.Stats): string {
  const fd = fs.openSync(targetPath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== expected.ino || opened.dev !== expected.dev) {
      throw new Error(`${targetPath} changed between validation and read`);
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * CLI command handler for validating and importing learning roadmaps into the vault.
 *
 * @param options - Roadmap options including `--from` file path and `--yes` confirmation.
 * @returns Promise resolving when roadmap validation and import complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments or missing vault,
 * process.exitCode = 3 on dependency cycles or validation errors in the roadmap,
 * process.exitCode = 1 on partial import failure, and process.exitCode = 5 on unexpected runtime exceptions.
 * @example
 * ```typescript
 * await roadmapCommand({ from: 'roadmap.yaml', yes: true });
 * ```
 */
async function roadmapCommand(options: RoadmapOptions): Promise<void> {
  try {
    if (!options.from) {
      console.error('Error: Phase 1 only supports --from <file>');
      console.error('Usage: palee roadmap --from <roadmap.yaml|roadmap.md>');
      process.exitCode = ExitCode.Usage;
      return;
    }

    const config = loadConfig();
    const validatedVault = validateVaultPath(config.vaultPath);
    if (!validatedVault) return;
    const vaultPath = validatedVault;
    const roadmapPath = path.resolve(options.from);

    if (!fs.existsSync(roadmapPath)) {
      console.error(`Error: Roadmap file not found: ${roadmapPath}`);
      process.exitCode = ExitCode.Usage;
      return;
    }

    const rawContent = fs.readFileSync(roadmapPath, 'utf8');
    const parseResult = parseRoadmapContent(rawContent, roadmapPath);

    let roadmap: RoadmapFile;
    if (parseResult.format === 'wikilink') {
      // Wikilink format (#73, INV-48): resolve [[...]] chains against the vault.
      // Ambiguous/unresolved targets fail closed here (exit 3) with zero writes.
      try {
        roadmap = resolveWikilinkRoadmap(vaultPath, parseResult.sections ?? []);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = ExitCode.Validation;
        return;
      }
      console.log(`Resolved ${roadmap.topics.length} wikilink topics from ${roadmapPath}`);
    } else {
      if (!parseResult.roadmap || !parseResult.roadmap.topics || !Array.isArray(parseResult.roadmap.topics)) {
        console.error(`Error: ${parseResult.error || 'Roadmap must have a "topics" array'}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      roadmap = parseResult.roadmap;
    }

    // --auto-chain is scoped to YAML / frontmatter / code-block roadmaps
    // (INV-47). The wikilink format arrives already chained per `## Track`
    // section, so re-chaining it would fuse independent tracks.
    // The success-tone count is logged only after graph validation passes
    // (#73 review item 3): a chain the validator then rejected must not have
    // announced itself as fact.
    let chainResult: RoadmapChainResult | null = null;
    if (options.autoChain && parseResult.format !== 'wikilink') {
      chainResult = applyRoadmapAutoChain(roadmap.topics);
    }

    const errors: string[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const topicsMap = new Map<string, TopicNode>();

    const resolvedVault = fs.existsSync(vaultPath) ? fs.realpathSync(path.resolve(vaultPath)) : path.resolve(vaultPath);

    // Load existing vault topics before the validation loop so we can resolve
    // effective dependencies using the same rule for both validation and writeback.
    const existingTopics = loadTopics(vaultPath);
    const existingTopicsById = new Map(existingTopics.map((topic) => [topic.id, topic]));

    // Effective deps per roadmap topic, computed once and shared by validation + doImport.
    // User-intent rules: explicit empty array clears, omitted preserves existing, populated replaces.
    const effectiveDepsMap = new Map<string, string[]>();

    for (const topic of roadmap.topics) {
      const { id, title, path: relativePath, difficulty, order } = topic;

      if (!id) errors.push('Topic missing "id" field');
      if (!title) errors.push('Topic missing "title" field');
      if (!relativePath) {
        errors.push('Topic missing "path" field');
      }

      if (seenIds.has(id)) {
        errors.push(`Duplicate topic ID: ${id}`);
      }
      seenIds.add(id);

      if (seenPaths.has(relativePath)) {
        errors.push(`Duplicate path: ${relativePath}`);
      }
      seenPaths.add(relativePath);

      if (difficulty && !['beginner', 'intermediate', 'advanced'].includes(difficulty)) {
        errors.push(`Invalid difficulty for ${id}: ${difficulty}`);
      }

      if (order !== undefined && typeof order !== 'number') {
        errors.push(`Invalid order for ${id}: must be a number`);
      }

      // Path boundary validation: ensure topic path does not escape vault
      if (relativePath) {
        if (!isValidRoadmapTopicPath(relativePath)) {
          errors.push(`Topic "${id || '(unnamed)'}" has an invalid path "${relativePath}": path must name a note file`);
        } else {
          const absoluteTopicPath = canonicalDeclaredPath(resolvedVault, relativePath);
          if (!isWithinVault(resolvedVault, absoluteTopicPath)) {
            errors.push(`Topic "${id || '(unnamed)'}" path escapes vault boundary: ${relativePath}`);
          } else if (id) {
            // Gate silent re-IDs: declaring a fresh id over a note adopted
            // under another id orphans the old id while dependents still
            // name it, turning into missing-topic errors after the write.
            const storedId = readTargetPaleeId(absoluteTopicPath);
            if (storedId !== null && storedId !== id) {
              errors.push(
                `Topic "${id}" would overwrite adopted note at ${relativePath} carrying ${storedId}: refusing to re-ID without an explicit migration`
              );
            }
          }
        }
      }

      // Single-source-of-truth derivation (#139): both the graph/validation pass
      // and the doImport writeback resolve effective fields through
      // resolveTopicUpdates — never re-derive here.
      const resolved = resolveTopicUpdates({
        topic,
        existingById: existingTopicsById.get(id),
        existingAtPath: {}, // validation checks roadmap-declared fields; at-path frontmatter is a writeback concern
      });
      effectiveDepsMap.set(id, resolved.depends_on);
      topicsMap.set(id, { palee_id: id, depends_on: resolved.depends_on, topic_mastery: 0 });
    }

    for (const t of existingTopics) {
      if (!topicsMap.has(t.id)) {
        topicsMap.set(t.id, { palee_id: t.id, depends_on: t.depends_on, topic_mastery: 0 });
      }
    }

    for (const topic of roadmap.topics) {
      const deps = effectiveDepsMap.get(topic.id) ?? [];
      for (const depId of deps) {
        if (!topicsMap.has(depId)) {
          errors.push(`Topic ${topic.id} depends on missing topic: ${depId}`);
        }
      }
    }

    const { cycles, truncated } = detectCyclesBounded(topicsMap);
    for (const cycle of cycles) {
      let message = `Dependency cycle detected: ${cycle.join(' → ')}`;
      // Name the hops the flag invented: a learner who authored one dependency
      // should not have to deduce which edge --auto-chain added to the loop.
      if (chainResult && chainResult.synthesizedEdges.size > 0) {
        const ours: string[] = [];
        for (let i = 0; i + 1 < cycle.length; i++) {
          if (chainResult.synthesizedEdges.has(cycle[i] + '\u0000' + cycle[i + 1])) {
            ours.push(cycle[i] + ' → ' + cycle[i + 1]);
          }
        }
        if (ours.length > 0) {
          message += ' (synthesized by --auto-chain: ' + ours.join(', ') + '; the rest are authored)';
        }
      }
      errors.push(message);
    }
    if (truncated) {
      errors.push('Dependency cycle enumeration truncated at 1000 cycles — additional cycles may exist');
    }

    if (errors.length > 0) {
      console.error('Validation errors:');
      for (const err of errors) {
        console.error(`  • ${err}`);
      }
      process.exitCode = ExitCode.Validation;
      return;
    }

    // Deferred to this point so a chain the validator then rejects never
    // announces itself as fact (#73 review item 3).
    if (chainResult) {
      // The count is edges actually synthesized, not topics in the file: a
      // cycle-closing edge is dropped into `skippedEdges` instead, and a topic
      // that starts a chain received nothing at all, so reporting the topic
      // count as "chained" overclaimed the work this pass did (INV-47).
      console.log(
        `Auto-chain: ${chainResult.synthesizedEdges.size} chain edge(s) synthesized across ${roadmap.topics.length} roadmap topics.`
      );
      if (chainResult.skippedEdges.length > 0) {
        console.log(
          `Auto-chain: ${chainResult.skippedEdges.length} chain edge(s) skipped to keep the graph acyclic.`
        );
      }
    }

    console.log('Roadmap validated successfully.');
    console.log(`  Topics: ${roadmap.topics.length}`);
    console.log(`  Source: ${roadmapPath}`);
    console.log();
    console.log('This will create/update the following files:');
    for (const topic of roadmap.topics) {
      console.log(`  • ${topic.path}`);
    }
    console.log();

    /**
     * Executes batch import of parsed roadmap topics into vault notes with error isolation and OCC tracking.
     *
     * @returns Promise resolving when all topics have been processed
     *
     * @remarks
     * Iterates through all roadmap topics, validating vault path boundaries and writing topic notes with frontmatter.
     * Catches and isolates per-topic errors (logging OCC conflicts vs standard write errors) and assigns exit codes (4 for conflict, 1 for other failures).
     *
     * @example
     * ```typescript
     * await doImport();
     * ```
     */
    async function doImport(): Promise<void> {
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

      for (const topic of roadmap.topics) {
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

          // A symlinked target is never a note, whether or not it resolves.
          // Reading through one pulls the outside file's body into the import as
          // if it were the existing note, and the atomic write below then
          // replaces the link itself, so content from outside the vault lands
          // inside it and the link is destroyed. The existence test has to be
          // `lstat`: `existsSync` follows the link and reports false for a
          // dangling symlink, which would let the writer replace the link
          // unseen. A topic path can arrive as a symlink because
          // `palee roadmap --from` is routinely pointed at cloned repos.
          //
          // The read that follows is bound to this stat by descriptor, so a link
          // planted between the check and the read is detected before outside
          // content is imported. The write is still check-then-write, but it
          // cannot leak content either: `atomicWrite` renames a fresh file over
          // the entry, so a planted link is replaced rather than written
          // through. Closing that window portably is tracked in #217 — a
          // no-follow open is not the fix, because `fs.constants.O_NOFOLLOW` is
          // undefined on win32 and the open follows the link anyway.
          let targetStat: fs.Stats | null;
          try {
            targetStat = fs.lstatSync(resolvedTargetPath);
          } catch (statErr) {
            if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw statErr;
            }
            targetStat = null;
          }
          if (targetStat !== null) {
            if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
              console.error(`Skipped ${topic.id}: ${topic.path} is not a regular file`);
              failed++;
              continue;
            }
            const relRealTarget = path.relative(resolvedVault, fs.realpathSync(resolvedTargetPath));
            if (
              path.isAbsolute(relRealTarget) ||
              relRealTarget === '..' ||
              relRealTarget.startsWith('..' + path.sep) ||
              relRealTarget.split(path.sep).includes('..')
            ) {
              console.error(`Skipped ${topic.id}: ${topic.path} resolves outside the vault`);
              failed++;
              continue;
            }
          }

          if (targetStat !== null) {
            try {
              content = readBoundNote(resolvedTargetPath, targetStat);
            } catch (e: unknown) {
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


          // A pillar absent from the note resolves to `undefined` and is
          // dropped here, so an import never writes an assessment score the
          // learner does not have (#191).
          const paleeData: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(
            resolveTopicUpdates({
              topic,
              existingById: existingTopicsById.get(topic.id),
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
          const updatedContent = updateFrontmatter(content, paleeData, removals);
          await atomicWrite(vaultPath, resolvedTargetPath, updatedContent, fingerprint);

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

    if (!options.yes && !process.stdin.isTTY) {
      console.error('Error: Non-interactive environment detected. Use --yes to confirm import.');
      process.exitCode = ExitCode.Usage;
      return;
    }

    if (options.yes) {
      console.log('Auto-confirmed via --yes.');
      await doImport();
    } else {
      console.log('Proceed? (y/N): ');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>(resolve => rl.question('', resolve));
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
      await doImport();
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default roadmapCommand;
