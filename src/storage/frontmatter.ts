import { parseDocument } from 'yaml';
import crypto from 'crypto';
import { FrontmatterResult, NodeError } from '../types';

/**
 * Frontmatter Parser & Updater using YAML CST
 * Preserves comments, ordering, unknown keys, block scalars
 */

function parseFrontmatter(content: string): FrontmatterResult {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  if (!fmMatch) {
    return { frontmatter: null, body: content, raw: null };
  }

  const raw = fmMatch[1];
  const body = fmMatch[2];

  try {
    const doc = parseDocument(raw);
    const frontmatter = doc.toJSON() as Record<string, unknown>;
    return { frontmatter, body, raw, doc };
  } catch (e: unknown) {
    const err = e as NodeError;
    return { frontmatter: null, body, raw, error: err.message };
  }
}

function updateFrontmatter(content: string, updates: Record<string, unknown>): string {
  const parsed = parseFrontmatter(content);

  if (!parsed.frontmatter) {
    const newFm = { ...updates };
    const yamlContent = Object.entries(newFm)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    return `---\n${yamlContent}\n---\n${content}`;
  }

  // Parse as YAML document to preserve CST
  const doc = parseDocument(parsed.raw!);

  // Update only specified keys
  for (const [key, value] of Object.entries(updates)) {
    doc.set(key, value);
  }

  const newYaml = doc.toString();
  return `---\n${newYaml}---\n${parsed.body}`;
}

function computeFingerprint(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export {
  parseFrontmatter,
  updateFrontmatter,
  computeFingerprint,
};
