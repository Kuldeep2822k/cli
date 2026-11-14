/**
 * The one spelling of an affirmative environment flag.
 *
 * @remarks
 * Two call sites grew the same `1`/`true` test 700 lines apart — the Windows
 * config-dir guard (#565 P2-05) and `PALEE_JSON` (#357) — and they already
 * disagreed about whitespace. One predicate now owns the spelling. The trim
 * difference stays explicit because widening `PALEE_JSON` to accept `' true '`
 * would change a documented contract rather than deduplicate it.
 */

/**
 * Decides whether an environment value means "on".
 *
 * @param value - The raw environment value
 * @param options - `trim` ignores surrounding whitespace; omitted, only the
 *   exact spellings match, which is the `PALEE_JSON` contract
 * @returns `true` only for `1` and `true`, compared case-insensitively
 */
export function isAffirmativeEnvFlag(
  value: string | undefined,
  options: { trim?: boolean } = {}
): boolean {
  const raw = options.trim === true ? value?.trim() : value;
  const normalized = raw?.toLowerCase();
  return normalized === '1' || normalized === 'true';
}
