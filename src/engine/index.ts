/**
 * Engine Core - Public Subsystem API
 *
 * @remarks
 * Bundles the SuperMemo SM-2 spaced repetition scheduler, the four-pillar pedagogical
 * mastery calculator, and the directed acyclic graph (DAG) dependency analysis engine.
 */

import * as sm2 from './sm2';
import * as dependency from './dependency';
import * as mastery from './mastery';
import * as autoChain from './auto-chain';
import * as tier0Hygiene from './tier0-hygiene';
import * as tocChain from './toc-chain';
import * as topicId from './topic-id';

/** Computes next SM-2 interval, ease factor, and repetition counters after a review */
export const processReview = sm2.processReview;
/** Computes target review due date by advancing calendar days */
export const computeDueDate = sm2.computeDueDate;

// Mastery exports
/** Standard threshold (0.70) required to consider a topic mastered */
export const MASTERY_THRESHOLD = mastery.MASTERY_THRESHOLD;
/** Calculates 4-pillar weighted topic mastery */
export const computeTopicMastery = mastery.computeTopicMastery;
/** Clamps and rounds raw assessment scores */
export const normalizeScore = mastery.normalizeScore;
/** Resolves topic mastery from pillars and optional existing value with precedence */
export const resolveTopicMastery = mastery.resolveTopicMastery;

// Dependency exports
/** Detects the lexicographically-first dependency cycle via direct search — no enumeration, bounded on any graph (#79) */
export const detectCycle = dependency.detectCycle;
/** Enumerates every distinct dependency cycle with its exact canonicalized path (#79) */
export const detectCycles = dependency.detectCycles;
/** Bounded cycle enumeration — capped sample plus truncation flag for interactive commands */
export const detectCyclesBounded = dependency.detectCyclesBounded;
/** Quarantines cyclic components so acyclic topics keep working; returns the clean subgraph, a bounded cycle sample, and a truncation flag (#79) */
export const quarantineCyclicTopics = dependency.quarantineCyclicTopics;
/** SCC-membership set of every node on at least one cycle — truncation-proof (#79) */
export const findCyclicSccNodes = dependency.findCyclicSccNodes;
export type { DetectCyclesResult } from './dependency';
/** Evaluates prerequisite satisfaction and returns ready topics (deterministically ordered by palee_id — #79) */
export const getReadyTopics = dependency.getReadyTopics;
/** Checks whether all dependencies for a topic are satisfied */
export const areDependenciesSatisfied = dependency.areDependenciesSatisfied;
/** Returns canonical dependencies from a topic node (reads `depends_on` only; legacy `dependencies` alias is not consulted — #140) */
export const getTopicDependencies = dependency.getTopicDependencies;
/** Validates dependency graph integrity and absence of cycles */
export const validateDependencyGraph = dependency.validateDependencyGraph;
/** Finds dangling dependency references without running cycle detection */
export const findMissingDependencies = dependency.findMissingDependencies;

// Auto-chain exports
/** Plans a hierarchical auto-chain over vault-relative note paths (#73) */
export const planAutoChain = autoChain.planAutoChain;
/** Plans a hierarchical auto-chain after Tier-0 hygiene filtering (PAL-205-B) */
export const planAutoChainWithHygiene = autoChain.planAutoChainWithHygiene;
/** Parses a single Obsidian wikilink string (#73) */
export const parseWikilink = autoChain.parseWikilink;
/** Extracts every well-formed wikilink from a text block, in order (#73) */
export const extractWikilinks = autoChain.extractWikilinks;
export type { NumericPrefix, ParsedWikilink, ChainPlan, HygieneChainPlan, Tier0RuleCounts } from './auto-chain';

// Tier-0 hygiene exports (PAL-205-B) — the predicate contract Work Order C rebases onto
/** Classifies one vault-relative note path as backbone, leaf, or excluded (B1-B5, B7) */
export const classifyNoteForChain = tier0Hygiene.classifyNoteForChain;
/** True when `value` is a usable `palee_id`: a non-empty string (B7) */
export const isValidPaleeId = tier0Hygiene.isValidPaleeId;
/** True when a non-final path segment names a phase directory whose subtree must not chain (B4) */
export const isPhaseSubtree = tier0Hygiene.isPhaseSubtree;
/** True when a basename is README-class, numeric-prefixed, or phase-prefixed (B5) */
export const isContentDocName = tier0Hygiene.isContentDocName;
/** Case-insensitive `.md` stem of a basename; `''` for non-markdown names */
export const stemOf = tier0Hygiene.stemOf;
/** B1 repo-meta basename blocklist (data, not law — see module docs) */
export const REPO_META_STEMS = tier0Hygiene.REPO_META_STEMS;
/** B4 phase directory names */
export const PHASE_DIR_SEGMENTS = tier0Hygiene.PHASE_DIR_SEGMENTS;
/** B5 content-doc basename prefixes */
export const CONTENT_DOC_PREFIXES = tier0Hygiene.CONTENT_DOC_PREFIXES;
/** B2 README-class basenames */
export const README_CLASS_STEMS = tier0Hygiene.README_CLASS_STEMS;
/** B2 generic document names whose locale-suffixed variants are translations */
export const GENERIC_DOC_STEMS = tier0Hygiene.GENERIC_DOC_STEMS;
/** B2 language codes OSS curricula are actually translated into */
export const TRANSLATION_LANG_CODES = tier0Hygiene.TRANSLATION_LANG_CODES;
/** B2 region aliases accepted as a trailing locale */
export const LOCALE_REGION_ALIASES = tier0Hygiene.LOCALE_REGION_ALIASES;
/** B2 short tokens excluded as locale codes to avoid programming-language collisions */
export const LOCALE_CODE_COLLISIONS = tier0Hygiene.LOCALE_CODE_COLLISIONS;
export type { Tier0Class, Tier0SkipReason, Tier0Decision } from './tier0-hygiene';

// TOC tier exports (PAL-205-C) — author-enumeration chain sources
/** Extracts inline markdown link destinations from a TOC document, in order */
export const extractTocLinks = tocChain.extractTocLinks;
/** Folds one link destination against its TOC file's directory into a vault-relative candidate */
export const foldTocDestination = tocChain.foldTocDestination;
/** Plans the linear TOC chain over resolved in-scope note paths (dedup + C1 resort) */
export const planTocChain = tocChain.planTocChain;
/** Re-verifies the strictly-backward-edge invariant of a TOC plan */
export const assertBackwardEdges = tocChain.assertBackwardEdges;
/** Re-verifies acyclicity of a merged (numbered + TOC) predecessor graph */
export const assertAcyclicPlan = tocChain.assertAcyclicPlan;
/** True when any path segment or the basename carries a numeric prefix (C2 dominance gate) */
export const isInNumberedTree = tocChain.isInNumberedTree;
/** Merges the numbered (hygiene) plan with the TOC enumeration under the selected tier */
export const composeTieredChain = tocChain.composeTieredChain;
/** Parses the `--auto-chain[=strict|toc|full]` value; `null` = reject */
export const parseAutoChainTier = tocChain.parseAutoChainTier;
export type { AutoChainTier, DependsOnSource, TocLink, TocSkipReason, TocTargetCandidate, TocChainPlan, TieredChainPlan, TieredComposition } from './toc-chain';

// Topic ID exports
/** Generates a unique topic identifier prefixed with `T-` (#29) */
export const generateTopicId = topicId.generateTopicId;


