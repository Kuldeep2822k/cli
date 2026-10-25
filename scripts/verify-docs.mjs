#!/usr/bin/env node
/**
 * Guards the documentation invariants that the VitePress build cannot see:
 * reachability, the ADR index, page metadata, and the formatting rules the
 * docs audit established. Run after `docs:build` in CI.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const docs = join(root, 'docs')
const errors = []

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

const pages = walk(docs)
  .filter((path) => !path.split(sep).includes('.vitepress'))
  .sort()
const byRelative = new Map(pages.map((path) => [relative(docs, path).split(sep).join('/'), path]))

function routeFor(relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/, '')
  return withoutExtension === 'index' ? '/' : `/${withoutExtension}`
}

// Sidebar and nav links are the only hand-maintained navigation surface.
// The home page is reached through the site title, so it has no nav entry.
const config = readFileSync(join(docs, '.vitepress', 'config.mts'), 'utf8')
const links = new Set(
  [...config.matchAll(/\blink:\s*['"]([^'"]+)['"]/g)].map((match) => match[1].replace(/\/$/, '') || '/')
)
for (const relativePath of byRelative.keys()) {
  const route = routeFor(relativePath)
  if (route !== '/' && !links.has(route)) {
    errors.push(`page is not in the nav or sidebar: docs/${relativePath} (${route})`)
  }
}

const adrIndex = readFileSync(join(docs, 'adr', 'README.md'), 'utf8')
for (const relativePath of byRelative.keys()) {
  if (!/^adr\/\d{4}-/.test(relativePath)) continue
  if (!adrIndex.includes(relativePath.split('/').pop())) {
    errors.push(`ADR is missing from docs/adr/README.md: ${relativePath}`)
  }
  const status = readFileSync(byRelative.get(relativePath), 'utf8')
    .match(/^## Status\r?\n\s*(.+)$/m)?.[1]
    ?.trim()
  if (!status || !/^(?:Proposed|Accepted|Superseded by ADR-\d{4})(?: \(\d{4}-\d{2}-\d{2}\))?$/.test(status)) {
    errors.push(`ADR has a non-standard Status line: docs/${relativePath} (${status ?? 'missing'})`)
  }
}

const descriptions = new Map()
for (const [relativePath, path] of byRelative) {
  const source = readFileSync(path, 'utf8')
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) {
    errors.push(`page has no frontmatter: docs/${relativePath}`)
    continue
  }
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!description) {
    errors.push(`page has no description: docs/${relativePath}`)
    continue
  }
  const previous = descriptions.get(description)
  if (previous) {
    errors.push(`duplicate description: docs/${previous} and docs/${relativePath}`)
  } else {
    descriptions.set(description, relativePath)
  }
}

const index = readFileSync(join(docs, 'index.md'), 'utf8')
if (/^\s*svg:/m.test(index)) {
  errors.push('docs/index.md still uses the unsupported icon.svg frontmatter shape')
}

for (const [relativePath, path] of byRelative) {
  const source = readFileSync(path, 'utf8')
  if (/#L\d/.test(source)) {
    errors.push(`line-number citation remains: docs/${relativePath}`)
  }
  if (/<details>|<summary>/.test(source)) {
    errors.push(`raw disclosure block remains: docs/${relativePath}`)
  }
}

if (errors.length > 0) {
  console.error(`Documentation checks failed (${errors.length}):`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(`Documentation checks passed: ${byRelative.size} pages, ${links.size} nav/sidebar links.`)
