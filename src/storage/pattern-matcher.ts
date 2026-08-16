import path from 'path';

/**
 * Converts a simple glob/wildcard pattern into a RegExp.
 * Supports:
 * - `*` (matches anything except path separator)
 * - `**` (matches across directories)
 * - `?` (matches a single character)
 * - `[0-9]` or `[abc]` (character classes)
 */
function globToRegex(glob: string): RegExp {
  const trimmed = glob.trim();
  let regexStr = '';
  let inGroup = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const next = trimmed[i + 1];

    if (char === '*' && next === '*') {
      regexStr += '.*';
      i++; // skip next *
    } else if (char === '*') {
      regexStr += '[^/]*';
    } else if (char === '?') {
      regexStr += '[^/]';
    } else if (char === '[') {
      inGroup = true;
      regexStr += '[';
    } else if (char === ']' && inGroup) {
      inGroup = false;
      regexStr += ']';
    } else if (['.', '+', '^', '$', '(', ')', '{', '}', '|', '\\'].includes(char)) {
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

  const normalizedPath = filePath.replace(/\\/g, '/');
  const basename = path.basename(filePath);

  for (const pattern of patternList) {
    const regex = globToRegex(pattern);
    // Match against full normalized path or simple basename
    if (regex.test(normalizedPath) || regex.test(basename)) {
      return true;
    }
    // Also match if pattern is a substring pattern without wildcards
    if (!pattern.includes('*') && !pattern.includes('?')) {
      if (normalizedPath.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Normalizes frontmatter tags from a note into a string array.
 */
export function extractTags(rawTags: unknown): string[] {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) {
    return rawTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof rawTags === 'string') {
    return rawTags
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * Checks if a note's frontmatter tags match any of the requested target tags.
 * Target tags can be comma-separated or an array.
 * Supports exact match and hierarchical matching (e.g. target "concept" matches "type/concept").
 */
export function matchesTags(noteTags: unknown, targetTags: string | string[]): boolean {
  const targets = Array.isArray(targetTags)
    ? targetTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
    : targetTags
        .split(',')
        .map((t) => t.trim().toLowerCase())
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
      if (tag === target || tag.endsWith(`/${target}`) || tag.startsWith(`${target}/`)) {
        return true;
      }
    }
  }

  return false;
}
