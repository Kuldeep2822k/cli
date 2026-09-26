/**
 * Tier-0 Hygiene Predicates — Layout Classification (Issue PAL-205-B, INV-46)
 *
 * @remarks
 * Pure, fs-free classification of vault-relative note paths into the three
 * roles a note may play in an auto-chain plan:
 *
 * - `backbone` — joins the chained spine and may gate (be a `depends_on` of)
 *   other notes;
 * - `leaf` — part of the adoption scope but never gates the chain: it may keep
 *   a predecessor, nothing chains after it;
 * - `excluded` — never chained and never adopted by an `--auto-chain` batch;
 *   reported under a counted skip reason.
 *
 * Everything here takes `/`-separated path strings and plain data: the engine
 * layer stays fs-free (`agent.md`), and these predicates are the contract Work
 * Order C (TOC tier) consumes after rebase — do not fork these rules.
 *
 * Blocklists here are *data, not law*: the content audit itself hit a
 * hand-copied locale list that silently missed ja/pt/it, so every name-based
 * rule is paired with a structural signal (a `translations/` segment, a phase
 * directory) and the failure direction is always "demote to leaf", never
 * "chain as a lesson".
 */

/** Role a note may play in an auto-chain plan after Tier-0 hygiene. */
export type Tier0Class = 'backbone' | 'leaf' | 'excluded';

/** Counted skip reasons for notes hygiene removes from or demotes out of the chain. */
export type Tier0SkipReason =
  | 'repo-meta'
  | 'translation'
  | 'template'
  | 'phase-subtree'
  | 'invalid-palee-id';

/** Decision returned by {@link classifyNoteForChain}. */
export interface Tier0Decision {
  /** Role the note plays in the plan */
  cls: Tier0Class;
  /** Skip/demotion cause, only set when `cls` is not `'backbone'` */
  reason?: Tier0SkipReason;
}

/**
 * B1 — repo-meta basenames excluded from chaining and batch adoption
 * (compared case-insensitively against the `.md` stem; `.md` files only).
 */
export const REPO_META_STEMS: readonly string[] = [
  'license',
  'licence',
  'contributing',
  'changelog',
  'authors',
  'backers',
  'code_of_conduct',
  'code-of-conduct',
  'security',
  'support',
  'funding',
  'sponsor',
  'translations',
  '_404',
  'agents',
  'cname',
  'index',
  'home',
  'toc',
  'contents',
];

/** B4 — directory segments whose subtrees must never chain internally. */
export const PHASE_DIR_SEGMENTS: readonly string[] = [
  'solution',
  'solutions',
  'your-work',
  'start',
  'sketch',
  'answers',
];

/**
 * B5 — basename prefixes that mark a content doc (case-insensitive against the
 * `.md` stem, word boundary required: `lab-01` and `exam.md` qualify,
 * `labnotes` does not).
 */
export const CONTENT_DOC_PREFIXES: readonly string[] = [
  'deep-dive',
  'lab',
  'exam',
  'assignment',
  'quiz',
  'solution',
];

/** Basenames (stem, case-insensitive) that always denote a content document. */
export const README_CLASS_STEMS: readonly string[] = ['readme', 'summary'];

/**
 * Generic document names whose locale-suffixed variants are conventional
 * translations (`README.cn.md`, `CHANGELOG.fr.md`). Used as the *loose* arm of
 * the B2 matcher.
 */
export const GENERIC_DOC_STEMS: readonly string[] = [
  ...README_CLASS_STEMS,
  'index',
  'contents',
  'toc',
  'license',
  'licence',
  'contributing',
  'changelog',
  'authors',
  'backers',
  'support',
  'funding',
  'security',
  'faq',
];

/**
 * B2 — languages OSS curricula are actually translated into. Deliberately
 * includes `ja`, `pt`, `it` (the codes the audit's hand-copied list missed).
 * A name-based match is trusted only as far as its base doc name: a locale
 * suffix on a *generic* doc name (`README.ko-KR`, `CHANGELOG.fr`) is an
 * unambiguous translation copy and is excluded, while on any other name it is
 * a guess that only demotes the note to leaf. The structural `translations/`
 * segment stays the authoritative signal for translated lessons.
 */
export const TRANSLATION_LANG_CODES: readonly string[] = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi', 'nl', 'pl',
  'tr', 'sv', 'no', 'da', 'fi', 'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'he', 'th', 'vi',
  'id', 'ms', 'uk', 'fa', 'ur', 'bn', 'ta', 'te', 'mr', 'ga', 'lt', 'lv', 'et', 'hr',
  'sr', 'sl', 'mk', 'sq', 'az', 'ka', 'hy', 'ne', 'si', 'ml', 'kn', 'gu', 'pa', 'sw',
  'am', 'yo', 'xh', 'zu', 'af', 'is', 'gl', 'ca', 'eu', 'mt', 'cy',
];

/** B2 — region aliases accepted as a trailing locale where ISO-639 names no code. */
export const LOCALE_REGION_ALIASES: readonly string[] = ['cn', 'hk', 'mo', 'tw', 'sg'];

/**
 * B2 false-positive guard — short tokens that collide with real language codes
 * but overwhelmingly name a programming language in a study vault, so
 * `guide-js.md` stays a content doc instead of being demoted as Japanese.
 */
export const LOCALE_CODE_COLLISIONS: readonly string[] = ['js', 'ts', 'la'];

/** Structural translation signal: a whole `translations/` or `translation/` segment. */
const TRANSLATION_DIR = /^translations?$/i;

/**
 * B3 — `template` / `templates` as a whole name token, never as a substring.
 *
 * @remarks
 * The substring form this replaced excluded real lessons: `03-cpp/02-templates.md`
 * is a C++ templates module and `04-jinja-templates/` a whole topic, yet both
 * named a template. A numeric prefix is an explicit order statement and exempts
 * the name, exactly as it does for the B2 locale arm, so a numbered note is
 * never dropped on its spelling.
 */
const TEMPLATE_TOKEN = /(^|[-_.\s])templates?($|[-_.\s])/;

/**
 * B3 — whether a stem or directory segment names a template rather than a lesson.
 *
 * @param name - Lowercased `.md` stem, or a lowercased directory segment
 * @returns True only for an unnumbered name carrying `template`/`templates` as
 * a whole token
 */
function isTemplateName(name: string): boolean {
  return parseStemNumber(name) === null && TEMPLATE_TOKEN.test(name);
}

/**
 * Splits a trailing locale suffix into its language and region/script parts.
 *
 * @remarks
 * Two anchoring details carry regressions:
 * - the base group is *lazy*, because a greedy `(.+)` re-parses
 *   `readme.ko-kr` as base `readme.ko` + language `kr` and silently stops
 *   matching a translation;
 * - the language group is capped at 3 letters, so a greedy base cannot hand a
 *   4-letter script tag to the language slot and mis-parse `README-zh-Hans`
 *   as base `readme-zh` + language `hans`.
 */
const LOCALE_SUFFIX = /^(.+?)[._-]([a-z]{2,3})(?:-([a-z]{2,4}))?$/i;

function inList(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/**
 * B2 — how much weight a trailing locale suffix carries: `'generic'` for a
 * locale-suffixed repo/doc name such as `README.ko-KR` or `CHANGELOG.fr`
 * (unambiguously a translation copy), `'other'` for any other name such as
 * `assignment.es`, and `null` when the stem carries no trustworthy locale.
 *
 * @remarks
 * Two arms, because the two situations differ in how much they can be trusted:
 *
 * 1. **Generic doc name** (`readme`, `changelog`, …): any well-formed locale
 *    suffix counts, including region aliases like `cn` that name a country,
 *    not an ISO-639 language. A copy of a repo-meta doc is never a lesson, so
 *    it is `excluded` rather than demoted (INV-46).
 * 2. **Anything else unnumbered**: only a listed translation language counts,
 *    and never a {@link LOCALE_CODE_COLLISIONS} token. This is what keeps
 *    `guide-js` (a JavaScript guide) on the backbone.
 *
 * A stem that parses as a numbered lesson is exempt from both arms: the number
 * is an explicit order statement, and translated lessons are caught by the
 * structural `translations/` segment instead. Without that exemption
 * `02-es.md` — the Elasticsearch lesson — read as Spanish.
 */
function localeSuffixKind(stem: string): 'generic' | 'other' | null {
  // A numeric prefix is the author stating a lesson order, which outranks a
  // name-based guess about language: `02-es.md` is the Elasticsearch lesson in
  // a search module, not a Spanish translation of lesson 2. Real translated
  // lessons sit under a structural `translations/` segment and are excluded by
  // that signal instead, which is why the name arm may stay this conservative.
  if (parseStemNumber(stem) !== null) {
    return null;
  }
  const match = LOCALE_SUFFIX.exec(stem);
  if (!match) {
    return null;
  }
  const base = match[1].toLowerCase();
  const primary = match[2].toLowerCase();
  const secondary = match[3] ? match[3].toLowerCase() : null;
  if (inList(LOCALE_CODE_COLLISIONS, primary)) {
    return null;
  }
  if (inList(GENERIC_DOC_STEMS, base)) {
    return 'generic';
  }
  if (!/^[a-z]{2,3}$/.test(primary)) {
    return null;
  }
  if (inList(TRANSLATION_LANG_CODES, primary)) {
    return 'other';
  }
  return secondary !== null && inList(LOCALE_REGION_ALIASES, primary) ? 'other' : null;
}

/** Case-insensitive `.md` stem of a basename; `''` for non-markdown names. */
export function stemOf(basename: string): string {
  if (!basename.toLowerCase().endsWith('.md')) {
    return '';
  }
  return basename.slice(0, -3).toLowerCase();
}

/**
 * B7 — the `palee_id` type hole. The adopt scan once accepted any *truthy*
 * `palee_id` as "already adopted" while `loadTopics` requires a non-empty
 * string, so `palee_id: 12345` made an unsatisfiable chain predecessor that
 * silently blocked everything chaining after it.
 */
export function isValidPaleeId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True when any non-final path segment names a phase directory (B4). */
export function isPhaseSubtree(relPath: string): boolean {
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (inList(PHASE_DIR_SEGMENTS, segments[i].toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * B5 — whether a basename denotes a content doc allowed on the backbone:
 * README-class, numeric-prefixed, or phase-prefixed. Ad-hoc unnumbered
 * siblings (`for-teachers.md`, `how-to-run.md`) are not content docs.
 *
 * @param basename - File basename including the `.md` extension
 * @returns `true` when the name may join the backbone
 */
export function isContentDocName(basename: string): boolean {
  const stem = stemOf(basename);
  if (stem.length === 0) {
    return false;
  }
  if (inList(README_CLASS_STEMS, stem)) {
    return true;
  }
  if (parseStemNumber(stem) !== null) {
    return true;
  }
  return CONTENT_DOC_PREFIXES.some(
    (kw) =>
      stem === kw ||
      stem.startsWith(kw + '-') ||
      stem.startsWith(kw + '_') ||
      stem.startsWith(kw + '.') ||
      stem.startsWith(kw + ' ')
  );
}

/**
 * Classifies one vault-relative note path for Tier-0 chaining (B1–B5, B7).
 *
 * @param relPath - Vault-relative POSIX path (`01-a/02-b.md`)
 * @param paleeId - Frontmatter `palee_id` value as parsed, when the scan has it.
 * A present-but-invalid value demotes the note to leaf: it is never rewritten
 * (adopted notes keep their frontmatter) and never gates the chain.
 * @returns The role and, for non-backbone notes, the counted skip reason
 *
 * @example
 * ```typescript
 * classifyNoteForChain('LICENSE.md');              // { cls: 'excluded', reason: 'repo-meta' }
 * classifyNoteForChain('translations/01-a.es.md'); // { cls: 'excluded', reason: 'translation' }
 * classifyNoteForChain('01-x/for-teachers.md');    // { cls: 'leaf' }
 * classifyNoteForChain('01-x/02-y.md');            // { cls: 'backbone' }
 * ```
 */
export function classifyNoteForChain(relPath: string, paleeId?: unknown): Tier0Decision {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1];
  const stem = stemOf(basename);

  const dirSegments = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (dirSegments.some((s) => TRANSLATION_DIR.test(s))) {
    return { cls: 'excluded', reason: 'translation' };
  }
  if (stem.length === 0) {
    return { cls: 'backbone' };
  }
  if (inList(REPO_META_STEMS, stem)) {
    return { cls: 'excluded', reason: 'repo-meta' };
  }
  if (isTemplateName(stem) || dirSegments.some(isTemplateName)) {
    return { cls: 'excluded', reason: 'template' };
  }
  // A locale-suffixed repo/doc name is a translation copy of a file that is
  // itself repo-meta, so it is excluded with its siblings; a locale suffix on
  // any other name is only a name-based guess and demotes instead (B2).
  const localeKind = localeSuffixKind(stem);
  if (localeKind === 'generic') {
    return { cls: 'excluded', reason: 'translation' };
  }

  // B7 is checked after the exclusions on purpose: an unsatisfiable id must
  // keep a note off the backbone, but a repo-meta note with such an id is out
  // of scope entirely and must not be adopted either.
  if (paleeId !== undefined && !isValidPaleeId(paleeId)) {
    return { cls: 'leaf', reason: 'invalid-palee-id' };
  }

  if (isPhaseSubtree(normalized)) {
    return { cls: 'leaf', reason: 'phase-subtree' };
  }
  if (localeKind === 'other') {
    return { cls: 'leaf', reason: 'translation' };
  }
  if (isContentDocName(basename)) {
    return { cls: 'backbone' };
  }
  return { cls: 'leaf' };
}

/**
 * Numeric lesson number of a file stem, using the same separator-or-end and
 * 3-digit contract as `auto-chain.ts`'s exported `parseNumericPrefix`. Kept
 * local so this module has no import edge into `auto-chain.ts`; the engine
 * module remains the single public parser for the CLI.
 */
function parseStemNumber(stem: string): number | null {
  const match = /^(\d{1,3})(?:[-_.\s](.*)|$)/.exec(stem.trim());
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}
