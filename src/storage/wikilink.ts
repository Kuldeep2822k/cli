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
 * converts both to exit code 3 and writes nothing. Anchors (`#heading`,
 * `#^block`) and `.md` suffixes are stripped before resolution; matching is
 * case-insensitive with an exact-case tiebreak.
 */

import fs from 'fs';
import path from 'path';
import { walkVault, relativeVaultPath } from './vault-walker';
import { generateTopicId } from '../engine/topic-id';
import type { ParsedWikilink } from '../engine/auto-chain';
import { loadTopics } from './loader';
import { resolveNoteTitle } from './note-title';
import type { RoadmapFile, RoadmapTopic } from '../types';

/** Thrown when a wikilink matches more than one vault note. */
export class AmbiguousWikilinkError extends Error {
  /** The link target as written (anchor/`.md` already stripped) */
  readonly link: string;
  /** Vault-relative paths of every candidate, sorted */
  readonly candidates: string[];

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

function isWithinVault(resolvedVault: string, absolutePath: string): boolean {
  const rel = path.relative(resolvedVault, absolutePath);
  return (
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !rel.split(path.sep).includes('..')
  );
}

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
 * Resolution order: (1) exact vault-relative path match (with or without the
 * `.md` suffix — the resolved file must stay inside the vault); (2) unique
 * basename match, case-insensitive, with an exact-case hit winning ties.
 */
export function resolveWikilinkTarget(
  vaultPath: string,
  link: ParsedWikilink,
  index: Map<string, string[]>
): ResolvedWikilink {
  const resolvedVault = fs.realpathSync(vaultPath);
  const target = link.target;

  // 1. Exact vault-relative path match (with or without `.md`)
  const pathCandidates = target.toLowerCase().endsWith('.md') ? [target] : [`${target}.md`, target];
  for (const candidate of pathCandidates) {
    const absoluteCandidate = path.resolve(resolvedVault, candidate);
    if (!fs.existsSync(absoluteCandidate) || !fs.statSync(absoluteCandidate).isFile()) {
      continue;
    }
    const canonical = fs.realpathSync(absoluteCandidate);
    if (!isWithinVault(resolvedVault, canonical)) {
      continue;
    }
    return { absolutePath: canonical, relativePath: relativeVaultPath(vaultPath, canonical) };
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

/** One `## Track` section of a wikilink roadmap: an ordered chain of links. */
export interface WikilinkRoadmapSection {
  /** Section heading (track name) */
  track: string;
  /** Ordered wikilinks in this section */
  links: ParsedWikilink[];
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
 * sequentially so `roadmap --auto-chain` reproduces the same chain.
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
        order: order++,
      });
      previousId = id;
    }
  }

  return { topics };
}
