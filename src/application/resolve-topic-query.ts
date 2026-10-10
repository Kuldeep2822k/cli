/**
 * Topic-query matching shared by `review`, `progress`, and `assess`. Pure: no
 * Commander, no process, no I/O.
 */

/**
 * Whether a topic matches a free-text query: an exact id, an id substring, or a
 * case-insensitive title substring. Callers layer their own resolution policy on
 * top (e.g. error on ambiguity, take the first match, or prefer an exact id).
 */
export function matchesTopicQuery(id: string, title: string, query: string): boolean {
  return (
    id === query ||
    id.includes(query) ||
    title.toLowerCase().includes(query.toLowerCase())
  );
}
