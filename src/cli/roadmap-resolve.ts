/**
 * Roadmap Field Resolution — the #139 Single Source of Truth
 *
 * @remarks
 * The field-derivation phase of `palee roadmap --from`, extracted from the
 * handler in `src/cli/roadmap.ts` by the P3-14 phase split (#565).
 * {@link resolveTopicUpdates} is the single derivation of the effective
 * frontmatter values an import writes for one topic: the validation pass and
 * the writeback both consume it, so the rules cannot diverge between the
 * graph check and the bytes that land. {@link declaredIdOfNote} is the
 * direct question a note is asked about its own identity, without the
 * loader's filters.
 */

import fs from 'fs';
import { parseFrontmatter } from '../storage';
import { noteExceedsReadCap, oversizedNoteDiagnostic } from '../storage/source-cap';
import { buildTopicScaffold } from '../engine/topic-scaffold';
import { ResolvedTopicUpdates } from '../types';

/**
 * Effective-input bundle for one roadmap topic, used by `resolveTopicUpdates`.
 *
 * @remarks
 * "Existing" identity is two-keyed on purpose (#137 follow-up): `depends_on`'s
 * preserve-existing rule looks the topic up BY `palee_id` (the roadmap topic may
 * not exist on disk yet, so its pre-import identity is its future ID), while
 * frontmatter pass-through fields come from the note AT THE TARGET PATH (the
 * file the import will actually write).
 */
export interface ResolveTopicInput {
  /** Roadmap-declared topic */
  topic: RoadmapTopicAlias;
  /** Existing vault topic with the same `palee_id` (for depends_on preservation), or undefined */
  existingById: LoadedTopicAlias | undefined;
  /** Raw frontmatter of the note at the target path, or `{}` for new notes */
  existingAtPath: Record<string, unknown>;
}

type RoadmapTopicAlias = import('../types').RoadmapTopic;
type LoadedTopicAlias = { id: string; depends_on?: string[] };

/**
 * The `palee_id` a note declares on disk, read without the loader's filters.
 *
 * @param absolutePath - Canonical path of the note a roadmap entry targets
 * @returns `absent` when nothing declares an identity, `unreadable` when the
 * frontmatter block will not parse, or the value exactly as stored
 *
 * @remarks
 * `loadTopics` requires a non-empty string `palee_id` by design (B7), so a note
 * whose id YAML read as a number leaves no incumbent in that scan — and an import
 * keyed on the scan would overwrite a declared identity anyway, the same silent
 * rename the wikilink path refuses. The note has to be asked directly.
 */
export function declaredIdOfNote(absolutePath: string):
  { kind: 'absent' } | { kind: 'unreadable'; reason: string } | { kind: 'declared'; raw: unknown } {
  let content: string;
  try {
    // #565 P1-10: this pre-read has no cap of its own, and it is the first thing the
    // import asks a note. Refusing an oversized file here costs one `stat` and keeps the
    // answer the same shape a note with broken frontmatter already produces.
    const { size } = fs.statSync(absolutePath);
    if (noteExceedsReadCap(size)) return { kind: 'unreadable', reason: oversizedNoteDiagnostic(size) };
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return { kind: 'absent' }; // no note yet: this entry adopts rather than overwrites
  }
  const { frontmatter, error } = parseFrontmatter(content);
  if (error !== undefined) {
    return { kind: 'unreadable', reason: error };
  }
  const raw = frontmatter?.palee_id;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { kind: 'absent' };
  }
  return { kind: 'declared', raw };
}

/**
 * Single derivation of the effective frontmatter values a roadmap import
 * writes for one topic (#139).
 *
 * @remarks
 * SINGLE SOURCE OF TRUTH for both passes: `roadmapCommand`'s validation pass
 * (graph + field checks) AND `doImport`'s writeback both consume this helper.
 * Never re-derive an import field at a call site — any new field added to the
 * roadmap import path must be added HERE (and to `ResolvedTopicUpdates`), or
 * the validation-vs-writeback divergence pattern returns (the class of bug that
 * produced the #137 cycle-on-import defect).
 *
 * This function is PURE: it derives from the inputs it is given. The writeback
 * pass calls it with the FRESH at-path frontmatter re-read just before the
 * atomic write (OCC requires re-reading the target at write time), while the
 * validation pass calls it earlier with the pre-import snapshot. Same rules,
 * fresh data per pass — the divergence being removed is in the RULES, not in
 * when the data is read.
 *
 * `depends_on` semantics (unchanged since #137): explicit `[]` clears,
 * omitted preserves the existing topic's deps (by ID), populated replaces.
 *
 * A pillar score the note does not carry resolves to `undefined` rather than
 * `0.0`: `doImport` drops `undefined` keys so the import cannot mint assessment
 * data, which is the precondition `valid-topic-mastery` (#37) skips on (#191).
 *
 * The SM-2 review block is not spelled out here: the seven scheduling keys come
 * from the engine's `buildTopicScaffold(existingAtPath)` (P3-10) — a key the note
 * carries passes through verbatim, an absent or null key gets the adoption
 * scaffold default — the same defaults adoption writes and `validate --fix`
 * resets to.
 *
 * @param input - Roadmap topic plus its existing on-disk context
 * @returns Effective values for every frontmatter field the import writes;
 * `undefined` for a field that must be left unwritten
 */
export function resolveTopicUpdates(input: ResolveTopicInput): ResolvedTopicUpdates {
  const { topic, existingById, existingAtPath } = input;

  return {
    palee_id: topic.id,
    palee_schema: existingAtPath.palee_schema ?? 1,
    title: topic.title,
    difficulty: topic.difficulty || existingAtPath.difficulty || 'intermediate',
    depends_on: topic.depends_on ?? existingById?.depends_on ?? [],
    topic_mastery: existingAtPath.topic_mastery ?? 0.0,
    assessed_at: existingAtPath.assessed_at ?? null,
    conceptual: existingAtPath.conceptual,
    practical: existingAtPath.practical,
    debug: existingAtPath.debug,
    feynman: existingAtPath.feynman,
    // Spread at this position so the written key order is unchanged (P3-10).
    ...buildTopicScaffold(existingAtPath),
  };
}
