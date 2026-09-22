/**
 * Multi-Format Roadmap Parser
 *
 * @remarks
 * Ingests external curriculum and roadmap definitions across multiple syntax representations:
 * 1. YAML frontmatter inside a Markdown file (`--- \n topics: [...] \n ---`)
 * 2. Embedded YAML code block inside a Markdown file (` ```yaml \n topics: [...] \n ``` `)
 * 3. Pure raw YAML files
 * 4. Wikilink bullet lists under Markdown section headings (#73): each `## Track`
 *    section's ordered `[[...]]` items form one dependency chain
 */

import yaml from 'yaml';
import { normalizeDependencies } from './dependencies';
import { parseFrontmatter } from './frontmatter';
import { extractWikilinks, type ParsedWikilink } from '../engine/auto-chain';
import { RoadmapFile, RoadmapTopic } from '../types';

/**
 * One `## Track` section of a wikilink roadmap: an ordered chain of links.
 */
export interface WikilinkRoadmapSection {
  /** Section heading (track name); empty when bullets precede any heading */
  track: string;
  /** Ordered wikilinks found in this section's bullet lists */
  links: ParsedWikilink[];
}

/**
 * Result object returned when parsing a roadmap source document.
 */
export interface ParsedRoadmapResult {
  /** Parsed roadmap file payload, or null if unparseable / missing topics */
  roadmap: RoadmapFile | null;
  /** Discovered roadmap source format representation */
  format?: 'yaml' | 'frontmatter' | 'codeblock' | 'wikilink';
  /**
   * Present only when `format` is `'wikilink'`: ordered wikilink sections
   * awaiting vault resolution (see `resolveWikilinkRoadmap` in `./wikilink`).
   */
  sections?: WikilinkRoadmapSection[];
  /** Error diagnostic message if parsing failed */
  error?: string;
}

type RawRoadmapTopic = Omit<RoadmapTopic, 'depends_on'> & {
  depends_on?: unknown;
  dependencies?: unknown;
};

function normalizeRoadmap(topics: unknown[]): { roadmap: RoadmapFile } | { error: string } {
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)) {
      return {
        error: `Invalid topic at index ${i}: expected topic object, received ${topic === null ? 'null' : Array.isArray(topic) ? 'array' : typeof topic}`,
      };
    }
  }

  return {
    roadmap: {
      topics: (topics as RawRoadmapTopic[]).map((topic) => {
        const { depends_on, dependencies, ...fields } = topic;
        if (depends_on === undefined && dependencies === undefined) {
          return fields as RoadmapTopic;
        }
        return {
          ...fields,
          depends_on: normalizeDependencies(depends_on, dependencies),
        } as RoadmapTopic;
      }),
    },
  };
}

/**
 * Parses the wikilink roadmap format (#73): Markdown `## Track` sections whose
 * bullet/numbered list items contain Obsidian `[[...]]` links.
 *
 * @param rawContent - Raw text content of the roadmap document
 * @returns Ordered sections with their wikilinks, or `null` when the document
 * contains no wikilink list structure
 *
 * @remarks
 * Fenced code blocks are stripped before scanning so incidental `[[...]]`
 * inside examples never counts. Bullets before the first heading collect
 * into a section with an empty track name.
 */
export function parseWikilinkSections(rawContent: string): WikilinkRoadmapSection[] | null {
  const { body } = parseFrontmatter(rawContent);
  const text = body ?? rawContent;
  // Strip fenced code blocks (``` and ~~~) so examples never count as links
  const stripped = text.replace(/(?:```|~~~)[^`~]*?\r?\n[\s\S]*?\r?\n\s*(?:```|~~~)/g, '');

  const sections: WikilinkRoadmapSection[] = [];
  let current: WikilinkRoadmapSection | null = null;

  for (const line of stripped.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { track: heading[1].trim(), links: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line) ?? /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) {
        current = { track: '', links: [] };
        sections.push(current);
      }
      current.links.push(...extractWikilinks(bullet[1]));
    }
  }

  const nonEmpty = sections.filter((s) => s.links.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : null;
}

/**
 * Extracts and parses a curriculum roadmap definition from Markdown frontmatter, YAML codeblocks, or raw YAML.
 *
 * @remarks
 * Evaluates roadmap content across four formats in order:
 * 1. Markdown YAML frontmatter block (`---`).
 * 2. Embedded YAML code fences (` ```yaml `).
 * 3. Raw pure YAML documents.
 * 4. Wikilink bullet lists under Markdown section headings (#73).
 *
 * @param rawContent - Raw text content of the roadmap document
 * @param filePath - Optional path to the file (used for format hints based on extension)
 * @returns {@link ParsedRoadmapResult} with parsed topics array, format classification, or error details
 *
 * @example
 * ```typescript
 * const result = parseRoadmapContent(rawFileContent, 'curriculum.md');
 * if (result.roadmap) {
 *   console.log(`Discovered ${result.roadmap.topics.length} topics from ${result.format}`);
 * }
 * ```
 */
export function parseRoadmapContent(rawContent: string, filePath?: string): ParsedRoadmapResult {
  const isMdFile = filePath ? /\.(md|markdown)$/i.test(filePath) : false;
  const isYamlFile = filePath ? /\.(ya?ml)$/i.test(filePath) : false;

  // 1. If it's a Markdown file or contains frontmatter delimiters, try frontmatter first
  if (isMdFile || rawContent.trimStart().startsWith('---')) {
    const fmResult = parseFrontmatter(rawContent);
    if (fmResult.error) {
      return {
        roadmap: null,
        error: `Invalid frontmatter YAML: ${fmResult.error}`,
      };
    }
    if (fmResult.frontmatter && Array.isArray(fmResult.frontmatter.topics)) {
      const normalized = normalizeRoadmap(fmResult.frontmatter.topics);
      if ('error' in normalized) {
        return {
          roadmap: null,
          error: normalized.error,
        };
      }
      return {
        roadmap: normalized.roadmap,
        format: 'frontmatter',
      };
    }
  }

  // 2. Try Embedded YAML Code Blocks (supports whitespace or info strings after language tag)
  const codeBlockRegex = /```(?:ya?ml)[^\n\r]*\r?\n([\s\S]*?)\r?\n```/gi;
  let match: RegExpExecArray | null;
  let codeBlockError: string | undefined;
  while ((match = codeBlockRegex.exec(rawContent)) !== null) {
    const codeBlockContent = match[1];
    try {
      const parsed = yaml.parse(codeBlockContent);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
        const normalized = normalizeRoadmap(parsed.topics);
        if ('error' in normalized) {
          codeBlockError = normalized.error;
          continue;
        }
        return {
          roadmap: normalized.roadmap,
          format: 'codeblock',
        };
      }
    } catch {
      // Continue searching other code blocks
    }
  }

  // 3. Try Pure YAML parsing
  try {
    const parsed = yaml.parse(rawContent);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
      const normalized = normalizeRoadmap(parsed.topics);
      if ('error' in normalized) {
        return {
          roadmap: null,
          error: normalized.error,
        };
      }
      return {
        roadmap: normalized.roadmap,
        format: 'yaml',
      };
    }
  } catch (e) {
    if (isYamlFile) {
      return {
        roadmap: null,
        error: `Invalid YAML: ${(e as Error).message}`,
      };
    }
  }

  // 4. Wikilink format (#73): Markdown sections of wikilink bullet lists.
  // Each `## Track` section's ordered `[[...]]` items form one dependency chain.
  if (isMdFile) {
    const sections = parseWikilinkSections(rawContent);
    if (sections) {
      return {
        roadmap: null,
        format: 'wikilink',
        sections,
      };
    }
  }

  // 5. Fallback: Return structured codeblock error if found, otherwise missing topics array error
  return {
    roadmap: null,
    error: codeBlockError || 'Roadmap must have a "topics" array.\nSupported formats:\n  • Markdown Frontmatter: ---\n    topics: [...]\n    ---\n  • Markdown YAML Code Block: ```yaml\n    topics: [...]\n    ```\n  • Pure YAML: topics: [...]\n  • Wikilink lists: ## Track\\n    - [[Note One]]\\n    - [[Note Two]]',
  };
}

