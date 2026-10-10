/**
 * AI Subsystem - Provider Abstraction (#24)
 *
 * @remarks
 * The only place in `src/` that opens a network socket, and the seam every Phase-2
 * feature calls through. Intentionally *not* re-exported from `src/index.ts`: the
 * published library surface stays offline, so nothing that imports PALEE as a library
 * gains a code path that reaches a provider.
 */

export * from './provider';
