import path from 'path';

/**
 * Converts a glob/wildcard pattern into a RegExp.
 * Supports:
 * - `*` (matches anything except path separator `/`)
 * - `**` (matches across directory boundaries)
 * - `**\/` prefix (matches root-level files and nested directories, e.g. `**\/*.md` matches `README.md` and `a/b/c.md`)
 * - `\/**\/` infix (matches zero or more intermediate directories, e.g. `a/**\/b.md` matches `a/b.md` and `a/x/y/b.md`)
 * - `\/**` suffix (matches directory descendants and self, e.g. `MODULES/**` matches `MODULES/a.md` and `MODULES/a/b.md`)
 * - `?` (matches a single character except `/`)
 * - `[0-9]`, `[a-z]`, `[abc]` (character classes)
 * - `[!0-9]` or `[^0-9]` (negated character classes)
 */
export function globToRegex(glob: string): RegExp {
  const trimmed = glob.trim().replace(/\\/g, '/');
  if (!trimmed) {
    return /^$/i;
  }

  let regexStr = '';
  let inGroup = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const next = trimmed[i + 1];
    const next2 = trimmed[i + 2];

    // Handle character classes `[...]`
    if (char === '[' && !inGroup) {
      const closeIdx = trimmed.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        inGroup = true;
        regexStr += '[';
        // Translate glob negation `[!...]` to regex negation `[^...]`
        if (next === '!') {
          regexStr += '^';
          i++; // skip '!'
        }
        continue;
      } else {
        // Unclosed '[', escape safely to avoid SyntaxError
        regexStr += '\\[';
        continue;
      }
    }

    if (char === ']' && inGroup) {
      inGroup = false;
      regexStr += ']';
      continue;
    }

    // Inside character class: treat *, ?, +, ., etc. as literals
    if (inGroup) {
      if (char === '\\') {
        regexStr += '\\\\';
      } else if (char === '/' || char === '^' || char === '$') {
        regexStr += `\\${char}`;
      } else {
        regexStr += char;
      }
      continue;
    }

    // Handle `**/` at start of pattern (e.g. `**/*.md`)
    if (i === 0 && char === '*' && next === '*' && next2 === '/') {
      regexStr += '(?:.*/)?';
      i += 2; // skip '*', '*' and '/'
      continue;
    }

    // Handle `/**/` in middle of pattern (e.g. `dir/**/file.md`)
    if (char === '/' && next === '*' && next2 === '*' && trimmed[i + 3] === '/') {
      regexStr += '/(?:.*/)?';
      i += 3; // skip '/', '*', '*' and '/'
      continue;
    }

    // Handle `/**` at end of pattern (e.g. `dir/**`)
    if (char === '/' && next === '*' && next2 === '*' && i + 3 === trimmed.length) {
      regexStr += '(?:/.*)?';
      i += 2; // skip '/', '*' and '*'
      continue;
    }

    // Handle standalone `**`
    if (char === '*' && next === '*') {
      regexStr += '.*';
      i++; // skip next '*'
      continue;
    }

    // Handle single `*` (matches non-slash characters)
    if (char === '*') {
      regexStr += '[^/]*';
      continue;
    }

    // Handle single `?` (matches non-slash character)
    if (char === '?') {
      regexStr += '[^/]';
      continue;
    }

    // Escape regex special characters
    if (['.', '+', '^', '$', '(', ')', '{', '}', '|', '\\'].includes(char)) {
      regexStr += `\\${char}`;
    } else {
      regexStr += char;
    }
  }

  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Checks if a file path or its basename matches any of the given glob patterns.
 * Patterns can be an array of strings or a single comma-separated string.
 */
export function matchesPattern(filePath: string, patterns: string | string[]): boolean {
  const patternList = Array.isArray(patterns)
    ? patterns
    : patterns.split(',').map((p) => p.trim()).filter(Boolean);

  if (patternList.length === 0) {
    return false;
  }

  // Normalize path separators and strip leading relative prefix
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = path.posix.basename(normalizedPath);

  for (const pattern of patternList) {
    const trimmedPattern = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!trimmedPattern) continue;

    const regex = globToRegex(trimmedPattern);

    // Full path matching (matches path-scoped and deep glob patterns)
    if (regex.test(normalizedPath)) {
      return true;
    }

    // Basename matching: allowed when pattern is a pure filename pattern (no '/')
    if (!trimmedPattern.includes('/') && regex.test(basename)) {
      return true;
    }

    // Segment & prefix matching for non-wildcard patterns (avoids false-positive substring collisions)
    if (!trimmedPattern.includes('*') && !trimmedPattern.includes('?')) {
      const lowerPath = normalizedPath.toLowerCase();
      const lowerPattern = trimmedPattern.toLowerCase();
      const lowerBasename = basename.toLowerCase();

      if (
        lowerPath === lowerPattern ||
        lowerBasename === lowerPattern ||
        lowerPath.startsWith(`${lowerPattern}/`) ||
        lowerPath.endsWith(`/${lowerPattern}`) ||
        lowerPath.includes(`/${lowerPattern}/`)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Normalizes frontmatter tags from a note into a clean string array.
 * Strips leading '#' and normalizes to lowercase.
 */
export function extractTags(rawTags: unknown): string[] {
  if (!rawTags) return [];

  const normalize = (t: unknown): string =>
    String(t)
      .trim()
      .replace(/^#+/, '')
      .toLowerCase();

  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((t) => t != null)
      .map(normalize)
      .filter(Boolean);
  }

  if (typeof rawTags === 'string') {
    return rawTags
      .split(/[,\s]+/)
      .map(normalize)
      .filter(Boolean);
  }

  return [];
}

/**
 * Checks if a note's frontmatter tags match any of the requested target tags.
 * Target tags can be comma-separated or an array.
 * Supports:
 * - Exact match: target "type/concept" matches "type/concept"
 * - Hierarchical prefix: target "type" matches "type/concept"
 * - Hierarchical suffix: target "concept" matches "type/concept"
 * - Hierarchical infix: target "security" matches "domain/security/crypto"
 * - '#' normalization on both note tags and target tags
 */
export function matchesTags(noteTags: unknown, targetTags: string | string[]): boolean {
  const normalize = (t: string): string =>
    t.trim().replace(/^#+/, '').toLowerCase();

  const targets = Array.isArray(targetTags)
    ? targetTags.map(normalize).filter(Boolean)
    : targetTags
        .split(',')
        .map(normalize)
        .filter(Boolean);

  if (targets.length === 0) {
    return false;
  }

  const tags = extractTags(noteTags);
  if (tags.length === 0) {
    return false;
  }

  for (const target of targets) {
    for (const tag of tags) {
      if (
        tag === target ||
        tag.startsWith(`${target}/`) ||
        tag.endsWith(`/${target}`) ||
        tag.includes(`/${target}/`)
      ) {
        return true;
      }
    }
  }

  return false;
}
