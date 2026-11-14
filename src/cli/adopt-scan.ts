/**
 * Batch Adoption Scan
 *
 * The scan phase of `palee adopt`'s batch mode, extracted from the handler in
 * `src/cli/adopt.ts` (P3-14 of audit issue #565): one `walkVault` pass over the
 * scan root that stages every adoptable note and fills the accounting buckets
 * the preview and the write plan read. The handler stays the orchestrator and
 * owns the empty-scope notice; this module owns only the scan and its buckets,
 * and never prints. `--undo`'s reversal scan keeps its own copy in
 * `src/cli/adopt-undo.ts`, which cannot import from here without a cycle.
 */

import fs from 'fs';
import {
  parseFrontmatter,
  computeFingerprint,
  walkVault,
  relativeVaultPath,
  countWords,
} from '../storage';
// P3-11 (#565): the --include/--exclude/--tag decision is one predicate beside the
// matchers it folds, so the adoption scan and `adopt --undo`'s scan cannot drift.
import { batchScopeExclusion } from '../storage/pattern-matcher';
import { noteExceedsReadCap, oversizedNoteDiagnostic } from '../storage/source-cap';
import { normalizeDependencies } from '../storage/dependencies';
// P3-13 (#565): the "is this adopted" judgment is the shared predicate — the same
// one `loadTopics` and `--undo` apply — so no batch can count an unusable id as
// "Already Adopted" or hand one to the planner as a bridge note.
import {
  classifyNoteForChain,
  isValidPaleeId,
  README_CLASS_STEMS,
  stemOf,
  type Tier0SkipReason,
} from '../engine/tier0-hygiene';
import { extractDeclaredPrerequisites, type DeclaredPrereqRef } from '../engine/prereq-text';
import { AdoptOptions } from '../types';

/**
 * Minimum body words for a README/SUMMARY note to be read as lesson content
 * rather than as navigation.
 *
 * @remarks
 * Some curricula put the lesson itself in `README.md` — every module of
 * `microsoft/Web-Dev-For-Beginners` is ~3800 words of prose in that file. A
 * name-only skip dropped all of them from a plain `--all` while `--auto-chain`
 * adopted them, so the default batch silently lost the curriculum (#545). Below
 * the threshold a README is still a title and a link list and is skipped as
 * before; at or above it the body is the lesson and is adopted. The count is a
 * heuristic, which is why a skip stays counted in the `Skipped (meta)` report and
 * `--include` still names any path deliberately.
 */
const README_LESSON_MIN_WORDS = 200;

/** One candidate note the scan staged, on its way through plan and execute. */
export interface StagedNote {
  absolutePath: string;
  relativePath: string;
  content: string;
  fingerprint: string;
  /** Pre-minted topic ID, assigned when --auto-chain plans the dependency graph up front */
  topicId?: string;
}

export interface BatchScanResult {
  /** Every markdown file the walk found under the scan root, in walk order */
  allFiles: string[];
  /**
   * #312 — every vault-relative path the scan looked at, which is the scope a
   * supplied `--include`/`--exclude` pattern is measured against. The aggregate
   * `Excluded (Pattern)` count alone cannot tell "the filter worked and there was
   * nothing to filter" from "this pattern names no file here", so the per-pattern
   * tallies are computed over this list.
   */
  scannedPaths: string[];
  /** Notes this batch will write, in scan order (the planner may re-sort) */
  toAdopt: StagedNote[];
  alreadyAdopted: string[];
  /**
   * The already-adopted notes that passed `--include`/`--exclude`/`--tag`, and
   * therefore the only ones the chain planner may see. Reported separately
   * from {@link BatchScanResult.alreadyAdopted} because that list is the scan's accounting of
   * the scope, while this one is a set of write-plan participants: a note the
   * user excluded must not become a `depends_on` entry written to a new note.
   */
  plannableAdopted: string[];
  skippedByPattern: string[];
  skippedByTag: string[];
  /** B6 - notes Tier-0 hygiene kept out of a batch adoption, by reason */
  skippedByHygiene: Map<Tier0SkipReason, string[]>;
  /** B7 — notes whose `palee_id` is truthy but unusable, so they are neither chained nor adopted */
  skippedInvalidId: string[];
  /** Notes whose frontmatter block will not parse, and why: neither adopted nor rewritten */
  skippedUnreadable: Map<string, string>;
  /**
   * #565 P1-10 — notes over the read ceiling, and their diagnostic. Kept apart from
   * `skippedUnreadable` because the remedy differs: a malformed block is the learner's
   * to repair, an oversized file is not a note at all, and the shared label promises
   * "frontmatter will not parse" — which would be false here.
   */
  skippedOversized: Map<string, string>;
  /**
   * Raw parsed `palee_id` per already-adopted path, handed to the planner so it
   * re-derives B7 itself. P3-13: the scan pre-filters, so only ids the shared
   * predicate accepts travel — the planner's re-derivation stays as the
   * defense-in-depth any other caller of the API inherits.
   */
  adoptedPaleeId: Map<string, unknown>;
  /**
   * #258 — the non-empty `depends_on` each candidate note already carries in its
   * own frontmatter, i.e. the prerequisites the learner stated directly rather
   * than in the `## Prerequisites` prose the planner otherwise reads. Collected
   * during the scan because that is where the note is parsed once, and only for
   * an `--auto-chain` batch, which is the pass that synthesizes an edge over it.
   */
  handAuthoredDeps: Map<string, string[]>;
  /** Dependency declarations captured during the scan for the Phase-1 drift check. */
  scanDependencyDeclarations: Map<
    string,
    { dependsOn: string[]; prerequisites: DeclaredPrereqRef[] }
  >;
}

/**
 * True when a note opens a frontmatter block and never closes it.
 *
 * @param content - The note's text
 * @returns `true` for a leading `---` line with no closing delimiter anywhere
 *
 * @remarks
 * `parseFrontmatter` reports this shape as "no frontmatter" and no error, because
 * the same bytes can be an ordinary Markdown thematic break — and a *closed*
 * block holding a scalar stays exactly that, adoptable. An unterminated opener
 * is different: any `palee_id` written under it is invisible to the parser, so
 * adopting the note would prepend a fresh block with a minted id and strand the
 * learner's own in the body, which is the identity loss adoption exists to avoid.
 * Both delimiters are matched exactly, as the parser matches them: its opener
 * regex wants `---` at the start of the file and its closer wants `---` at the
 * start of a line, so a padded `--- ` opener is no frontmatter at all (adoptable)
 * while an indented ` ---` closes nothing (refused). A trim here would disagree
 * with the parser in both directions, and the disagreeing direction is the one
 * that strands an identity.
 */
export function hasUnclosedFrontmatterOpener(content: string): boolean {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return false;
  }
  return !lines.slice(1).includes('---');
}

/**
 * Walks the scan root once and stages the batch adoption's inputs.
 *
 * @param vaultPath - Absolute path to the vault root (the base for relative paths)
 * @param scanRoot - Absolute path to walk: the vault root, or a directory target
 * @param options - The parsed CLI flags; the scope filters and `--auto-chain` shape the buckets
 * @returns The staged candidates and every accounting bucket the preview and plan read
 *
 * @remarks
 * Never prints: the handler owns the empty-scope notice and every report, so a
 * scan's output order stays the orchestrator's decision. The staging is
 * deliberately the same pass that fills the counters — a note is read, parsed
 * and judged exactly once, and the buckets it lands in are the ones the
 * preview, the planner and the Phase-1 drift check all consume.
 *
 * @example
 * ```typescript
 * const scan = scanBatchAdoptionCandidates(vaultPath, scanRoot, options);
 * if (scan.allFiles.length === 0) { ... }
 * ```
 */
export function scanBatchAdoptionCandidates(
  vaultPath: string,
  scanRoot: string,
  options: AdoptOptions
): BatchScanResult {
  const allFiles = walkVault(scanRoot);

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
  /**
   * #312 — every vault-relative path the scan looked at, which is the scope a
   * supplied `--include`/`--exclude` pattern is measured against. The aggregate
   * `Excluded (Pattern)` count alone cannot tell "the filter worked and there was
   * nothing to filter" from "this pattern names no file here", so the per-pattern
   * tallies below are computed over this list.
   */
  const scannedPaths: string[] = [];
  /** B6 - notes Tier-0 hygiene kept out of a batch adoption, by reason */
  const skippedByHygiene = new Map<Tier0SkipReason, string[]>();
  /** B7 — notes whose `palee_id` is truthy but unusable, so they are neither chained nor adopted */
  const skippedInvalidId: string[] = [];
  /** Notes whose frontmatter block will not parse, and why: neither adopted nor rewritten */
  const skippedUnreadable = new Map<string, string>();
  /**
   * #565 P1-10 — notes over the read ceiling, and their diagnostic. Kept apart from
   * `skippedUnreadable` because the remedy differs: a malformed block is the learner's
   * to repair, an oversized file is not a note at all, and the shared label promises
   * "frontmatter will not parse" — which would be false here.
   */
  const skippedOversized = new Map<string, string>();
  /**
   * Raw parsed `palee_id` per already-adopted path, handed to the planner so it
   * re-derives B7 itself. P3-13: the scan pre-filters, so only ids the shared
   * predicate accepts travel — the planner's re-derivation stays as the
   * defense-in-depth any other caller of the API inherits.
   */
  const adoptedPaleeId = new Map<string, unknown>();
  /**
   * #258 — the non-empty `depends_on` each candidate note already carries in its
   * own frontmatter, i.e. the prerequisites the learner stated directly rather
   * than in the `## Prerequisites` prose the planner otherwise reads. Collected
   * during the scan because that is where the note is parsed once, and only for
   * an `--auto-chain` batch, which is the pass that synthesizes an edge over it.
   */
  const handAuthoredDeps = new Map<string, string[]>();
  /** Dependency declarations captured during the scan for the Phase-1 drift check. */
  const scanDependencyDeclarations = new Map<
    string,
    { dependsOn: string[]; prerequisites: DeclaredPrereqRef[] }
  >();

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
    // #312 — the denominator for per-pattern accounting: every file in the scanned
    // scope. A filter is a statement about *paths*, so a note the scan later drops
    // for an unreadable frontmatter or an unusable `palee_id` is still a file the
    // pattern could name, and a pattern that reached one of them is not dead.
    scannedPaths.push(relPath);
    // #565 P1-10: the read commands decline a note over the cap and will keep doing so,
    // so a batch must not adopt one. It joins the oversized bucket the summary reports
    // by name — the note is refused and the rest of the batch proceeds.
    const { size: sourceSize } = fs.statSync(filePath);
    if (noteExceedsReadCap(sourceSize)) {
      skippedOversized.set(relPath, oversizedNoteDiagnostic(sourceSize));
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body, error: frontmatterError } = parseFrontmatter(content);

    // A note whose frontmatter will not parse may still declare a `palee_id`
    // the parser never reached, so adopting it would mint an identity over the
    // learner's own and orphan every edge that named it. Such a note is
    // unwritable anyway — `updateFrontmatter` throws on it — and that throw
    // used to abort the whole batch with no filename in the message. INV-11
    // keeps a malformed note out of the scan's conclusions instead: name it,
    // skip it, adopt the rest.
    if (frontmatterError !== undefined) {
      skippedUnreadable.set(relPath, frontmatterError);
      continue;
    }

    // The other way to hide a declared id from the parser: an opener with no
    // closing fence yields no frontmatter and no error, so the note entered the
    // batch and the commit prepended a fresh block with a minted id, stranding
    // the learner's own in the body.
    if (hasUnclosedFrontmatterOpener(content)) {
      skippedUnreadable.set(relPath, 'the frontmatter block is never closed');
      continue;
    }

    // Check if already adopted
    if (frontmatter && frontmatter.palee_id) {
      // B7 (P3-13) — a present-but-unusable `palee_id` (e.g. `palee_id: 12345`,
      // which YAML parses as a number) is invisible to `loadTopics`, which
      // requires a non-empty string. The skip once ran only under `--auto-chain`,
      // so a plain batch counted such a note as "Already Adopted" — a verdict
      // the loader contradicts — and handed it to the planner as a bridge note
      // that resolved to no id, an unsatisfiable predecessor. Every batch now
      // judges the id with the shared predicate: skipped with a counted reason,
      // never rewritten (the learner's frontmatter is left alone) and never
      // chained, with the one repair path reported alongside the count.
      if (!isValidPaleeId(frontmatter.palee_id)) {
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
      if (batchScopeExclusion(relPath, frontmatter.tags, options) === null) {
        plannableAdopted.push(relPath);
      }
      continue;
    }

    // Batch scope — --include, --exclude and --tag decided by the one shared
    // predicate (P3-11 of #565), routed into the same counters the separate
    // checks kept: an include miss or an exclude hit is a pattern exclusion,
    // a tag miss is a tag exclusion. The predicate's fixed order keeps a note
    // failing several filters in the bucket the first failing filter claimed.
    const scopeExclusion = batchScopeExclusion(relPath, frontmatter?.tags, options);
    if (scopeExclusion === 'include' || scopeExclusion === 'exclude') {
      skippedByPattern.push(relPath);
      continue;
    }
    if (scopeExclusion === 'tag') {
      skippedByTag.push(relPath);
      continue;
    }

    // B1-B4 - repo meta, translation copies and templates are out of every
    // batch adoption, not just an --auto-chain batch (#298): they must not
    // become topics, and under a chain they must not be able to gate a real
    // lesson. These filters are always on for a scan, so an explicit
    // `--include` narrows the candidate set but does not re-admit a note
    // hygiene excludes; a learner who really wants one of those adopts it
    // directly in single-file mode, which has no batch hygiene pass.
    const decision = classifyNoteForChain(relPath);
    if (decision.cls === 'excluded') {
      recordHygieneSkip(decision.reason, relPath);
      continue;
    }

    // #442 (UX) / #545: a plain batch scan also skips README/SUMMARY navigation
    // docs. "Navigation" is decided by the body, not the filename alone: a
    // curriculum whose lesson body *is* the README had every lesson dropped by a
    // name-only rule, so a README carrying a lesson-sized body is adopted here.
    // The body is already parsed from the read above, so the check costs no extra
    // I/O — and it is the body, not the raw file: frontmatter is metadata, and
    // counting it let a heavily-tagged navigation page clear the threshold. Still
    // deliberately narrower than the classifier: under --auto-chain a
    // README/SUMMARY is curriculum backbone and is adopted, and an explicit
    // --include is a deliberate path pick. Repo-meta names are already excluded by
    // the classifier above.
    if (!options.autoChain && !options.include) {
      const stem = stemOf(relPath.slice(relPath.lastIndexOf('/') + 1));
      if (
        stem.length > 0 &&
        README_CLASS_STEMS.includes(stem) &&
        countWords(body) < README_LESSON_MIN_WORDS
      ) {
        recordHygieneSkip('repo-meta', relPath);
        continue;
      }
    }

    if (options.autoChain) {
      // Read where the frontmatter is already parsed, and only after every
      // filter above has been applied: a note this batch will not write must
      // not contribute an edge to the report either, so the list of surviving
      // candidates is the whole input.
      const ownDeps = normalizeDependencies(frontmatter?.depends_on);
      scanDependencyDeclarations.set(relPath, {
        dependsOn: ownDeps,
        prerequisites: extractDeclaredPrerequisites(content),
      });
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

  return {
    allFiles,
    scannedPaths,
    toAdopt,
    alreadyAdopted,
    plannableAdopted,
    skippedByPattern,
    skippedByTag,
    skippedByHygiene,
    skippedInvalidId,
    skippedUnreadable,
    skippedOversized,
    adoptedPaleeId,
    handAuthoredDeps,
    scanDependencyDeclarations,
  };
}
