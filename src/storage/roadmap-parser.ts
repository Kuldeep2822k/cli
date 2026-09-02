/**
 * Multi-Format Roadmap Parser
 *
 * @remarks
 * Ingests external curriculum and roadmap definitions across multiple syntax representations:
 * 1. YAML frontmatter inside a Markdown file (`--- \n topics: [...] \n ---`)
 * 2. Embedded YAML code block inside a Markdown file (` ```yaml \n topics: [...] \n ``` `)
 * 3. Pure raw YAML files
 */

import yaml from 'yaml';
import { normalizeDependencies } from './dependencies';
import { parseFrontmatter } from './frontmatter';
import { RoadmapFile, RoadmapTopic } from '../types';

/**
 * Result object returned when parsing a roadmap source document.
 */
export interface ParsedRoadmapResult {
  /** Parsed roadmap file payload, or null if unparseable / missing topics */
  roadmap: RoadmapFile | null;
  /** Discovered roadmap source format representation */
  format?: 'yaml' | 'frontmatter' | 'codeblock';
  /** Error diagnostic message if parsing failed */
  error?: string;
}

type RawRoadmapTopic = Omit<RoadmapTopic, 'depends_on'> & {
  depends_on?: unknown;
  dependencies?: unknown;
};

function normalizeRoadmap(topics: RawRoadmapTopic[]): RoadmapFile {
  return {
    topics: topics.map((topic) => {
      const { depends_on, dependencies, ...fields } = topic;
      if (depends_on === undefined && dependencies === undefined) {
        return fields;
      }
      return {
        ...fields,
        depends_on: normalizeDependencies(depends_on, dependencies),
      };
    }),
  };
}

/**
 * Extracts and parses a curriculum roadmap definition from Markdown frontmatter, YAML codeblocks, or raw YAML.
 *
 * @remarks
 * Evaluates roadmap content across three formats in order:
 * 1. Markdown YAML frontmatter block (`---`).
 * 2. Embedded YAML code fences (` ```yaml `).
 * 3. Raw pure YAML documents.
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
      return {
        roadmap: normalizeRoadmap(fmResult.frontmatter.topics as RawRoadmapTopic[]),
        format: 'frontmatter',
      };
    }
  }

  // 2. Try Embedded YAML Code Blocks (supports whitespace or info strings after language tag)
  const codeBlockRegex = /```(?:ya?ml)[^\n\r]*\r?\n([\s\S]*?)\r?\n```/gi;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(rawContent)) !== null) {
    const codeBlockContent = match[1];
    try {
      const parsed = yaml.parse(codeBlockContent);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
        return {
          roadmap: normalizeRoadmap(parsed.topics as RawRoadmapTopic[]),
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
      return {
        roadmap: normalizeRoadmap(parsed.topics as RawRoadmapTopic[]),
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

  // 4. Fallback: No valid topics array found
  return {
    roadmap: null,
    error: 'Roadmap must have a "topics" array.\nSupported formats:\n  • Markdown Frontmatter: ---\n    topics: [...]\n    ---\n  • Markdown YAML Code Block: ```yaml\n    topics: [...]\n    ```\n  • Pure YAML: topics: [...]',
  };
}

