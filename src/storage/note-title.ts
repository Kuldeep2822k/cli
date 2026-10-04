/**
 * Note Title Resolution
 *
 * @remarks
 * Hierarchical display-title extraction for Markdown notes. Used by `adopt`
 * (single-file and batch) and by wikilink roadmap resolution (#73) when an
 * unadopted note needs a title minted from its content.
 */

import path from 'path';
import { parseFrontmatter } from './frontmatter';
import { stripFencedCodeBlocks } from '../engine/auto-chain';

/**
 * Resolves the display title for a Markdown note using hierarchical fallback strategies.
 *
 * @param content - Full text content of the note
 * @param filePath - Optional file path for basename fallback
 * @param parsedFrontmatter - Optional pre-parsed frontmatter dictionary
 * @returns Extracted display title string, falling back to 'Untitled'
 *
 * @remarks
 * Evaluation priority:
 * 1. Existing frontmatter `title` field (if defined, non-empty string, number, or boolean).
 * 2. First level-1 Markdown heading (`# Title`) in body, stripping comments and code fences.
 * 3. Note filename without `.md` extension.
 * 4. Fallback string `'Untitled'`.
 *
 * @example
 * ```typescript
 * const title = resolveNoteTitle('# Dynamic Systems\n\nNotes...', '/vault/notes/systems.md');
 * console.log(title); // 'Dynamic Systems'
 * ```
 */
export function resolveNoteTitle(
  content: string,
  filePath?: string,
  parsedFrontmatter?: Record<string, unknown> | null
): string {
  let frontmatter = parsedFrontmatter;
  let bodyContent: string;

  if (frontmatter === undefined) {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    bodyContent = parsed.body;
  } else {
    bodyContent = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, '');
  }

  // Tier 1: Existing frontmatter title
  if (frontmatter && frontmatter.title !== undefined && frontmatter.title !== null) {
    if (typeof frontmatter.title === 'string') {
      const cleanFmTitle = frontmatter.title.replace(/\r?\n/g, ' ').trim();
      if (cleanFmTitle.length > 0) {
        return cleanFmTitle;
      }
    } else if (typeof frontmatter.title === 'number' || typeof frontmatter.title === 'boolean') {
      const cleanFmTitle = String(frontmatter.title).trim();
      if (cleanFmTitle.length > 0) {
        return cleanFmTitle;
      }
    }
  }

  // Tier 2: First H1 heading (# Title) in body
  // Strip HTML comments
  let sanitizedBody = bodyContent.replace(/<!--[\s\S]*?-->/g, '');
  // Strip fenced code blocks (``` and ~~~) so a `# heading` inside an example
  // is never minted as this note's title
  sanitizedBody = stripFencedCodeBlocks(sanitizedBody);

  const h1Match = sanitizedBody.match(/^[ \t]{0,3}#[ \t]+([^#\r\n].*?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/m);
  if (h1Match && h1Match[1]) {
    const cleanH1 = h1Match[1].trim();
    if (cleanH1.length > 0) {
      return cleanH1;
    }
  }

  // Tier 3: Filename fallback
  if (filePath) {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    if (basename.trim().length > 0) {
      return basename.trim();
    }
  }

  return 'Untitled';
}
