import type { LoadedTopic } from '../storage';

/**
 * The outcome of resolving one user-supplied topic query against a loaded vault.
 *
 * @remarks Deliberately free of console output and exit codes: each command owns
 * its own wording and JSON shape, and `assess`, `review` and `progress` differ in
 * both. Only the *choice* of topic is shared.
 */
type TopicQueryResolution =
  | { kind: 'single'; topic: LoadedTopic }
  | { kind: 'ambiguous'; candidates: LoadedTopic[] }
  | { kind: 'none' };

/**
 * Normalizes a vault-relative note path for the exact-path comparison below.
 *
 * @param value - A `LoadedTopic.path`, or a learner-supplied query
 * @returns The value with `\` folded to `/`, a leading `./` dropped, and on
 * win32 lowercased
 *
 * @remarks
 * `LoadedTopic.path` is already POSIX-separated (`relativeVaultPath` rewrites
 * every separator), so only the query side normally needs folding — a learner on
 * Windows who copies `Path: w\one.md` out of `session` output gets the same topic
 * as one typing `w/one.md`. Case is folded on win32 only, because only there is
 * the lookup itself case-insensitive; on POSIX `W/One.md` is a different file and
 * must not resolve to `w/one.md`.
 */
function normalizeTopicPath(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Resolves a topic query — a `palee_id`, a title substring, or the exact vault
 * path the CLI itself printed for a topic — to the topic the learner meant.
 *
 * @param loaded - Topics from {@link loadTopics}, in load order.
 * @param query - The raw user argument.
 * @returns The single match, every candidate when more than one matches and none
 * is exact, or `none` when nothing matches.
 *
 * @example
 * ```typescript
 * const r = resolveTopicQuery(loadTopics(vaultPath), 'T-math');
 * if (r.kind === 'single') console.log(r.topic.title);
 * ```
 */
function resolveTopicQuery(
  loaded: LoadedTopic[],
  query: string
): TopicQueryResolution {
  // An exact id wins outright: `T-math` is the learner naming a topic, and a
  // neighbour called `T-math-2` matching it by substring must not turn a
  // specific request into an ambiguity error that writes nothing — nor, under
  // the first-match-wins resolution `progress` used to do, silently report on
  // the wrong topic.
  const exact = loaded.filter((t) => t.palee_id === query);
  const candidates =
    exact.length > 0
      ? exact
      : loaded.filter(
          (t) =>
            t.palee_id.includes(query) ||
            t.title.toLowerCase().includes(query.toLowerCase())
        );

  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  if (candidates.length === 1) return { kind: 'single', topic: candidates[0] };

  // #313: `next`, `plan` and `adopt` print a topic's vault path, so the learner has
  // been handed an identifier the tool then refused. Only reached when no id or
  // title matched anything at all — an existing id/title match is never shadowed by
  // a path reading, and an exact path is unique by construction (`walkVault` visits a
  // physical note once), so this can only name the one note that is there.
  const wanted = normalizeTopicPath(query);
  const byPath = loaded.filter((t) => normalizeTopicPath(t.path) === wanted);
  if (byPath.length === 0) return { kind: 'none' };
  if (byPath.length > 1) return { kind: 'ambiguous', candidates: byPath };
  return { kind: 'single', topic: byPath[0] };
}

export { resolveTopicQuery };
export type { TopicQueryResolution };
