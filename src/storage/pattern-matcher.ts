/**
 * Pattern & Tag Matcher
 *
 * @remarks
 * Provides glob pattern compilation, path filtering, frontmatter tag extraction,
 * and hierarchical tag matching for CLI filters (`--include`, `--exclude`, `--tag`).
 */

import path from 'path';
import { foldIdentity } from './vault-walker';

/**
 * Converts a glob wildcard pattern into an equivalent RegExp.
 *
 * @remarks
 * Supported glob constructs:
 * - `*`: Matches any characters within a single path segment (excludes `/`).
 * - `**`: Matches across directory boundaries.
 * - `**\/` prefix: Matches root-level files and nested directory trees (e.g. `**\/*.md` matches `root.md` and `a/b/c.md`).
 * - `\/**\/` infix: Matches zero or more intermediate directories (e.g. `a/**\/b.md`).
 * - `\/**` suffix: Matches directory descendants and directory itself (e.g. `MODULES/**`).
 * - `?`: Matches a single character except `/`.
 * - `[0-9]`, `[a-z]`, `[abc]`: Character sets and ranges.
 * - `[!0-9]` or `[^0-9]`: Negated character classes.
 *
 * @param glob - Raw glob pattern string
 * @returns Compiled RegExp with case-insensitive flag (`i`)
 *
 * @example
 * ```typescript
 * const re = globToRegex('notes/**\/*.md');
 * re.test('notes/math/linear-algebra.md'); // true
 * ```
 */
export function globToRegex(glob: string): RegExp {
  let trimmed = glob.trim().replace(/\\/g, '/');
  if (!trimmed) {
    return /^$/i;
  }

  // Collapse redundant adjacent `**/` or `**` segments to prevent catastrophic backtracking (ReDoS)
  trimmed = trimmed.replace(/(?:\*\*\/)+/g, '**/');

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
 * Compiles a single path-segment wildcard pattern into a RegExp.
 *
 * @remarks
 * Separated from matching so callers that evaluate the same segment pattern
 * repeatedly (e.g. the DP cells in {@link matchPathGlob}) can compile once and
 * reuse the result rather than rebuilding an identical RegExp per comparison.
 * The returned RegExp carries no stateful flags (`g`/`y`), so it is safe to
 * `.test()` repeatedly.
 *
 * @param pattern - Segment pattern (e.g. `*.md`, `[a-z]*`, `?`)
 * @returns Compiled anchored, case-insensitive RegExp
 */
function compileSegment(pattern: string): RegExp {
  let regStr = '';
  let inGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '[' && !inGroup) {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        inGroup = true;
        regStr += '[';
        if (pattern[i + 1] === '!') {
          regStr += '^';
          i++;
        }
        continue;
      } else {
        // Unclosed '[', escape as literal to avoid SyntaxError
        regStr += '\\[';
        continue;
      }
    }
    if (c === ']' && inGroup) {
      inGroup = false;
      regStr += ']';
      continue;
    }
    if (inGroup) {
      if (c === '\\') regStr += '\\\\';
      else if (['/', '^', '$'].includes(c)) regStr += `\\${c}`;
      else regStr += c;
      continue;
    }
    if (c === '*') regStr += '.*';
    else if (c === '?') regStr += '.';
    else if (['.', '+', '^', '$', '(', ')', '{', '}', '|', '\\'].includes(c)) regStr += `\\${c}`;
    else regStr += c;
  }
  return new RegExp(`^${regStr}$`, 'i');
}

/**
 * Evaluates whether a single path segment matches a segment wildcard pattern.
 *
 * @param pattern - Segment pattern (e.g. `*.md`, `[a-z]*`, `?`)
 * @param str - Path segment string
 * @returns `true` if segment matches
 */
function matchSegmentWildcard(pattern: string, str: string): boolean {
  if (pattern === str || pattern === '*') return true;
  return compileSegment(pattern).test(str);
}

/**
 * Matches a glob pattern against a target path using linear dynamic programming.
 *
 * @remarks
 * Immune to exponential catastrophic backtracking (ReDoS) across multi-band `**\/` globs.
 *
 * @param glob - Normalized glob pattern string
 * @param target - Normalized target path string
 * @returns `true` if path matches glob
 */
export function matchPathGlob(glob: string, target: string): boolean {
  const gNorm = glob.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const tNorm = target.replace(/\\/g, '/').replace(/^\.\//, '').trim();

  if (!gNorm) return !tNorm;

  // Single-filename glob matching (no '/')
  if (!gNorm.includes('/')) {
    const basename = tNorm.split('/').pop() || tNorm;
    if (matchSegmentWildcard(gNorm, basename)) return true;
  }

  const gParts = gNorm.split('/').filter(Boolean);
  const tParts = tNorm.split('/').filter(Boolean);

  // Precompile each distinct glob segment once (`**` has no RegExp) and reuse
  // across every DP cell, instead of recompiling an identical RegExp per cell.
  const compiledParts: (RegExp | null)[] = gParts.map((seg) =>
    seg === '**' ? null : compileSegment(seg),
  );

  const dp = Array.from({ length: gParts.length + 1 }, () => Array(tParts.length + 1).fill(false));
  dp[0][0] = true;

  for (let i = 1; i <= gParts.length; i++) {
    if (gParts[i - 1] === '**') {
      dp[i][0] = dp[i - 1][0];
      for (let j = 1; j <= tParts.length; j++) {
        dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
      }
    } else {
      dp[i][0] = false;
      const seg = gParts[i - 1];
      const re = compiledParts[i - 1] as RegExp;
      for (let j = 1; j <= tParts.length; j++) {
        const t = tParts[j - 1];
        // Mirrors matchSegmentWildcard's fast-paths (literal and `*`) using the
        // precompiled RegExp: `seg === t` is the literal match and the compiled
        // RegExp subsumes the `*` case.
        dp[i][j] = dp[i - 1][j - 1] && (seg === t || re.test(t));
      }
    }
  }

  return dp[gParts.length][tParts.length];
}

/**
 * Splits a pattern option into its individual patterns.
 *
 * @param patterns - Comma-separated string or array of glob patterns
 * @returns The pattern strings as supplied, without trimming or separator folding
 *
 * @remarks
 * A string takes the comma list (so `--exclude '*template*,*rubric*'` is two
 * patterns); an array is already a list and its entries keep their commas.
 */
function splitPatternList(patterns: string | string[]): string[] {
  return Array.isArray(patterns) ? patterns : patterns.split(',');
}

/**
 * Folds a supplied pattern into the form the matcher compares in.
 *
 * @param pattern - Raw pattern string
 * @returns Trimmed pattern with `\` turned into `/` and a leading `./` dropped
 */
function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Tests one already-normalized pattern against one already-normalized path.
 *
 * @param trimmedPattern - Normalized pattern (non-empty)
 * @param normalizedPath - Normalized vault-relative path
 * @param basename - Basename of {@link normalizedPath}
 * @returns `true` if this single pattern selects the path
 *
 * @remarks
 * The dialect, in one place so the OR-fold in {@link matchesPattern} and the
 * per-pattern tally in {@link tallyPatterns} can never disagree about what a
 * pattern means:
 * - no `/` in the pattern: it matches the note's **filename in any directory**;
 * - any `/`: it is **anchored at the vault root** and must name the whole
 *   relative path, segment by segment (`a/*.md` never reaches `b/a/x.md`);
 * - matching ignores case, and `*` stops at a directory boundary while `**`
 *   crosses it.
 */
function patternHitsFile(trimmedPattern: string, normalizedPath: string, basename: string): boolean {
  // Linear DP glob match
  if (matchPathGlob(trimmedPattern, normalizedPath)) {
    return true;
  }

  // Basename matching: allowed when pattern is a pure filename pattern (no '/')
  if (!trimmedPattern.includes('/') && matchSegmentWildcard(trimmedPattern, basename)) {
    return true;
  }

  // Segment & prefix matching for non-wildcard patterns (avoids false-positive substring collisions)
  if (!trimmedPattern.includes('*') && !trimmedPattern.includes('?')) {
    // A pattern is written by a person and a path comes off the volume, so the
    // two arrive in different Unicode normalizations on APFS — `notes/café`
    // excludes `notes/cafe` + U+0301 only if both sides fold the way the walked
    // keys do. Case alone was already folded; this folds the other half.
    const foldedPath = foldIdentity(normalizedPath);
    const foldedPattern = foldIdentity(trimmedPattern);
    const foldedBasename = foldIdentity(basename);

    if (
      foldedPath === foldedPattern ||
      foldedBasename === foldedPattern ||
      foldedPath.startsWith(`${foldedPattern}/`) ||
      foldedPath.endsWith(`/${foldedPattern}`) ||
      foldedPath.includes(`/${foldedPattern}/`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * One supplied pattern and how much of the scope it actually reached.
 */
export interface PatternTally {
  /** Pattern as supplied, after {@link normalizePattern} */
  pattern: string;
  /** How many of the tallied paths this pattern matched; `0` means it named no file */
  matches: number;
}

/**
 * Counts, per supplied pattern, how many of the given paths that pattern matched.
 *
 * @param paths - Vault-relative paths of the scanned scope
 * @param patterns - Glob pattern or comma-separated/array pattern list
 * @returns One entry per distinct normalized pattern, in the order supplied
 *
 * @remarks
 * `matchesPattern` OR-folds its patterns, so a caller that printed only the
 * aggregate ("Excluded (Pattern): 0 notes") could not tell a filter that worked
 * and found nothing to exclude from a pattern that names no file in this scope at
 * all (#312). This keeps the accounting per pattern instead: duplicate patterns
 * collapse to one entry, an empty pattern list yields an empty result, and no
 * short-circuiting means every pattern is measured against every path.
 *
 * @example
 * ```typescript
 * tallyPatterns(['a/x.md'], 'a/*.md, *zz*');
 * // [{ pattern: 'a/*.md', matches: 1 }, { pattern: '*zz*', matches: 0 }]
 * ```
 */
export function tallyPatterns(paths: readonly string[], patterns: string | string[]): PatternTally[] {
  const tallies: PatternTally[] = [];
  const seen = new Set<string>();
  for (const raw of splitPatternList(patterns)) {
    const trimmed = normalizePattern(raw);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tallies.push({ pattern: trimmed, matches: 0 });
  }

  const normalizedPaths = paths.map((filePath) => {
    const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return { normalizedPath, basename: path.posix.basename(normalizedPath) };
  });

  for (const tally of tallies) {
    for (const { normalizedPath, basename } of normalizedPaths) {
      if (patternHitsFile(tally.pattern, normalizedPath, basename)) tally.matches += 1;
    }
  }

  return tallies;
}

/**
 * Evaluates whether a file path or its basename matches any provided glob patterns.
 *
 * @remarks
 * Patterns can be passed as an array of strings or a comma-separated string (e.g. `"*.md, notes/**"`).
 * Matching modes (see {@link patternHitsFile} for the whole dialect):
 * 1. Full relative path matching via linear DP matcher (ReDoS-immune). A pattern
 *    containing `/` is anchored at the vault root and has to name the whole path.
 * 2. Basename matching if pattern contains no `/` — then it reaches the same name
 *    in every directory.
 * 3. Exact segment and prefix matching for non-wildcard directory specifications.
 * Matching is case-insensitive.
 *
 * @param filePath - File path to test
 * @param patterns - Glob pattern or array of glob patterns
 * @returns `true` if matching at least one pattern, otherwise `false`
 *
 * @example
 * ```typescript
 * matchesPattern('src/utils/math.ts', '*.ts');             // true
 * matchesPattern('notes/cs/algo.md', 'notes/**, docs/**');  // true
 * matchesPattern('notes/cs/algo.md', 'cs/*.md');           // false — `/` anchors at the root
 * ```
 */
export function matchesPattern(filePath: string, patterns: string | string[]): boolean {
  const patternList = splitPatternList(patterns);

  if (patternList.length === 0) {
    return false;
  }

  // Normalize path separators and strip leading relative prefix
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = path.posix.basename(normalizedPath);

  for (const pattern of patternList) {
    const trimmedPattern = normalizePattern(pattern);
    if (!trimmedPattern) continue;

    if (patternHitsFile(trimmedPattern, normalizedPath, basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizes frontmatter tags from arbitrary input formats into a clean lowercase string array without `#` prefixes.
 *
 * @param rawTags - Raw tags value (array of strings, comma/space-delimited string, or null/undefined)
 * @returns Array of normalized tag strings
 *
 * @remarks
 * Strips leading '#' characters, trims whitespace, and converts all characters to lowercase.
 * Public barrel contract export pinned by tests; reserved for internal adopt/roadmap and future tag validation rules (#29+, #51).
 *
 * @example
 * ```typescript
 * extractTags(['#react', '#web/ui']); // ['react', 'web/ui']
 * extractTags('math, #algebra');       // ['math', 'algebra']
 * ```
 */
export function extractTags(rawTags: unknown): string[] {
  if (!rawTags) return [];

  /**
   * Normalizes an individual tag entry to lowercase without leading hashtags.
   *
   * @param t - Raw tag value
   * @returns Cleaned tag string
   * @remarks Strips leading '#' characters.
   * @example
   * ```typescript
   * normalize('#Math'); // 'math'
   * ```
   */
  function normalize(t: unknown): string {
    return String(t)
      .trim()
      .replace(/^#+/, '')
      .toLowerCase();
  }

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
 * Tests whether note frontmatter tags match any requested target tags, supporting hierarchical nested namespaces.
 *
 * @remarks
 * Hierarchical matching modes:
 * - **Exact match**: Target `"category/math"` matches note tag `"category/math"`.
 * - **Prefix match**: Target `"category"` matches note tag `"category/math"`.
 * - **Suffix match**: Target `"math"` matches note tag `"category/math"`.
 * - **Infix match**: Target `"security"` matches note tag `"domain/security/crypto"`.
 *
 * @param noteTags - Note's frontmatter tags field
 * @param targetTags - Filter target tag(s) as array or comma-separated string
 * @returns `true` if any note tag matches any target tag, otherwise `false`
 *
 * @example
 * ```typescript
 * matchesTags(['#domain/backend/auth'], 'auth'); // true
 * ```
 */
export function matchesTags(noteTags: unknown, targetTags: string | string[]): boolean {
  /**
   * Normalizes an individual target tag query string to lowercase without leading hashtags.
   *
   * @param t - Raw target tag string
   * @returns Cleaned tag string
   * @remarks Strips leading '#' characters.
   * @example
   * ```typescript
   * normalize('#Auth'); // 'auth'
   * ```
   */
  function normalize(t: string): string {
    return t.trim().replace(/^#+/, '').toLowerCase();
  }

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

/**
 * Validates glob pattern strings and throws a descriptive Error if compilation fails.
 *
 * @param patterns - Pattern string or array of pattern strings to validate
 * @returns Void
 * @throws {Error} If regex compilation fails for any pattern
 *
 * @remarks
 * Compiles each pattern through `globToRegex` to ensure regex validity.
 * Unclosed character classes (e.g. `[`) are safely escaped as literals
 * by `globToRegex` and do not trigger validation errors.
 *
 * @example
 * ```typescript
 * validatePattern('notes/*.md');
 * ```
 */
export function validatePattern(patterns: string | string[]): void {
  const patternList = Array.isArray(patterns)
    ? patterns
    : patterns.split(',').map((p) => p.trim()).filter(Boolean);

  for (const pattern of patternList) {
    const trimmed = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!trimmed) continue;
    try {
      globToRegex(trimmed);
    } catch (err: unknown) {
      const e = err as Error;
      throw new Error(`Invalid glob pattern "${pattern}": ${e.message}`, { cause: err });
    }
  }
}


