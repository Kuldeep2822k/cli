/**
 * Engine Core - Public API
 * Exports SM-2, mastery, and dependency graph engines
 */

import * as sm2 from './sm2';
import * as mastery from './mastery';
import * as dependency from './dependency';

export const processReview = sm2.processReview;
export const computeDueDate = sm2.computeDueDate;
export const calculateEaseFactorDelta = sm2.calculateEaseFactorDelta;

// Mastery exports
export const computeMastery = mastery.computeMastery;
export const isAnomalousAssessment = mastery.isAnomalousAssessment;
export const validateScore = mastery.validateScore;

// Dependency exports
export const topologicalSort = dependency.topologicalSort;
export const detectCycle = dependency.detectCycle;
export const areDependenciesSatisfied = dependency.areDependenciesSatisfied;
export const getReadyTopics = dependency.getReadyTopics;
export const validateDependencyGraph = dependency.validateDependencyGraph;
