/**
 * Shared managed-note eligibility (#324)
 *
 * @remarks
 * Three validation rules each ask "is this note a PALEE-managed record?" and
 * one of them asks the narrower "is this a managed TOPIC note?". Before #324
 * each rule re-declared its own key set (`MANAGED_KEYS`, `IDENTITY_KEYS`,
 * `NON_TOPIC_KEYS`), so a single note could be judged three contradictory
 * ways. This module is the ONE definition all three rules consume so they can
 * never disagree about what is managed and what is a topic.
 *
 * Marking policy is the IDENTITY KEY, not the schema marker:
 * - `palee_schema` means "PALEE wrote something here" — it marks a note as
 *   touched, but says nothing about WHICH kind it is.
 * - `palee_id` / `session_id` / `memory_id` (or `type: "session_index"`)
 *   carry the kind: a topic, a session, hot memory, the derived index.
 *
 * Eligibility keys on key PRESENCE, regardless of value type: malformed
 * identity data (`palee_id: 123`, `palee_id: null`) is still PALEE's data and
 * must stay in scope, never bypass validation as "just a user note".
 *
 * Deliberate #324 decision on a `palee_schema`-only note (no identity key):
 * - It is NOT a topic note for the ID-format rule (`isTopicNote` is false),
 *   so it no longer raises the false-positive error that failed the vault at
 *   exit 3. There is no identity to judge as a malformed topic ID.
 * - It IS still classified by the kind rule, which keeps its own broader
 *   "declared `palee_schema`" scope gate on purpose: a note PALEE touched but
 *   cannot classify is exactly what #27 warns about. The kind rule is the one
 *   place `palee_schema` alone counts as managed, and it surfaces the note
 *   once, as a warning — never a silent pass and never a fatal error.
 */

/**
 * Identity keys that mark a note as PALEE-managed, one per managed kind:
 * `palee_id` (topic), `session_id` (session), `memory_id` (hot memory).
 * Presence of a key — not its value type — marks the note.
 */
export const PALEE_IDENTITY_KEYS = ['palee_id', 'session_id', 'memory_id'] as const;

/** The topic identity key: a topic note is the only managed kind that carries it. */
export const TOPIC_IDENTITY_KEY = 'palee_id';

/** Index marker value identifying the derived session index note (`.palee/index.md`). */
export const SESSION_INDEX_TYPE = 'session_index';

/**
 * Returns the managed identity keys a note declares, by presence and ignoring
 * value type. An empty array means the note carries no identity of any kind.
 */
export function presentIdentityKeys(fm: Record<string, unknown>): string[] {
  return PALEE_IDENTITY_KEYS.filter((key) => Object.hasOwn(fm, key));
}

/** True when the note carries the derived session-index marker. */
export function hasSessionIndexMarker(fm: Record<string, unknown>): boolean {
  return fm.type === SESSION_INDEX_TYPE;
}

/**
 * True when a note is PALEE-managed at all: it declares an identity key or
 * the session-index marker. Non-managed notes are user-owned data and are
 * never reported by the managed/schema rules.
 */
export function isManagedNote(fm: Record<string, unknown>): boolean {
  return presentIdentityKeys(fm).length > 0 || hasSessionIndexMarker(fm);
}

/**
 * True when a note is a managed TOPIC note — the narrower gate for the topic
 * ID policy. It carries exactly one identity key, that key is `palee_id`, and
 * it is not the session index.
 *
 * @remarks
 * A `palee_schema`-only note is NOT a topic note (there is no identity to
 * judge), which is the #324 false-positive removal. A note carrying a
 * conflicting kind (`palee_id` + `session_id`, or an identity plus the index
 * marker) is NOT a clean topic note either — that ambiguity is the kind rule's
 * warning, not the ID rule's error, so the two rules cannot double-report it.
 */
export function isTopicNote(fm: Record<string, unknown>): boolean {
  const identities = presentIdentityKeys(fm);
  return (
    identities.length === 1 &&
    identities[0] === TOPIC_IDENTITY_KEY &&
    !hasSessionIndexMarker(fm)
  );
}
