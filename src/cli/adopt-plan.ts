/**
 * Batch Adoption Plan
 *
 * The plan phase of `palee adopt`'s batch mode, extracted from the handler in
 * `src/cli/adopt.ts` (P3-14 of audit issue #565): the `--auto-chain` graph plan
 * (id minting, prerequisite resolution, tiered chaining, cycle gate) and the
 * write-plan machinery that turns it into the bytes a commit writes — the one
 * note composer shared by the preview and the Phase-1 preflight, the
 * result-cap projection and its edge severing, and the skip reports the
 * preview and Phase 1 both print. The handler stays the orchestrator; the
 * execution of the planned writes lives in `./adopt-execute`.
 */

import path from 'path';
import {
  parseFrontmatter,
  updateFrontmatter,
  loadTopics,
  deriveTocEnumeration,
} from '../storage';
// P3-11/#281/#289: the planner folds link targets through the walker's identity
// fold, so a spelled form of a walked path still resolves to its topic.
import { foldIdentity } from '../storage/vault-walker';
import { normalizeDependencies } from '../storage/dependencies';
import { noteContentExceedsReadCap, oversizedWriteDiagnostic, MAX_NOTE_SOURCE_BYTES } from '../storage/source-cap';
import { resolveTopicMastery, carriedPillarScores } from '../engine/mastery';
import { buildTopicScaffold } from '../engine/topic-scaffold';
import { generateTopicId } from '../engine/topic-id';
import { planAutoChainWithHygiene } from '../engine/auto-chain';
import {
  extractDeclaredPrerequisites,
  resolveDeclaredPrerequisites,
} from '../engine/prereq-text';
import {
  composeTieredChain,
  type AutoChainTier,
  type DependsOnSource,
  type TieredChainPlan,
} from '../engine/toc-chain';
import { detectCyclesBounded } from '../engine/dependency';
import { AdoptOptions, Difficulty, normalizeDifficulty, normalizeAssessedAt, type TopicNode } from '../types';
import { resolveNoteTitle } from '../storage/note-title';
import { ExitCode } from './exit-codes';
import { type BatchScanResult, type StagedNote } from './adopt-scan';

/** Renders a vault-relative path as a single-line diagnostic value. */
export function formatDiagnosticPath(relativePath: string): string {
  return JSON.stringify(relativePath);
}

/** One planned write edge: `path` is the note being adopted, `dependsOnPath` its predecessor. */
export interface ChainWriteEdge {
  path: string;
  /** The predecessor's vault-relative path, or `null` for a chain head */
  dependsOnPath: string | null;
}

/** The plan phase's output: what the commit will write and what the preview reports. */
export interface ChainPlanState {
  /** The tiered chain plan, `null` unless `--auto-chain` planned one */
  chainPlan: TieredChainPlan | null;
  /** Note → tier that authored its planned edge (C5 `depends_on_source`) */
  chainSourceOf: Map<string, DependsOnSource>;
  /** C4 honest refusal: the scope carries no numbering and no chainable enumeration */
  chainRefused: boolean;
  /** Set when the selected tier declines to read an enumeration that does exist */
  tocLinksDeclined: boolean;
  /** Declared names that matched no single note — counted, never fatal */
  declaredSkippedCount: number;
  /**
   * Note → the `depends_on` list the commit writes. Carries an entry for every
   * note the planner visited, even when it planned nothing for it, so *presence*
   * is what tells "no plan" from "a plan that selects nothing".
   */
  chainDependsOn: Map<string, string[]>;
  /** Edges the commit writes, in chain order: new note -> the predecessor it depends on */
  chainWritePlan: ChainWriteEdge[];
  /** In-scope already-adopted notes the chain bridges over; listed, never written */
  chainBridgedPaths: string[];
}

/** The run-level inputs the note composer and the cap projection read. */
export interface BatchComposeContext {
  /** The parsed CLI flags; the composer reads `--difficulty` */
  options: AdoptOptions;
  /** The CLI-normalized difficulty, applied when `options.difficulty` is absent */
  difficulty: Difficulty;
}

/**
 * The plan phase's outcome: `aborted` when the cycle gate refused the run —
 * the errors are already printed and the exit code already set — otherwise
 * the settled plan state.
 */
export type ChainPlanOutcome = { aborted: true } | { aborted: false; state: ChainPlanState };

/**
 * Plans the batch's auto-chain dependency graph and the writes it implies.
 *
 * @param input.vaultPath - Absolute path to the vault root
 * @param input.scan - The scan result whose staged candidates the plan orders
 * @param input.options - The parsed CLI flags; only `--auto-chain` shapes the plan
 * @param input.tier - The parsed `--chain-tier`, or `null` when the flag was absent
 * @returns The plan state, or `aborted` when the cycle gate refused the batch
 *
 * @remarks
 * When `--auto-chain` is set, derives each note's depends_on predecessor
 * from numbered directory/file prefixes BEFORE the dry-run/confirmation
 * gate, so the planned graph is cycle-checked with zero writes and the
 * dry-run prints the exact edge plan. The plan spans every note in the
 * scanned scope — including notes already adopted there — so the chain
 * bridges over an adopted note instead of restarting; already-adopted
 * notes only ever appear as predecessors, never as write targets.
 *
 * Mutates `input.scan` the way the handler always did: every staged note
 * gets its pre-minted `topicId` here, and `scan.toAdopt` is re-sorted into
 * chain order so verbose/dry-run output reads head-to-tail. On a cycle the
 * run is refused with exit code `Validation` before anything is printed
 * below it — the caller must stop without previewing or writing.
 *
 * @example
 * ```typescript
 * const outcome = buildAutoChainPlan({ vaultPath, scan, options, tier });
 * if (outcome.aborted) return;
 * ```
 */
export function buildAutoChainPlan(input: {
  vaultPath: string;
  scan: BatchScanResult;
  options: AdoptOptions;
  tier: AutoChainTier | null;
}): ChainPlanOutcome {
  const { vaultPath, scan, options, tier } = input;
  const { toAdopt } = scan;
  let chainPlan: TieredChainPlan | null = null;
  const chainSourceOf: Map<string, DependsOnSource> = new Map();
  let chainRefused = false;
  let tocLinksDeclined = false;
  const declaredDeps = new Map<string, { id: string; path: string }[]>();
  let declaredSkippedCount = 0;
  const chainDependsOn = new Map<string, string[]>();
  // Dry-run preview must show exactly what the commit will write, so the plan
  // is recorded here at graph-build time rather than re-derived from
  // `chainPlan.predecessorOf`, which also spans already-adopted notes.
  const chainWritePlan: ChainWriteEdge[] = [];
  const chainBridgedPaths: string[] = [];

  const packState = (): ChainPlanState => ({
    chainPlan,
    chainSourceOf,
    chainRefused,
    tocLinksDeclined,
    declaredSkippedCount,
    chainDependsOn,
    chainWritePlan,
    chainBridgedPaths,
  });

  if (!options.autoChain || toAdopt.length === 0) {
    return { aborted: false, state: packState() };
  }

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
  for (const relPath of scan.plannableAdopted) {
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
    // These two maps are keyed by note identity, so they fold the way the
    // walker keys everything else — case *and* Unicode. Case alone was enough
    // until #281 taught the rest of the pipeline that APFS stores `cafe` +
    // U+0301 where a link arrives composed: the spelled key then matches no
    // walked path, and a prerequisite that really exists is dropped as
    // `missing`. #289 fixed the same half-fold in `withWalkedCasing`.
    const relPath = foldIdentity(rawPath.replace(/\\/g, '/')).replace(/\.md$/, '');
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
    let raw = foldIdentity(destination.trim().replace(/\\/g, '/'));
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
      const key = foldIdentity(ref.name.trim().replace(/\\/g, '/')).replace(/\.md$/, '');
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
    (relPath) => scan.adoptedPaleeId.get(relPath)
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
    tier: tier ?? 'strict',
    numbered: hygienePlan,
    // Passed whole under every tier: the strict tier consumes none of it but
    // still has to report whether the full tier could have, which is what the
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
    scan.handAuthoredDeps.size === 0;
  // Distinct from "nothing to chain": under `strict` the enumeration may hold
  // links the selected tier simply does not read, and naming the tier is the
  // useful advice. Keyed on the enumeration's *presence* it lies in the other
  // case — a README linking only to notes no tier will order (a `solution/`
  // subtree, a translation copy) would send the learner to
  // `--chain-tier full`, which refuses there for the same reason, costing them
  // the roadmap pointer that does apply. `tocCandidateCount` is what full
  // tier could have ordered, so the advice is only offered when it leads
  // somewhere — and "somewhere" needs more than one note, since a lone
  // candidate is the chain head and `toc` would write no edge either.
  tocLinksDeclined = tier === 'strict' && tiered.tocCandidateCount > 1;
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
    tier === 'full'
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
    const handAuthored = scan.handAuthoredDeps.get(relPath);
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
      // `exactOptionalPropertyTypes` rejects explicit `undefined` for
      // `depends_on`; the cycle detector reads a missing key the same as
      // `undefined` (`?? []`), so only set it when present.
      plannedGraph.set(topic.id, {
        palee_id: topic.id,
        ...(topic.depends_on !== undefined ? { depends_on: topic.depends_on } : {}),
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
    return { aborted: true };
  }

  // Adopt in chain order so verbose/dry-run output reads head-to-tail.
  const orderIndex = new Map(chainPlan.orderedPaths.map((p, i) => [p, i]));
  toAdopt.sort(
    (a, b) => (orderIndex.get(a.relativePath) ?? 0) - (orderIndex.get(b.relativePath) ?? 0)
  );

  return { aborted: false, state: packState() };
}

/**
 * Builds the exact text adoption writes for one note, and the `depends_on` it
 * carries.
 *
 * @param chain - The plan state the composer reads: the planner's `depends_on`
 *   choices and the per-edge provenance label
 * @param ctx - The run-level flags: `--difficulty` and its normalized default
 * @param note - The scanned candidate this write is for
 * @param content - The note's text: the scanned bytes for the preview, the
 *   pre-write re-read for the commit
 * @param frontmatter - That text's parsed frontmatter
 * @param topicId - The id this write stores
 * @param droppedIds - Ids to omit from the planned list, for a projection
 *   deciding whether a note it has already dropped still fits
 * @returns The rendered note and the dependency list it was rendered with
 *
 * @remarks
 * One composer for the preview and the commit (#565 P1-10 review). The size it
 * produces is what decides whether the note is written at all, so a preview
 * measuring its own spelling of the same frontmatter would promise edges the
 * commit then severs.
 *
 * `droppedIds` lets the projection measure a note against a plan it has pruned
 * without mutating that plan first, so the verdict it reaches is taken from the
 * bytes {@link severPlannedBatchEdges} will actually land. It is scoped to the
 * planned branch for the same reason the severing is: a note with no plan entry
 * keeps its own frontmatter list, which no drop of this run's touches.
 */
export function composeAdoptedNote(
  chain: ChainPlanState,
  ctx: BatchComposeContext,
  note: StagedNote,
  content: string,
  frontmatter: Record<string, unknown> | null,
  topicId: string,
  droppedIds?: ReadonlySet<string>
): { updatedContent: string; plannedDeps: string[] } {
  const title = resolveNoteTitle(content, note.absolutePath, frontmatter);

  const topicMastery = resolveTopicMastery({
    conceptual: frontmatter?.conceptual,
    practical: frontmatter?.practical,
    debug: frontmatter?.debug,
    feynman: frontmatter?.feynman,
    existing: frontmatter?.topic_mastery,
    precedence: 'existing-first',
  });

  // Same rule as single-file adoption: `--difficulty` overrides, absence
  // preserves what the note's own frontmatter declares.
  const effectiveDifficulty =
    ctx.options.difficulty === undefined ? normalizeDifficulty(frontmatter?.difficulty) : ctx.difficulty;

  // #258 — `depends_on` a note already states is not adoption's to clear. The
  // planned edge wins when the chain authored one for this note; otherwise the
  // note's own list is what gets written back. Under a plain `adopt --all` the
  // plan is empty for every note, so this is what stops that invocation — the
  // commonest one — from flattening a hand-written gate to `[]`. A note the
  // planner visited keeps the ids the planner chose for it, which for a
  // hand-authored note are the same ids (see `handAuthoredDeps`).
  //
  // `chainDependsOn` carries an entry for every note the planner visited, even
  // when it planned nothing for it, so *presence* is what tells "no plan" from
  // "a plan that selects nothing". The distinction is load-bearing once the
  // result-cap projection severs a planned edge: an emptied list is a decision
  // this run made and the plan it printed shows, so falling back to the note's
  // own frontmatter here would write a gate that was just removed.
  const ownDeps = normalizeDependencies(frontmatter?.depends_on);
  const hasPlan = chain.chainDependsOn.has(note.relativePath);
  const chainDeps = chain.chainDependsOn.get(note.relativePath) ?? [];
  const preservedOwnDeps = !hasPlan && ownDeps.length > 0;
  let plannedDeps = preservedOwnDeps ? ownDeps : chainDeps;
  if (!preservedOwnDeps && droppedIds !== undefined && droppedIds.size > 0) {
    plannedDeps = plannedDeps.filter((id) => !droppedIds.has(id));
  }
  const paleeData: Record<string, unknown> = {
    palee_id: topicId,
    palee_schema: 1,
    title,
    difficulty: effectiveDifficulty,
    depends_on: plannedDeps,
    topic_mastery: topicMastery,
    assessed_at: normalizeAssessedAt(frontmatter?.assessed_at),
    ...carriedPillarScores(frontmatter),
    // The never-reviewed SM-2 scaffold, from the engine's one builder (P3-10) —
    // spread at this position so the written key order is unchanged.
    ...buildTopicScaffold(),
  };

  // C5 (PAL-205-C): additive provenance label. Only notes whose chain
  // edge was actually written carry it; old PALEE builds parse the file
  // unchanged (unknown frontmatter keys are preserved, never rejected),
  // and gating behavior is untouched by this field.
  if (plannedDeps.length > 0) {
    const edgeSource = chain.chainSourceOf.get(note.relativePath);
    if (edgeSource) {
      paleeData.depends_on_source = edgeSource;
    } else if (preservedOwnDeps) {
      // Same label the prose branch uses for a list the author wrote, so both
      // adopt paths describe a preserved hand-written gate the same way rather
      // than one labelling it and the other leaving it absent.
      paleeData.depends_on_source = 'declared';
    }
  }

  return { updatedContent: updateFrontmatter(content, paleeData), plannedDeps };
}

/** Reports notes dropped for crossing the read cap, by path and reason. */
export function printOversizedResults(list: Array<{ relativePath: string; reason: string }>): void {
  if (list.length === 0) return;
  console.error(
    `Skipped ${list.length} note(s) that would have crossed the ${MAX_NOTE_SOURCE_BYTES} byte read cap:`
  );
  for (const { relativePath, reason } of list.slice(0, 5)) {
    console.error(`  • ${formatDiagnosticPath(relativePath)} (${reason})`);
  }
  if (list.length > 5) {
    console.error(`  • … and ${list.length - 5} more`);
  }
}

/** Reports planned edges removed because the note they named is not written. */
export function printSeveredEdges(list: Array<{ relativePath: string; droppedPath: string }>): void {
  if (list.length === 0) return;
  console.error(
    `  ${list.length} planned dependency edge(s) named a skipped note and were removed:`
  );
  for (const { relativePath, droppedPath } of list.slice(0, 5)) {
    console.error(`  • ${formatDiagnosticPath(relativePath)} → ${formatDiagnosticPath(droppedPath)}`);
  }
  if (list.length > 5) {
    console.error(`  • … and ${list.length - 5} more`);
  }
}

/**
 * Removes every planned edge that names a note this run will not write.
 *
 * @param chain - The plan state whose id map and write plan are rewritten
 * @param dropped - Each skipped id, mapped to the note it was minted for
 * @returns The edges removed, as `survivor → skipped note`
 *
 * @remarks
 * An edge to a note that is never written is an edge the plan promised and the
 * vault will not get: the dependent note would be written with a `depends_on`
 * pointing at nothing and drop out of `palee plan` with only a `validate`
 * warning to say why. Both the id map the write reads (`chainDependsOn`) and the
 * path plan the preview prints (`chainWritePlan`) are rewritten, so the plan a
 * learner approves is the plan that lands. The skipped note's own entry leaves
 * the plan too — it is not an unchained note, it is not being adopted.
 */
function severPlannedBatchEdges(
  chain: ChainPlanState,
  dropped: ReadonlyMap<string, string>
): { relativePath: string; droppedPath: string }[] {
  const severed: { relativePath: string; droppedPath: string }[] = [];
  if (dropped.size === 0) return severed;
  const droppedPaths = new Set(dropped.values());
  for (const [relativePath, deps] of chain.chainDependsOn) {
    const kept = deps.filter((id) => !dropped.has(id));
    if (kept.length === deps.length) continue;
    for (const id of deps) {
      if (dropped.has(id)) {
        severed.push({ relativePath, droppedPath: dropped.get(id) ?? id });
      }
    }
    chain.chainDependsOn.set(relativePath, kept);
  }
  const planned = chain.chainWritePlan.filter((edge) => !droppedPaths.has(edge.path));
  // Notes that keep at least one edge whose target this run still writes.
  const surviving = new Set(
    planned
      .filter((edge) => edge.dependsOnPath !== null && !droppedPaths.has(edge.dependsOnPath))
      .map((edge) => edge.path)
  );
  const keptPlan: ChainWriteEdge[] = [];
  const headPlanned = new Set<string>();
  for (const edge of planned) {
    if (edge.dependsOnPath === null || !droppedPaths.has(edge.dependsOnPath)) {
      // A real head claims the slot too. Unreachable with today's builders,
      // which give a note one shape or the other, but it keeps "one head entry
      // per note" the pruner's own guarantee rather than a consequence of how
      // the plan was assembled upstream.
      if (edge.dependsOnPath === null) headPlanned.add(edge.path);
      keptPlan.push(edge);
      continue;
    }
    // A note may plan several edges — its own declared prerequisites or its
    // hand-written gates. Severing one of them leaves the others, and a note
    // with a surviving edge is not a chain head: converting the severed entry
    // printed that note twice in the preview, once of them a head whose
    // `depends_on` "stays empty", and made `Unchained:` count a note the plan
    // does gate. The entry goes. Only a note whose last planned edge went
    // becomes the head the write will hand it — and once, however many of its
    // edges went.
    if (surviving.has(edge.path) || headPlanned.has(edge.path)) continue;
    headPlanned.add(edge.path);
    keptPlan.push({ path: edge.path, dependsOnPath: null });
  }
  chain.chainWritePlan.splice(0, chain.chainWritePlan.length, ...keptPlan);
  return severed;
}

/**
 * Measures every candidate against the plan the notes in `dropped` imply.
 *
 * @param scan - The scan result whose staged candidates are measured
 * @param chain - The plan state the composer reads for the planned edges
 * @param ctx - The run-level flags the composer applies
 * @param dropped - Ids this projection has decided not to write, as minted here
 * @returns Each candidate that still crosses the cap, keyed by its minted id and
 *   carrying the note it was minted for and the size it measured
 *
 * @remarks
 * A planned edge to a note that lands in `dropped` is severed before the write,
 * so a dependent's committed content is one `- T-…` line shorter than the same
 * note measured whole. Deciding it from that pre-pruning size refused a note the
 * pruned plan can after all write, and named a byte count that would never have
 * landed. Filtering `dropped` out here is the removal
 * {@link severPlannedBatchEdges} makes on the surviving plan, applied before the
 * severing rather than after it.
 *
 * A dropped note is re-measured too, not only the notes that depended on it: a
 * pair of neighbours each inside the ceiling by one edge's width crosses it only
 * because of the other, so pruning one can bring the other back under.
 */
function projectDropsAgainst(
  scan: BatchScanResult,
  chain: ChainPlanState,
  ctx: BatchComposeContext,
  dropped: ReadonlySet<string>
): Map<string, { relativePath: string; byteLength: number }> {
  const found = new Map<string, { relativePath: string; byteLength: number }>();
  for (const note of scan.toAdopt) {
    // One id per note, minted here rather than in Phase 1, so the preview and the
    // write measure the same frontmatter. `--auto-chain` already minted it.
    const topicId = note.topicId ?? generateTopicId();
    note.topicId = topicId;
    const { frontmatter: scannedFrontmatter, error } = parseFrontmatter(note.content);
    // The scan already moved an unparseable block to its own bucket, which names
    // the note; deciding it here would take that away from it.
    if (error) continue;
    let updatedContent: string;
    try {
      ({ updatedContent } = composeAdoptedNote(chain, ctx, note, note.content, scannedFrontmatter, topicId, dropped));
    } catch {
      // A block `updateFrontmatter` refuses is the pre-write re-read's to refuse.
      continue;
    }
    if (!noteContentExceedsReadCap(updatedContent)) continue;
    found.set(topicId, {
      relativePath: note.relativePath,
      byteLength: Buffer.byteLength(updatedContent, 'utf8'),
    });
  }
  return found;
}

/**
 * Settles the projected result-cap drops to a fixed point, severs their edges
 * from the plan, and removes the dropped notes from the batch.
 *
 * @param input.scan - The scan result; `scan.toAdopt` loses the projected drops
 * @param input.chain - The plan state; `chainDependsOn` and `chainWritePlan` are
 *   rewritten without the edges the dropped notes carried
 * @param input.ctx - The run-level flags the note composer applies
 * @returns The projected drops and severed edges, for the preview to report
 *
 * @remarks
 * The scan bounded the source bytes, not the result. Which notes cross the
 * ceiling once their managed keys are added is decided here, from the scanned
 * bytes, *before* the plan is printed and confirmed — otherwise the dry-run and
 * the confirmation screen promise a gate that the write drops, and a learner
 * approves edges that never land. Phase 1 re-checks the same verdict against the
 * pre-write re-read; a note that only changed since then is dropped there and
 * reported on the same banner.
 *
 * The skip set settles to a fixed point. Each note's verdict depends only on
 * which of *its* prerequisites are in the set, and a plan that reached here is
 * acyclic — the pre-write cycle gate refuses the rest — so a note's verdict stops
 * changing once the notes behind it have, which takes at most as many passes as
 * the chain is deep. The bound below is that depth, not a retry allowance: a plan
 * that arrived cyclic some other way would otherwise spin here forever.
 */
export function settleProjectedCapDrops(input: {
  scan: BatchScanResult;
  chain: ChainPlanState;
  ctx: BatchComposeContext;
}): {
  projectedOversized: Array<{ relativePath: string; reason: string }>;
  projectedSevered: Array<{ relativePath: string; droppedPath: string }>;
} {
  const { scan, chain, ctx } = input;
  const { toAdopt } = scan;

  let projectedDropped = projectDropsAgainst(scan, chain, ctx, new Set());
  for (let pass = 0; pass < toAdopt.length && projectedDropped.size > 0; pass += 1) {
    const next = projectDropsAgainst(scan, chain, ctx, new Set(projectedDropped.keys()));
    const settled =
      next.size === projectedDropped.size && [...next.keys()].every((id) => projectedDropped.has(id));
    projectedDropped = next;
    if (settled) break;
  }

  const projectedOversized: Array<{ relativePath: string; reason: string }> = [];
  const projectedOversizedPaths = new Set<string>();
  /** Each projected id, mapped to the note it was minted for, for the severing */
  const projectedDropPaths = new Map<string, string>();
  for (const [id, { relativePath, byteLength }] of projectedDropped) {
    projectedOversized.push({ relativePath, reason: oversizedWriteDiagnostic(byteLength) });
    projectedOversizedPaths.add(relativePath);
    projectedDropPaths.set(id, relativePath);
  }
  const projectedSevered = severPlannedBatchEdges(chain, projectedDropPaths);
  // #565 P1-10 review: the preview, the verbose list, the empty-batch check and the
  // confirmation count all read `toAdopt`, and a projected note is one Phase 1 will
  // not write. Leaving it in promised a note that never lands — and when every
  // candidate projected out, the run still asked the learner to confirm an empty
  // batch. They are removed from the batch here, and named by `printOversizedResults`
  // below, so the skip is disclosed rather than hidden.
  for (let i = toAdopt.length - 1; i >= 0; i -= 1) {
    const note = toAdopt[i];
    if (note !== undefined && projectedOversizedPaths.has(note.relativePath)) toAdopt.splice(i, 1);
  }

  return { projectedOversized, projectedSevered };
}
