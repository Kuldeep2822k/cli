/**
 * Normalizes dependency aliases into the canonical `depends_on` representation.
 *
 * @param rawDependsOn - Raw canonical dependency field
 * @param rawDependencies - Raw legacy dependency field
 * @returns Deduplicated dependency identifiers in first-seen order
 */
export function normalizeDependencies(
  rawDependsOn?: unknown,
  rawDependencies?: unknown
): string[] {
  function extract(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((dependency) => dependency != null)
        .map((dependency) => String(dependency).trim())
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.split(',').map((dependency) => dependency.trim()).filter(Boolean);
    }
    return [];
  }

  return Array.from(new Set([
    ...extract(rawDependsOn),
    ...extract(rawDependencies),
  ]));
}
