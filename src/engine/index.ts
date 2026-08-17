/**
 * Engine Core - Public API
 * Exports SM-2, mastery, and dependency graph engines
 */

import * as sm2 from './sm2';
import * as dependency from './dependency';
import * as mastery from './mastery';

export const processReview = sm2.processReview;
export const computeDueDate = sm2.computeDueDate;

// Mastery exports
export const MASTERY_THRESHOLD = mastery.MASTERY_THRESHOLD;
export const computeTopicMastery = mastery.computeTopicMastery;

// Dependency exports
export const detectCycle = dependency.detectCycle;
export const getReadyTopics = dependency.getReadyTopics;
export const validateDependencyGraph = dependency.validateDependencyGraph;

