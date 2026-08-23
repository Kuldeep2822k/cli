/**
 * PALEE (Personal Adaptive Learning Environment Engine)
 *
 * @remarks
 * A smart, AI-powered study tracker that optimizes learning with spaced repetition (SuperMemo SM-2)
 * and dependency-aware recommendations for markdown-based knowledge bases (Obsidian).
 *
 * @packageDocumentation
 */

import pkg from '../package.json';

/** Library package semantic version */
export const version: string = pkg.version;

// Export all domain types and schemas
export * from './types';

// Export Engine Subsystem
export * from './engine';

// Export Storage Subsystem
export * from './storage';

