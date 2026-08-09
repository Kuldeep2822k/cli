/**
 * Mastery Calculation Engine
 * Computes topic mastery from assessment dimensions
 */
import { Assessment } from '../types';

function roundHalfUp(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier + 1e-10) / multiplier;
}

function validateScore(score: unknown, name: string): asserts score is number {
  if (typeof score !== 'number') {
    throw new Error(`${name} must be a number, got ${typeof score}`);
  }
  if (score < 0.0 || score > 1.0) {
    throw new Error(`${name} must be between 0.0 and 1.0, got ${score}`);
  }
}

function computeMastery(assessment: Partial<Assessment>): number {
  const { conceptual = 0, practical = 0, debug = 0, feynman = 0 } = assessment;

  // Validate all scores
  validateScore(conceptual, 'conceptual');
  validateScore(practical, 'practical');
  validateScore(debug, 'debug');
  validateScore(feynman, 'feynman');

  // Feynman-weighted formula: (c + p + d + feynman*2) / 5
  const mastery = (conceptual + practical + debug + feynman * 2) / 5;

  return roundHalfUp(mastery, 4);
}

function isAnomalousAssessment(current: Partial<Assessment>, previous: Partial<Assessment> | null): boolean {
  // First assessments are never anomalous, or missing timestamps
  if (!previous || !previous.assessed_at || !current.assessed_at) {
    return false;
  }

  // All previous scores must be > 0.10 (established topic)
  const prevScores = [
    previous.conceptual || 0,
    previous.practical || 0,
    previous.debug || 0,
    previous.feynman || 0,
  ];

  if (prevScores.some(s => s <= 0.10)) {
    return false;
  }

  // Check time window: within 10 minutes (600 seconds)
  const prevTime = new Date(previous.assessed_at).getTime();
  const currTime = new Date(current.assessed_at as string).getTime();
  const deltaSec = Math.abs((currTime - prevTime) / 1000);

  if (deltaSec >= 600) {
    return false;
  }

  // Check individual score deltas
  const conceptualDelta = Math.abs((current.conceptual || 0) - (previous.conceptual || 0));
  const practicalDelta = Math.abs((current.practical || 0) - (previous.practical || 0));
  const debugDelta = Math.abs((current.debug || 0) - (previous.debug || 0));
  const feynmanDelta = Math.abs((current.feynman || 0) - (previous.feynman || 0));

  const hasLargeIndividual =
    conceptualDelta > 0.40 ||
    practicalDelta > 0.40 ||
    debugDelta > 0.40 ||
    feynmanDelta > 0.40;

  // Check aggregate mastery delta
  const prevMastery = computeMastery(previous);
  const currMastery = computeMastery(current);
  const masteryDelta = Math.abs(currMastery - prevMastery);

  const hasLargeAggregate = masteryDelta > 0.35;

  return hasLargeIndividual || hasLargeAggregate;
}

export {
  computeMastery,
  isAnomalousAssessment,
  validateScore,
  roundHalfUp,
};
