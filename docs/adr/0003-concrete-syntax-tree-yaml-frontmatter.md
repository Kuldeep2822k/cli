# ADR-0003: Non-Destructive Frontmatter Updates via YAML CST

## Status
Accepted

## Context
PALEE stores metadata (mastery scores, SM-2 parameters, topic IDs, dependencies) inside Markdown frontmatter headers (`---\n...\n---`). Users frequently customize their notes with YAML comments, custom tags, custom properties (Dataview, Obsidian properties), and multi-line block scalars.

Standard YAML parsers (e.g. `JSON.parse`, basic string splitters, or naive YAML dumpers) reorder keys, strip comments, and format scalars destructively.

## Decision
We utilize the `yaml` package's Concrete Syntax Tree (CST) document manipulation API in `src/storage/frontmatter.ts`.

Key design choices:
1. Parse the extracted frontmatter block into a CST `Document` using `parseDocument(raw)`.
2. Apply mutations only to explicit PALEE managed keys using `doc.set(key, value)`.
3. Call `doc.toString()` to serialize the updated YAML header while preserving:
   - Existing comments and indentation.
   - Key ordering and unknown custom metadata.
   - Exact Markdown body content byte-for-byte.

## Consequences
- **Positive**:
  - Guarantees 100% preservation of user-authored comments and custom frontmatter properties.
  - Seamless interoperability with Obsidian plugins, Dataview, and frontmatter schemas.
- **Negative / Tradeoffs**:
  - Slight CPU overhead parsing CST compared to regex replacement, mitigated by memory caching.
