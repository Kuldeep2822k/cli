import yaml from 'yaml';
import { parseFrontmatter } from './frontmatter';
import { RoadmapFile, RoadmapTopic } from '../types';

export interface ParsedRoadmapResult {
  roadmap: RoadmapFile | null;
  format?: 'yaml' | 'frontmatter' | 'codeblock';
  error?: string;
}

/**
 * Extracts and parses a Roadmap definition from multiple formats:
 * 1. YAML frontmatter in Markdown (--- \n topics: [...] \n ---)
 * 2. Embedded YAML code block in Markdown (```yaml \n topics: [...] \n ```)
 * 3. Pure raw YAML content
 */
export function parseRoadmapContent(rawContent: string, filePath?: string): ParsedRoadmapResult {
  const isMdFile = filePath ? /\.(md|markdown)$/i.test(filePath) : false;
  const isYamlFile = filePath ? /\.(ya?ml)$/i.test(filePath) : false;

  // 1. If it's a Markdown file or contains frontmatter delimiters, try frontmatter first
  if (isMdFile || rawContent.trimStart().startsWith('---')) {
    try {
      const { frontmatter } = parseFrontmatter(rawContent);
      if (frontmatter && Array.isArray(frontmatter.topics)) {
        return {
          roadmap: { topics: frontmatter.topics as RoadmapTopic[] },
          format: 'frontmatter',
        };
      }
    } catch {
      // Continue to next format check
    }

    // 2. Try Embedded YAML Code Blocks in Markdown
    const codeBlockRegex = /```(?:ya?ml)\r?\n([\s\S]*?)\r?\n```/gi;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(rawContent)) !== null) {
      const codeBlockContent = match[1];
      try {
        const parsed = yaml.parse(codeBlockContent);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
          return {
            roadmap: parsed as RoadmapFile,
            format: 'codeblock',
          };
        }
      } catch {
        // Continue searching other code blocks
      }
    }
  }

  // 3. Try Pure YAML parsing
  try {
    const parsed = yaml.parse(rawContent);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
      return {
        roadmap: parsed as RoadmapFile,
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

  // 4. If not resolved yet, check code blocks in any text format
  const codeBlockRegex = /```(?:ya?ml)\r?\n([\s\S]*?)\r?\n```/gi;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(rawContent)) !== null) {
    const codeBlockContent = match[1];
    try {
      const parsed = yaml.parse(codeBlockContent);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.topics)) {
        return {
          roadmap: parsed as RoadmapFile,
          format: 'codeblock',
        };
      }
    } catch {
      // Continue
    }
  }

  // 5. Fallback: No valid topics array found
  return {
    roadmap: null,
    error: 'Roadmap must have a "topics" array.\nSupported formats:\n  • Markdown Frontmatter: ---\n    topics: [...]\n    ---\n  • Markdown YAML Code Block: ```yaml\n    topics: [...]\n    ```\n  • Pure YAML: topics: [...]',
  };
}
