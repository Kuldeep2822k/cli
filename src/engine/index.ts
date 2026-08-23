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

// Dependency exports
/** Detects cyclic prerequisite loops in the topic graph */
export const detectCycle = dependency.detectCycle;
/** Evaluates prerequisite satisfaction and returns ready topics */
export const getReadyTopics = dependency.getReadyTopics;
/** Validates dependency graph integrity and absence of cycles */
export const validateDependencyGraph = dependency.validateDependencyGraph;

