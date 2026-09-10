/**
 * Topic ID Policy
 *
 * @remarks
 * Single source of truth for the shape of a valid PALEE topic ID
 * (`palee_id`). The policy: `T-` prefix followed by one or more
 * lowercase alphanumeric kebab segments — e.g. `T-git-rebase`,
 * `T-20260830T120000-a1b2c3d4` (the format `adopt` generates).
 * Roadmap imports, adoption, and validation all defer to this module so
 * they can never disagree (#29).
 */

/** Supported note-format version for `palee_schema` (Phase 1 supports only 1). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Allowed topic lifecycle statuses. */
export const ALLOWED_TOPIC_STATUSES = ['not_started', 'learning', 'paused', 'archived'] as const;

/**
 * Pattern a valid topic ID must match: `T-` plus kebab-case segments of
 * lowercase letters and digits — e.g. `T-git-rebase`,
 * `T-20260830-120000-a1b2c3d4` (the format `adopt` generates).
 */
const TOPIC_ID_PATTERN = /^T-[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Legacy adopt format (pre-#29): `T-<ISO timestamp with uppercase T>-<hex8>`.
 * Tool-generated historical IDs stay valid — validation reports defects in
 * user data, not PALEE's own past output; migration may rewrite them.
 */
const LEGACY_ADOPT_ID_PATTERN = /^T-\d{8}T\d{6}-[a-f0-9]{8}$/;

/**
 * Tests whether a value is a validly shaped topic ID.
 *
 * @param value - Candidate ID (usually raw frontmatter `palee_id`)
 * @returns True when the value matches the canonical policy or the exact
 * legacy adopt-generated format
 *
 * @example
 * ```typescript
 * isValidTopicId('T-git-rebase');               // true
 * isValidTopicId('T-20260830-120000-a1b2c3d4'); // true (adopt's format)
 * isValidTopicId('T-20260830T120000-a1b2c3d4'); // true (legacy adopt format)
 * isValidTopicId('git_rebase');                // false (no prefix, underscore)
 * isValidTopicId('T-');                        // false (empty slug)
 * ```
 */
function isValidTopicId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return TOPIC_ID_PATTERN.test(value) || LEGACY_ADOPT_ID_PATTERN.test(value);
}

export { isValidTopicId };
