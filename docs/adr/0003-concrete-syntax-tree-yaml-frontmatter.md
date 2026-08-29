# ADR-0003: Non-Destructive Frontmatter Updates via YAML Document API

## Status
Accepted

## Context
PALEE stores metadata (mastery scores, SM-2 parameters, topic IDs, dependencies) inside Markdown frontmatter headers (`---\n...\n---`). Users frequently customize their notes with YAML comments, custom tags, custom properties (Dataview, Obsidian properties), and multi-line block scalars.

Standard YAML parsers (e.g. `JSON.parse`, basic string splitters, or naive YAML dumpers) reorder keys, strip comments, and format scalars destructively.

## Decision
We utilize the `yaml` package's Document manipulation API in `src/storage/frontmatter.ts`.

Key design choices:
1. Parse the extracted frontmatter block into a YAML `Document` using `parseDocument(raw)`.
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
  - Slight CPU overhead parsing YAML Documents compared to naive string matching, mitigated by memory caching.

## Alternatives Considered

1. **`gray-matter` / `js-yaml` Full Serialization**:
   - *Description*: Popular YAML frontmatter parser returning plain JavaScript objects and reserializing via `js-yaml.dump()`.
   - *Pros*: Ubiquitous in JavaScript static site generators.
   - *Why Rejected*: Deserializes frontmatter into a plain JS object and reserializes via `js-yaml.dump()`. This strips user-authored YAML comments, reformats multi-line strings destructively, reorders properties, and modifies whitespace in the Markdown body.

2. **Regular Expression / Naive Substring Replacement**:
   - *Description*: Finding and replacing specific keys like `topic_mastery: 0.8` using regex substitution.
   - *Pros*: Minimal CPU overhead.
   - *Why Rejected*: Extremely brittle when handling multi-line lists (e.g. `depends_on: [A, B]`), nested YAML objects, inline comments, or escaped characters.

3. **Sidecar JSON Metadata Files (`.palee/metadata/<id>.json`)**:
   - *Description*: Keeping notes 100% pure markdown and storing all PALEE metadata in sidecar files.
   - *Pros*: Zero frontmatter modifications to user notes.
   - *Why Rejected*: Breaks user visibility and interoperability with Obsidian plugins (Dataview, Breadcrumbs, Properties view) that rely on standard note frontmatter.


