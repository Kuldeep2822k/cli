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
 * Resolves a topic query — a `palee_id` or a title substring — to the topic the
 * learner meant.
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

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'single', topic: candidates[0] };
}

export { resolveTopicQuery };
export type { TopicQueryResolution };
