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
/** Detects the first cyclic prerequisite loop in the topic graph (compatibility wrapper over detectCycles) */
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


