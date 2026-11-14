/**
 * The topic scaffold: the SM-2 review state a never-reviewed topic carries, and
 * the frontmatter keys PALEE owns on a topic note (P3-10 of audit issue #565).
 *
 * @remarks
 * Two facts about a topic note previously lived as hand-kept copies spread over
 * four files, and this module is their single source:
 *
 * 1. **The topic scaffold** — the seven SM-2 scheduling keys (`ease_factor`,
 *    `interval_days`, `repetition`, `lapses`, `last_quality`, `last_reviewed_at`,
 *    `due_at`) and the values a never-reviewed topic carries. {@link buildTopicScaffold}
 *    builds it. `adopt` writes it fresh on both adoption paths (single-file and
 *    batch); the roadmap import preserves what the note at the target path already
 *    carries and defaults only what is absent; `validate --fix` resets corrupted
 *    review fields to the same shape (the numeric subset — the date keys belong to
 *    `valid-review-dates`). Before P3-10 those three writers each spelled the values
 *    out (`src/cli/adopt.ts` twice, `src/cli/roadmap.ts`,
 *    `src/validation/rules/valid-review-fields.ts`), so a changed SM-2 default had
 *    to be edited in four places and adoption, import and repair could disagree.
 *
 * 2. **The owned-key set** — {@link PALEE_OWNED_KEYS}, the frontmatter keys
 *    `adopt --undo` strips. It is the list ADR-0022 means by "a single
 *    `PALEE_OWNED_KEYS` list drives the strip". Its SM-2 middle is derived from
 *    the scaffold builder's own key order and its pillar middle is spliced in from
 *    the engine's `PILLAR_KEYS` (`src/engine/mastery.ts`, P3-09), so the strip list
 *    can never drift from what adoption actually writes: add a scaffold key and the
 *    reversal takes it; add a pillar and the reversal takes it.
 *
 * What the owned set deliberately omits — `title`, and the un-owned alias keys —
 * is adoption's own non-destructiveness contract (#299): reversal must restore only
 * what adoption added, so a note the learner later hand-annotated keeps those
 * byte-for-byte. `title` is adoption-written but not owned: it is a key Obsidian
 * authors write by hand, adoption preserves the note's own value when it has one,
 * and reversal cannot tell a minted title from an authored one — `--drop-title`
 * hands that judgement back to the learner, exactly as `migrate --relabel-ties`
 * refuses to guess.
 *
 * The SM-2 scheduling keys ARE adoption-written scaffolding, so `--undo` removes
 * them to restore the pre-adoption note. A note reviewed since adoption therefore
 * loses that accumulated review state on undo — that is intrinsic to reversing the
 * adoption, not a leak of a key PALEE did not own; `--undo --dry-run` previews
 * exactly what will go first.
 *
 * This module sits in the engine because the scaffold is engine material — it is
 * the SM-2 initial state, the same defaults `processReview` reads a missing field
 * as — and every consumer (CLI, validation) imports the engine downward. It owns
 * no filesystem, no timestamps and no policy: callers decide when and where the
 * values land.
 */

import { PILLAR_KEYS } from './mastery';

/**
 * The frontmatter keys that make up the topic scaffold, in the order `adopt.ts`
 * writes them (the flat topic note order).
 */
export type TopicScaffoldKey =
  | 'ease_factor'
  | 'interval_days'
  | 'repetition'
  | 'lapses'
  | 'last_quality'
  | 'last_reviewed_at'
  | 'due_at';

/** The scaffold record: each scaffold key mapped to the value that is written. */
export type TopicScaffold = Record<TopicScaffoldKey, unknown>;

/**
 * Builds the SM-2 review state a never-reviewed topic carries.
 *
 * @param existing - Raw frontmatter to preserve from, or omitted for the fresh
 *   scaffold
 * @returns The seven scaffold keys in the documented order, each carrying either
 *   the existing value (verbatim, untrusted) or the scaffold default
 *
 * @remarks
 * One builder for every writer of the never-reviewed state:
 *
 * - **No argument** — the fresh scaffold adoption writes onto a note it adopts:
 *   `ease_factor 2.5`, `interval_days 1`, `repetition 0`, `lapses 0`, and
 *   `null` for `last_quality`, `last_reviewed_at` and `due_at` (never reviewed).
 * - **With `existing`** — the preserve-else-default map the roadmap import writes
 *   for the topic at the target path: a key the note already carries passes
 *   through exactly as stored (the value is untrusted raw frontmatter — the
 *   validators, not a cast, refuse garbage), while an absent *or null* key falls
 *   to the scaffold default, matching the `??` semantics the import has always
 *   used. Values are typed `unknown` for that reason: this function forwards, it
 *   does not normalize.
 *
 * @example
 * ```typescript
 * buildTopicScaffold();
 * // { ease_factor: 2.5, interval_days: 1, repetition: 0, lapses: 0,
 * //   last_quality: null, last_reviewed_at: null, due_at: null }
 * buildTopicScaffold({ ease_factor: 1.8, interval_days: 6 });
 * // { ease_factor: 1.8, interval_days: 6, repetition: 0, lapses: 0,
 * //   last_quality: null, last_reviewed_at: null, due_at: null }
 * ```
 */
export function buildTopicScaffold(existing?: Record<string, unknown>): TopicScaffold {
  return {
    ease_factor: existing?.ease_factor ?? 2.5,
    interval_days: existing?.interval_days ?? 1,
    repetition: existing?.repetition ?? 0,
    lapses: existing?.lapses ?? 0,
    last_quality: existing?.last_quality ?? null,
    last_reviewed_at: existing?.last_reviewed_at ?? null,
    due_at: existing?.due_at ?? null,
  };
}

/**
 * The frontmatter keys `adopt --undo` removes, in the order `adopt.ts` writes
 * them — the single owned-key set (P3-10 of audit issue #565).
 *
 * @remarks
 * This set is read off the code, not off the prose. The entries are exactly what
 * the two adoption paths in `src/cli/adopt.ts` hand to `updateFrontmatter`
 * (`palee_id`, `palee_schema`, `difficulty`, `depends_on`, `topic_mastery`,
 * `assessed_at`, the four pillars, the SM-2 scaffold, `depends_on_source`), which
 * is also the order documented for the flat topic note. `depends_on_source` is
 * the provenance label adoption writes whenever it lays an edge and
 * `migrate --relabel-ties` rewrites. Keys adoption never writes — `topic`,
 * `track`, `status`, `dependencies`, `assessment`, `review` — are deliberately
 * NOT on this list: reversal must restore only what adoption added, so a note the
 * learner later hand-annotated with any of those keeps them byte-for-byte (#299).
 *
 * Two middles are derived rather than retyped, so neither can drift from its
 * writer: the four pillar names come from the engine's `PILLAR_KEYS`
 * (`src/engine/mastery.ts`, P3-09) and the seven SM-2 scheduling keys come from
 * {@link buildTopicScaffold}'s own key order — the same builder both adoption
 * paths write with. See the module documentation for why `title` is absent and
 * why removing the scheduling keys is correct even for a note reviewed since
 * adoption.
 */
export const PALEE_OWNED_KEYS: readonly string[] = [
  'palee_id',
  'palee_schema',
  'difficulty',
  'depends_on',
  'topic_mastery',
  'assessed_at',
  ...PILLAR_KEYS,
  ...Object.keys(buildTopicScaffold()),
  'depends_on_source',
];
