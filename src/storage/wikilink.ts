/**
 * Wikilink Resolution — Obsidian `[[...]]` Target Lookup (Issue #73)
 *
 * @remarks
 * Resolves wikilink targets parsed by `src/engine/auto-chain.ts` against the
 * vault. Used by the wikilink roadmap format (`palee roadmap --from
 * roadmap.md` with `## Track` sections of `[[...]]` bullet lists).
 *
 * Resolution is fail-closed: an ambiguous link (several notes share the
 * basename) throws {@link AmbiguousWikilinkError} listing every candidate,
 * and an unresolvable link throws {@link UnresolvedWikilinkError} — the CLI
 * converts both to exit code 3 and writes nothing. A link that escapes the
 * vault, or that names a path the rest of the CLI cannot see (non-Markdown,
 * `.trash`/other dot-namespaces, `node_modules`), is rejected with
 * {@link UnresolvedWikilinkError} rather than skipped: it never falls through
 * to a lookalike note. Anchors (`#heading`, `#^block`) and `.md` suffixes are
 * stripped before resolution; matching is case-insensitive with an exact-case
 * tiebreak.
 */

import fs from 'fs';
import path from 'path';
import { walkVault, relativeVaultPath, isResolvableNotePath } from './vault-walker';
import { generateTopicId } from '../engine/topic-id';
import type { ParsedWikilink } from '../engine/auto-chain';
import type { WikilinkRoadmapSection } from './roadmap-parser';
import { loadTopics } from './loader';
import { resolveNoteTitle } from './note-title';
import type { RoadmapFile, RoadmapTopic } from '../types';

/**
 * A section is declared once, in `src/storage/roadmap-parser.ts` — the module
 * that produces it. Re-exported here so a caller that resolves a roadmap needs
 * no second import; `./roadmap-parser` remains the only declaration.
 */
export type { WikilinkRoadmapSection };

/** Thrown when a wikilink matches more than one vault note. */
export class AmbiguousWikilinkError extends Error {
  /** The link target as written (anchor/`.md` already stripped) */
  readonly link: string;
  /** Vault-relative paths of every candidate, sorted */
  readonly candidates: string[];

  /**
   * @param link - The link target as written (anchor/`.md` already stripped)
   * @param candidates - Vault-relative paths of every matching note, sorted
   */
  constructor(link: string, candidates: string[]) {
    super(
      `Ambiguous wikilink [[${link}]]: matches ${candidates.length} notes: ${candidates.join(', ')}`
    );
    this.name = 'AmbiguousWikilinkError';
    this.link = link;
    this.candidates = [...candidates];
  }
}

/** Thrown when a wikilink matches no vault note. */
export class UnresolvedWikilinkError extends Error {
  /** The link target as written (anchor/`.md` already stripped) */
  readonly link: string;

  /** @param link - The link target as written (anchor/`.md` already stripped) */
  constructor(link: string) {
    super(`Unresolved wikilink [[${link}]]: no matching note in the vault`);
    this.name = 'UnresolvedWikilinkError';
    this.link = link;
  }
}

/** A wikilink resolved to a concrete vault note. */
export interface ResolvedWikilink {
  /** Canonical absolute path of the note */
  absolutePath: string;
  /** POSIX path relative to the vault root */
  relativePath: string;
}

/**
 * Builds a case-insensitive basename index of every Markdown note in the vault.
 *
 * @param vaultPath - Absolute path to the vault root
 * @returns Map from lowercased basename (without `.md`) to absolute paths
 */
export function buildVaultNoteIndex(vaultPath: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const absolutePath of walkVault(vaultPath)) {
    const key = path.basename(absolutePath, '.md').toLowerCase();
    const list = index.get(key);
    if (list) {
      list.push(absolutePath);
    } else {
      index.set(key, [absolutePath]);
    }
  }
  return index;
}

/**
 * Whether an absolute path stays inside the vault root, after both are
 * canonicalized. The single containment guard for the #73 code paths: wikilink
 * resolution and `palee roadmap`'s topic-path validation.
 *
 * @param resolvedVault - Canonical absolute vault root (`fs.realpathSync`ed)
 * @param absolutePath - Canonical absolute candidate path
 * @returns `false` when the relative hop leaves the root through `..` or lands
 * on another drive/root
 */
export function isWithinVault(resolvedVault: string, absolutePath: string): boolean {
  const rel = path.relative(resolvedVault, absolutePath);
  return (
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !rel.split(path.sep).includes('..')
  );
}

/**
 * Basename of a wikilink target, split on `/` only.
 *
 * Deliberately not `path.basename`: on Windows that also splits on `\`, so a
 * target like `[[notes\01-a]]` would stop failing closed and start matching the
 * vault note named `01-a` — a different note from the one the user wrote.
 */
function targetBaseName(target: string): string {
  const idx = target.lastIndexOf('/');
  return idx >= 0 ? target.slice(idx + 1) : target;
}

/**
 * Resolves one parsed wikilink to a vault note.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param link - Parsed wikilink (anchor/`.md` already stripped)
 * @param index - Note index from {@link buildVaultNoteIndex}
 * @returns Canonical absolute path and vault-relative POSIX path
 * @throws {@link AmbiguousWikilinkError} when several notes match
 * @throws {@link UnresolvedWikilinkError} when no note matches
 *
 * @remarks
 * Targets containing a backslash are rejected outright: Wikilink targets are
 * `/`-separated only, and rejecting keeps behaviour identical across platforms
 * (Windows `path.resolve` would otherwise treat `\` as a separator).
 * Resolution order: (1) exact vault-relative path match — the `.md` suffix is
 * added when absent, and the target must stay inside the vault *and* name a
 * visible Markdown note. Both checks run before any filesystem access, so an
 * unsafe target fails closed here whether or not the file exists, and can never
 * reach step 2; a target whose exact candidate is absent also fails closed
 * before step 2 when it names an existing non-Markdown file or sits under a
 * symlinked ancestor that leaves the vault — the basename fallback must never
 * rescue a target the exact match rejected; (2) unique basename match,
 * case-insensitive, with an exact-case hit winning ties.
 */
export function resolveWikilinkTarget(
  vaultPath: string,
  link: ParsedWikilink,
  index: Map<string, string[]>
): ResolvedWikilink {
  const resolvedVault = fs.realpathSync(vaultPath);
  const target = link.target;

  // Wikilink targets are `/`-separated only (see {@link targetBaseName}). An
  // explicit reject is required, not just an absent feature: on Windows
  // `path.resolve` treats `\` as a separator, so `[[MODULES\01-a]]` would
  // otherwise resolve the exact note on Windows and throw on POSIX.
  if (target.includes('\\')) {
    throw new UnresolvedWikilinkError(target);
  }

  // 1. Exact vault-relative path match.
  //
  // Only the `.md` form is a candidate — the bare target is deliberately NOT
  // one. Whatever this function returns is read as UTF-8 and has YAML
  // frontmatter written back into it by the roadmap importer, so matching a
  // non-Markdown file (`![[assets/diagram.png]]` resolves to a PNG) destroys
  // that file irrecoverably. Hidden invariant: a wikilink may only ever touch
  // a visible Markdown note.
  // A single candidate, never a list: the target as written when it already
  // ends in `.md`, the target plus `.md` otherwise.
  const candidate = target.toLowerCase().endsWith('.md') ? target : `${target}.md`;
  const absoluteCandidate = path.resolve(resolvedVault, candidate);

  // Both guards run *before* any filesystem access, and the ordering is
  // load-bearing. If they ran only on a candidate that exists, an unsafe target
  // that happens to be missing (`[[../missing/note]]`) would fall through to
  // the basename lookup below and resolve an unrelated in-vault `note.md` — a
  // note the user never named, whose frontmatter the importer then rewrites.
  if (!isWithinVault(resolvedVault, absoluteCandidate)) {
    // Fail closed. Falling through to the basename lookup would silently
    // rewrite a *different* note — one the user never named — just because
    // it shares a basename with the escaping path.
    throw new UnresolvedWikilinkError(target);
  }
  const lexicalRelative = path
    .relative(resolvedVault, absoluteCandidate)
    .split(path.sep)
    .join('/');
  if (!isResolvableNotePath(lexicalRelative)) {
    // Dot-namespaces (`.trash/…`), `node_modules` and non-Markdown files are
    // invisible everywhere else in the CLI; a link must not resurrect them.
    throw new UnresolvedWikilinkError(target);
  }

  if (fs.existsSync(absoluteCandidate) && fs.statSync(absoluteCandidate).isFile()) {
    const canonical = fs.realpathSync(absoluteCandidate);
    // Re-checked on the canonical path: a symlink can point back out of the
    // vault, or into an invisible namespace, even when its lexical form is clean.
    if (!isWithinVault(resolvedVault, canonical)) {
      throw new UnresolvedWikilinkError(target);
    }
    const relativePath = relativeVaultPath(vaultPath, canonical);
    if (!isResolvableNotePath(relativePath)) {
      throw new UnresolvedWikilinkError(target);
    }
    return { absolutePath: canonical, relativePath };
  }

  // 1b. Fail closed before the basename fallback. Both guards fire only for a
  // target whose exact candidate is absent; without them step 2 resolves an
  // unrelated in-vault note the user never named — the same hijack class the
  // guards above close for escaping and invisible paths.
  const bareAbsolute = path.resolve(resolvedVault, target);
  if (fs.existsSync(bareAbsolute) && fs.statSync(bareAbsolute).isFile()) {
    // The target as written names a real file that is not a Markdown note
    // (`[[assets/diagram.png]]`). A basename namesake such as
    // `other/diagram.png.md` is a different file; resolving it would rewrite
    // the wrong note's frontmatter.
    throw new UnresolvedWikilinkError(target);
  }
  // Deepest existing ancestor: a symlinked directory can leave the vault even
  // though every lexical segment looked clean. `vault/link -> outside` with
  // `[[link/note]]` (missing inside `outside`) must not fall through to the
  // in-vault `note.md`.
  let ancestor = path.dirname(absoluteCandidate);
  while (ancestor !== path.dirname(ancestor) && !fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  if (!isWithinVault(resolvedVault, fs.realpathSync(ancestor))) {
    throw new UnresolvedWikilinkError(target);
  }

  // 2. Basename match (case-insensitive); an exact-case hit wins ties
  const key = targetBaseName(target).toLowerCase();
  const hits = index.get(key) ?? [];
  if (hits.length === 1) {
    return { absolutePath: hits[0], relativePath: relativeVaultPath(vaultPath, hits[0]) };
  }
  if (hits.length > 1) {
    const exactCase = hits.filter((h) => path.basename(h, '.md') === targetBaseName(target));
    if (exactCase.length === 1) {
      return {
        absolutePath: exactCase[0],
        relativePath: relativeVaultPath(vaultPath, exactCase[0]),
      };
    }
    const candidates = hits.map((h) => relativeVaultPath(vaultPath, h)).sort();
    throw new AmbiguousWikilinkError(target, candidates);
  }

  // 3. No match
  throw new UnresolvedWikilinkError(target);
}

/**
 * Resolves wikilink roadmap sections into a {@link RoadmapFile} with chained
 * `depends_on`.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param sections - Ordered wikilink sections from the roadmap parser
 * @returns Roadmap topics with minted-or-reused IDs and chained dependencies
 * @throws {@link AmbiguousWikilinkError} / {@link UnresolvedWikilinkError}
 * @throws `Error` when the same note appears twice (it would depend on itself)
 *
 * @remarks
 * Each section becomes one chain: topic N's `depends_on` is `[topic N−1's
 * id]` (the section head gets an explicit `[]`, which replaces any
 * hand-written deps per the #139 "populated replaces" rule). An already
 * adopted note keeps its `palee_id` and title; an unadopted note gets a
 * minted ID and a title resolved from its content. `order` is assigned
 * sequentially for stable display; the chain is final at resolution time and
 * `roadmap --auto-chain` does not re-chain wikilink output (INV-47).
 */
export function resolveWikilinkRoadmap(
  vaultPath: string,
  sections: WikilinkRoadmapSection[]
): RoadmapFile {
  const index = buildVaultNoteIndex(vaultPath);
  const existingByPath = new Map<string, { id: string; title: string }>();
  for (const topic of loadTopics(vaultPath)) {
    existingByPath.set(topic.filePath, { id: topic.id, title: topic.title });
  }

  const topics: RoadmapTopic[] = [];
  const seenPaths = new Set<string>();
  let order = 0;

  for (const section of sections) {
    let previousId: string | null = null;
    for (const link of section.links) {
      const resolved = resolveWikilinkTarget(vaultPath, link, index);
      if (seenPaths.has(resolved.absolutePath)) {
        throw new Error(
          `Duplicate wikilink target in roadmap: [[${link.target}]] resolves to ${resolved.relativePath} more than once`
        );
      }
      seenPaths.add(resolved.absolutePath);

      const existing = existingByPath.get(resolved.absolutePath);
      let id: string;
      let title: string;
      if (existing) {
        id = existing.id;
        title = existing.title;
      } else {
        id = generateTopicId();
        const content = fs.readFileSync(resolved.absolutePath, 'utf8');
        title = resolveNoteTitle(content, resolved.absolutePath);
      }

      topics.push({
        id,
        title,
        path: resolved.relativePath,
        depends_on: previousId ? [previousId] : [],
        chained: true,
        order: order++,
      });
      previousId = id;
    }
  }

  return { topics };
}
