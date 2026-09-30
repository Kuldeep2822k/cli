# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (feat)

- **Tier-0 hygiene filters for `adopt --auto-chain`** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205)): before any note is ordered into a chain, it is classified as `backbone`, `leaf`, or `excluded` by new fs-free predicates in `src/engine/tier0-hygiene.ts`. Repo-meta notes (`LICENSE`, `CONTRIBUTING`, `CHANGELOG`, `CODE_OF_CONDUCT`, `SECURITY`, …), translation copies (a `translations/` path segment, or a locale suffix on a generic doc name such as `README.ko-KR.md`, `README-zh-Hans.md`, `README.cn.md`) and template notes are excluded — they are neither adopted nor chained, while a locale suffix on any other name (`assignment.es.md`) is only a guess about language and demotes the note to a leaf, so `LICENSE.md` can no longer become a prerequisite of lesson 1. Everything inside a phase directory (`solution/`, `your-work/`, `start/`, `sketch/`, `answers/`) collapses to leaves, and inside a directory only content docs (README-class, numeric-prefixed, or `deep-dive|lab|exam|assignment|quiz|solution`-prefixed) join the backbone, so ad-hoc siblings such as `for-teachers.md` are attached to the chain instead of gating it — non-gating as a statement about the numbered tree, which is what the classifier decides; under `toc`/`full` the enumeration can still place such a leaf ahead of the notes listed after it, and it is the advisory `toc` label, not the classifier, that stops that edge gating. The safe failure direction is always demote-to-leaf: a name that might be a programming language (`guide-js.md`) or a subject (`01-os.md`) stays a lesson. A `palee_id` that is truthy but not a usable string (e.g. `palee_id: 12345`) is skipped with a counted reason rather than becoming an unsatisfiable predecessor that silently blocks the rest of the chain; its frontmatter is left untouched. The dry-run and confirmation screens now print backbone, leaf, and per-rule skip counts, and the alphabetical-order warning names how many notes it affects with up to three example paths — the signal that a vault needs `--exclude`.
- **Tiered chain sources with a TOC tier** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73), on top of Tier-0 hygiene PAL-205-B):
  - `palee adopt --auto-chain --chain-tier <strict|toc|full>` (default `strict`): chaining now composes two sources — the numbered tree (via Tier-0 hygiene) and, for notes the numbering does not cover, the repo's own enumeration read from `README.md`/`SUMMARY.md` documents (root plus module READMEs). Markdown links in document order become the chain: folder links resolve to `<dir>/README.md`, trailing slashes are tolerated and deduped, `#anchors` are stripped, `%20` is decoded with no raw-name fallback, `<angle bracket paths>` parse, links resolve relative to their TOC file then fold lexically, `..` escapes are rejected through the shared `isWithinVault` guard, case-variant targets resolve to the real file, ambiguous or missing targets are skipped fail-closed and counted, and backslashes stay literal characters. A TOC chain is cycle-free by construction and re-verified in code on every plan.
  - **Numbering dominance (C2)**: where a note lives in the numbered tree, numbering wins even if a README enumerates otherwise; the TOC tier only ever speaks for the unnumbered remainder.
  - **C1 phase ordering** (landed jointly with the PAL-205-B rework, which carries the numbered-side fix): inside the hygiene planner a directory leads with its README-class doc, then numeric lessons, then `deep-dive → lab → exam`, then remaining docs, with `assignment/quiz/solution` LAST so homework never gates lessons; an alphabetical transition between unnumbered sibling directories no longer gates at all (each opens its own chain), and the TOC run applies the same rank order via `planTocChain`. The public `compareLessonOrder` shipped by Work Order A is intentionally untouched.
  - **Honest refusal (C4)**: when the scope states no order this tier can chain, the CLI prints an `Auto-chain: 0 edges …` line and exits `0` instead of fabricating alphabetical prerequisites — *An enumeration that chains nothing is a refusal, not a success* under *Changed* carries the two wordings it prints today. `strict` limits chaining to the numbered tree and never consumes TOC edges; an unknown tier value is a usage error (exit `2`).
  - **`depends_on_source` (C5)**: each auto-chained note with a written edge carries an additive optional frontmatter label — `numbered`, `toc`, `declared`, or `tie` — on `palee_schema: 1`. Old PALEE builds parse files written by this build unchanged (unknown keys are preserved, never rejected); the label now decides gating — see *Enumeration order no longer gates* below.
  - **TOC heads never erase justified edges (rework of C-defect-1)**: a TOC chain head keeps an existing structurally-justified numbered predecessor (only a cycle-forming keep is dropped, where the predecessor sits downstream in the enumeration itself), so a README enumerating a single note no longer loses the `README → lesson` edge scored in ciu/math/Web-Dev; the honest-refusal line now only appears when the scoped enumeration resolves no TOC link at all and the plan writes zero edges.
- **Dependency auto-chaining & wikilink roadmap resolution** ([#73](https://github.com/Kuldeep2822k/cli/issues/73)):
  - `palee adopt --auto-chain`: batch-only flag that derives each note's `depends_on` from numbered directory/file prefixes (numeric → `deep-dive → lab → exam` → alphabetical), bridges modules and excluded/already-adopted notes, and validates the planned graph — merged with existing vault topics — for cycles before any write (exit `3`, zero writes on failure). A numeric prefix is only a lesson number when a separator or the end of the name follows it and it spans at most three digits, so `3d-printing.md` and `2024-recap.md` chain as unnumbered notes instead of claiming lessons 3 and 2024. `--dry-run` prints exactly the edges the commit will write and lists already-adopted notes separately as bridged predecessors; a rejected cycle is reported by vault-relative path with `palee validate` named as the fix path. Already-adopted notes are never rewritten. Conflicts with `--depends-on` and single-file mode (exit `2`).
  - `palee roadmap --auto-chain`: chains YAML/frontmatter/codeblock roadmap topics by their `order` field (unordered topics keep file order, appended after ordered ones); explicit non-empty `depends_on` always wins. A synthesized edge that would close a cycle against an authored dependency is skipped with a warning and the topic starts a new chain, so the remaining roadmap still imports. The summary counts the edges this pass actually synthesized — `Auto-chain: N chain edge(s) synthesized across M roadmap topics.` — rather than reporting every topic as chained, and prints only after graph validation passes; edges dropped to keep the graph acyclic are reported separately.
  - Wikilink roadmap format: a Markdown roadmap of headings + bullet/numbered `[[links]]` resolves each link to a vault note (exact path, then unique basename; anchors stripped) and chains per section. The document must declare itself: the format is recognised only when its frontmatter sets `palee_roadmap: true`. Ambiguous or unresolvable links fail closed (exit `3`, zero writes).
- **A note's own prerequisites now author its edges** ([PAL-205](https://github.com/Kuldeep2822k/cli/issues/205)): `palee adopt --auto-chain` reads each note's text before inferring anything about it. A `## Prerequisites` section (also `## Requires`, `## Required knowledge`, `## Depends on`) contributes its wikilinks and markdown links, and a "requires knowledge of X" sentence contributes X — resolved against the notes this batch can point at, by exact vault-relative path or by unique basename. A unique hit is written as `depends_on` with `depends_on_source: declared`, and it **replaces** that note's inferred edge rather than joining it: one provenance label covers a note's whole list, so keeping an inferred `toc` edge beside a declared one would silently promote an enumeration guess into a gate. Several declared names fan in. A name matching nothing, or matching several notes, is a counted skip and the note keeps the edge the numbered tree justified. A `## Prerequisites` block inside a fenced example, an escaped `\[[link]]`, a task-list checkbox, and a heading that merely starts with the trigger phrase (`## Prerequisites for the lab`) all declare nothing. Two notes naming each other is a cycle, refused by the existing pre-write check with exit `3` and zero writes. The report prints `Declared: N edge(s) from the notes' own prerequisite text` with the count of declarations it could not read.

### Fixes (fix)

Found verifying the PAL-205-B/C review rounds; each was reproduced against the shipped code before being changed.

- **`--include`/`--exclude`/`--tag` no longer let an excluded note into the chain** ([#73](https://github.com/Kuldeep2822k/cli/issues/73), INV-46): the batch scan tested "already adopted" before applying the filters, so every adopted note in scope joined the planner and the next new lesson was written with a `depends_on` edge to the note `--exclude` was run to drop. `palee adopt MODULES --auto-chain --exclude "*draft*"` persisted an edge to `draft`; now the planner sees only the notes that passed the filters, and the exclusion holds for the graph as well as for the writes.
- **A fenced example can no longer rewrite a roadmap or mint a title** ([#73](https://github.com/Kuldeep2822k/cli/issues/73), INV-48): the two copies of the fence-matching regex let a ` ``` ` block close on a `~~~` line and vice versa, so a document of the form ` ```markdown … ~~~ … ``` ` ended its example early and everything after the wrong marker was read as real. In a marked wikilink roadmap that turned an example `[[Ghost]]` bullet into a chain entry and rewrote that note's `depends_on`; in title resolution it let a `# heading` inside an example become the note's stored title. One shared line-based stripper now honours the CommonMark rules — same character, closing run at least as long, no trailing text, and an unclosed fence running to end of file — and it is applied to `README`/`SUMMARY` TOC extraction too.
- **A differently-cased wikilink no longer overwrites an adopted note's `palee_id`** ([#73](https://github.com/Kuldeep2822k/cli/issues/73), INV-48): on a case-insensitive volume `fs.realpathSync` returns the casing as written, so `[[notes/mynote]]` against a stored `Notes/MyNote.md` resolved to a path string that missed the adopted-topic lookup — the importer then minted a fresh id and wrote it over the learner's existing one, and the same note listed under two casings evaded duplicate-target detection and chained onto itself. Resolved paths are now re-spelled from the vault walk's own index, so path identity has a single source; `dev:inode` was rejected as the key because it collapses to `dev:0` on FAT/exFAT and cloud-synced volumes, and case twins (`Case.md` beside `MODULES/case.md`) stay distinguishable.
- **`\[[Alpha]]` is literal text, not a link** ([#73](https://github.com/Kuldeep2822k/cli/issues/73), INV-48): an escaped bracket renders as a wikilink rather than activating one, but the extractor matched it anyway, so a roadmap that *documented* a link rewrote that note's prerequisites. A backslash before the opener is now skipped.
- **The auto-chain warning counts the notes it describes** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205), INV-46): it fired on a flag any plan containing a module `README.md` sets, then printed a count taken from the leaf list — a different population that includes numbered notes under phase subtrees and omits unnumbered backbone notes — so a run that had just ordered two ad-hoc siblings alphabetically reported "0 of 2". Count and examples now come from the affected set, with an unnumbered-directory fallback reported separately.
- **The adopt summary reports edges, not a promise** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73), INV-46): the status line claimed every note being adopted was "chained by prefix order", which was wrong under `toc`/`full` (edges came from the enumeration), for every chain head (no edge at all), and for bridged already-adopted notes (never rewritten). It now reports the edges actually written split by authoring tier.
- **`adopt --auto-chain <path>` works again** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73)): declaring the tier as an optional value on the flag made Commander take the next token, so a previously valid form exited `2` having adopted nothing. The tier now lives in `--chain-tier` and the flag is a plain boolean.
- **The TOC tier no longer reports its own ordering as alphabetical** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73), INV-46): `composeTieredChain` returned the hygiene plan's alphabetical claims unchanged, so on a README listing `zeta`, `alpha`, `middle` the adopt screen warned that all three "chain in alphabetical order" and suggested `--exclude` — two lines above a plan reporting `0 numbered, 2 toc` whose edges followed the README exactly. Both claims are now recomputed over the paths the enumeration did not cover; where it covers nothing the recomputation is the identity, so `strict` is unchanged.
- **The vault root no longer trips the unnumbered-directory flag** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205), INV-46): the root group's sort key is the unnumbered `'.'` sentinel, so any vault holding a note at the root plus one directory reported an alphabetical fallback that never happened — the root's position is the hygiene plan's deliberate hoist (PAL-205-G2). Measured before the fix, `README.md` alongside `01-a/01-x.md` and `02-b/01-y.md`, a fully numbered curriculum, warned anyway. The level test is now the shared `directoriesOrderedAlphabetically` predicate, which skips the root; genuine fallbacks still report (`alpha/` beside `beta/`, with or without a root note).
- **Directory comparison consults only the level that decides the order** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205), INV-46): the flag collected every group's segment at each depth, so `01-a/deep-dive/01-x.md` beside `02-b/lab/01-y.md` reported an alphabetical fallback — level 1 does hold two unnumbered names — even though `compareDirs` had already settled that pair at `01`/`02` and never looked deeper. The walk now partitions by the current segment and answers there when siblings differ, descending only while a single name owns the level; a genuine deeper fallback (`01-a/deep-dive` beside `01-a/lab`, or `src/algorithms/caesar` beside `src/algorithms/hill`) still reports.

### Changed
- **Enumeration order no longer gates** ([#205](https://github.com/Kuldeep2822k/cli/issues/205)): `depends_on` edges that came from a listing document's order (`depends_on_source: toc`) are now advisory. `palee plan` still ranks by them and `palee validate` still detects cycles through them, but they never hide a note from the ready list — a note chained after another in a `README` enumeration is offered immediately instead of waiting for that note to reach 70% mastery. Numbered-tree edges (`depends_on_source: numbered`, or a note you wrote yourself) are unchanged and still gate; a same-rank tie inside one directory is labelled `tie` and is advisory on the same reasoning. This is a containment change, not a deletion: adjudicating 127 TOC-tier edges against the content of the notes they join, 97 (76.4%) were not prerequisites, and because no v0.5.x command raises `topic_mastery` a single such edge locked its note away permanently.
- **`palee adopt --auto-chain` now defaults to `--chain-tier strict`**: a bare `--auto-chain` chains the numbered tree only (the clean figure measured for that tier is enumeration fidelity — how exactly it reproduces the numbering the author already wrote — not a prerequisite audit, and the 127-edge census above is the enumeration tier's, so no false-edge count is claimed for `strict`); chaining a repository's `README`/`SUMMARY` enumeration now has to be asked for with `--chain-tier toc` or `--chain-tier full`. Notes already chained by the enumeration in an earlier run keep their edges, and they are advisory now either way, so re-adopting is not required.
- **A same-number tie is reported, labelled `tie`, and no longer gates**: two notes in one directory carrying the same numeric prefix (`02-a.md` and `02-b.md`, or `lab-a.md` and `lab-b.md`) were ordered between themselves by their filenames, while the report described the plan as numbered and named nothing. The dry-run now says `1 of 2 planned notes have the same number or phase as the note before them, so the order between them is alphabetical` and names the path, and that edge is written as `depends_on_source: tie` — advisory, like a `toc` edge: it still ranks the note and still takes part in cycle detection, but it no longer holds the note off the ready list. The tree declined to order a tied pair, so a filename collation is not a prerequisite claim. Genuinely unnumbered notes keep their existing warning and are not double-counted. **A vault adopted before this change is not retroactively unlocked**: those notes stored the tie as `depends_on_source: numbered`, which cannot be told apart from a numbering-decided edge without re-deriving the plan, and `adopt` never rewrites an already-adopted note. Relabelling stored ties is tracked separately; until then this applies to edges written from now on.
- **Homework no longer opens the next module**: the bridge into a module used to attach to the previous module's final backbone note, and placing `assignment|quiz|solution` last inside a directory — the rule that stops a lesson depending on its own homework — made that note the homework. So `02-search/01-b` was gated behind `01-foundations/assignment.md`: 48 of the 88 measured ML-For-Beginners edges and 29 of 72 in Web-Dev. The cross-directory bridge now uses the group's last non-homework backbone, and a module whose only backbone is homework opens a new chain instead of handing its assignment to everything downstream. Homework still follows the lesson it assesses inside its own directory, and a directory that collapses to leaves still passes the bridge through unchanged.
- **An enumeration that chains nothing is a refusal, not a success**: a README whose links all resolve to notes this tier will not order (a `solution/` subtree, a translation copy) used to print `Auto-chain: enabled (full tier — 0 edge(s) written)` and withhold the pointer this vault needs, because the refusal was keyed off the presence of links rather than the edges they produced. It is now keyed off what the plan can chain, and the two ways that can fail say which one happened: `0 edges (no numbered layout, no chainable order signal) — consider palee roadmap` when the vault states no order, and `0 edges (no numbered layout; --chain-tier strict does not read a README enumeration) — try --chain-tier toc` when an enumeration is there but the selected tier declines it. That second line is a promise, so it is keyed to the notes an enumeration offers rather than its links: one lesson reachable under two spellings (`guide/only.md` and `./guide/only.md`) is one candidate, and `--chain-tier toc` deduplicates to a lone chain head that writes no edge — advising it there would trade the roadmap pointer for a second refusal.
- **Wikilink roadmap detection requires `palee_roadmap: true`**: `palee roadmap --from <note.md>` no longer imports a Markdown document that does not explicitly mark itself as a roadmap. Previously any `.md` with a heading and one `[[...]]` bullet was classified as a wikilink roadmap, so pointing `--from` at an ordinary note imported its outbound links and rewrote `depends_on` on every note it linked to. Such a file is now rejected with exit `2` and zero writes; add `palee_roadmap: true` to the frontmatter of a genuine wikilink roadmap. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))

### Documentation & Maintenance (docs)

- **INV-46/47 restated; auto-chain docs aligned with landed behavior** ([PAL-205-D](https://github.com/Kuldeep2822k/cli/issues/205)): `planning/invariants.md` INV-46 now carries three binding sub-clauses — Tier-0 hygiene (classification contract, `paleeIdOf` scan/plan agreement, demote-never-fabricate failure direction, mandatory report counts), tier composition and precedence (hygiene above both tiers, structure-justified cross-directory gating, numbering dominance, TOC edges replace rather than add, `depends_on_source` provenance), and the honest-refusal path (exit `0` with zero fabricated edges when no order signal exists; unjustified transitions open their own chain); the never-rewrite rule stays in the INV-46 parent clause. INV-47 states the cycle-skip rule and that the chained-count counts only edges actually synthesized. Command docs corrected against heads `27ab870`/`9ac6690`: cross-module bridging qualified to justified transitions, `toc` documented as currently producing identical plans to `full`, the hygiene report-block description completed (invalid-`palee_id` count, nothing-left-to-chain pointer, tier and TOC-edge count on the `Auto-chain:` line), and `solutions/` added to the PAL-205-B phase-directory list. Second pass rebased onto final C head `0d10120`: INV-46 now states the owner-ruled vault-root bridge and the C-defect-1 refusal condition (no-signal only when the scoped enumeration resolves no TOC link and the plan writes zero edges); INV-47 quotes the final A6 summary line `Auto-chain: N chain edge(s) synthesized across M roadmap topics.`; the unnumbered-warning wording is unified with feat/73-auto-chain@900b3ec (warning fires only where alphabetical order actually decides); TOC skipped-link counts are documented as plan-data-only with a `--verbose` follow-up; and two carried nits are recorded as known issues — the B6 alphabetical-warning seam above a true-refusal plan, and badge-wrapped TOC links (`[![x](i.png)](t.md)`) parsing `missing` fail-closed. Docs-only; no behavior changed.

---

## [0.5.2] - 2026-09-19

### Fixes (fix)

- **Scanner unclosed-fence heuristic & frontmatter parser robustness**:
  - Detected when Markdown body text is accidentally swallowed into frontmatter due to an unclosed opening fence followed by a thematic break (`hasBodyTextLines`), checking for headings, blockquotes, lists, and non-mapping colons. ([#171.11](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
  - Supported quoted YAML mapping keys containing colons (e.g. `"custom: property": value`, `'other: property': value`, and escaped quotes). ([#188](https://github.com/Kuldeep2822k/cli/pull/188))
  - Supported unquoted YAML keys with spaces (e.g. `display name: Mathematics`), slashes (e.g. `schema/url: ...`), non-ASCII characters (e.g. `pré-requis: ...`), and arbitrary custom lengths without false-positive body text classification. ([#188](https://github.com/Kuldeep2822k/cli/pull/188))
  - Preserved `raw` and `body` in `parseFrontmatter` for whitespace-only fenced blocks (e.g. `---\n\n---`) so `updateFrontmatter` replaces them in-place instead of prepending duplicate fence blocks. ([#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Exception safety in validation rule runner**: wrapped rule execution in `runRules` in try/catch blocks so rule crashes become structured validation findings (`field: 'rule-execution'`) rather than exit-5 crashes; guarded non-Error thrown values whose string conversion fails so subsequent rules continue executing. ([#171.10](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation barrel export order aligned**: rewrote `src/validation/index.ts` to export all 19 validation rules in exact registration order matching `src/cli/validate.ts`, verified by public barrel census tests. ([#171.9](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validate legacy `dependencies` alias with migration advisory**: `valid-dependency-list` rule now validates the legacy `dependencies` key so the validator matches what the loader consumes, emitting an advisory warning to migrate to `depends_on` alongside full shape/self-ref/duplicate diagnostics for malformed values. ([#171.2](https://github.com/Kuldeep2822k/cli/issues/171), [#181](https://github.com/Kuldeep2822k/cli/issues/181), [#187](https://github.com/Kuldeep2822k/cli/pull/187))

### Documentation & Maintenance (docs)

- **Document legacy `dependencies` alias advisory**: updated `valid-dependency-list` rule metadata, documentation (`docs/02-3-reporting-commands.md`), and Mermaid diagrams to reflect the advisory warning when `dependencies` is present on a topic note. ([#187](https://github.com/Kuldeep2822k/cli/pull/187))

---

## [0.5.1] - 2026-09-18

### Fixes (fix)

- **Report every dependency cycle, not just the first**: `no-dependency-cycle` rule switched to `detectCyclesBounded` (cap 1000); disjoint and overlapping cycles all surface. Truncation finding emitted when cycles exceed bound. ([#171.3](https://github.com/Kuldeep2822k/cli/issues/171), [#184](https://github.com/Kuldeep2822k/cli/pull/184))
- **Prevent canonical session deletion during derived-view rebuild**: removed 4 `unlinkSync` sites in `regenerateIndex`/`rebuildHotAndIndex` — derived views must never mutate source data. Draft sessions now excluded from hot memory rebuild. ([#171.7](https://github.com/Kuldeep2822k/cli/issues/171), [#185](https://github.com/Kuldeep2822k/cli/pull/185))
- **Preserve native `assessed_at` type through adopt/loader round-trip**: numeric epoch-ms values normalized to ISO 8601 via `normalizeAssessedAt()`; progress handles numeric-zero `assessed_at` correctly. ([#171.4](https://github.com/Kuldeep2822k/cli/issues/171), [#186](https://github.com/Kuldeep2822k/cli/pull/186))
- **Strip leading BOM so frontmatter parses**: Windows editors emit U+FEFF before `---`; BOM now stripped in `parseFrontmatter` so topic notes aren't silently dropped. ([#171.1](https://github.com/Kuldeep2822k/cli/issues/171), [#183](https://github.com/Kuldeep2822k/cli/pull/183))

### Documentation & Maintenance (docs)

- **ADR-0008 review clarifications**: clarify #32 `valid-difficulty` dissolved status and distinguish from #40 (externally-tested only). ([#182](https://github.com/Kuldeep2822k/cli/pull/182))
- **Changelog overhaul**: move v0.5.0 entries out of `[Unreleased]`, condense paragraph-length entries to concise bullet points, and add missing `chore`/`ci` categories.

### Maintenance (chore)

- **Dependency bumps**: `duriantaco/skylos` 4.35.0 → 4.36.1. ([#175](https://github.com/Kuldeep2822k/cli/pull/175))

---

## [0.5.0] - 2026-09-15

### Features (feat)

- **Hot-memory and safe-vault-paths validation rules**: `valid-hot-memory` validates `.palee/hot.md` identity, word cap, and session references; `safe-vault-paths` audits managed paths against vault boundary for traversal and escape attempts. Shared `displayValue` helper fixes `NaN`/`Infinity` rendering in diagnostics. ([#43](https://github.com/Kuldeep2822k/cli/issues/43), [#45](https://github.com/Kuldeep2822k/cli/issues/45), [#166](https://github.com/Kuldeep2822k/cli/issues/166), [#169](https://github.com/Kuldeep2822k/cli/pull/169))
- **Memory-subsystem validation rules**: four rules covering `valid-managed-note-kind`, `valid-session-schema`, `no-session-unknown-topic`, and `valid-session-index`; partial snapshots surface via `read-failure` rather than silently validating. ([#27](https://github.com/Kuldeep2822k/cli/issues/27), [#41](https://github.com/Kuldeep2822k/cli/issues/41), [#42](https://github.com/Kuldeep2822k/cli/issues/42), [#44](https://github.com/Kuldeep2822k/cli/issues/44), [#168](https://github.com/Kuldeep2822k/cli/pull/168))
- **Review-state, review-dates, and dependency-list validation rules**: `valid-review-fields` (SM-2 contract), `valid-review-dates` (ISO date checks), and `valid-dependency-list` (array shape, self-ref, duplicate checks); `no-missing-dependency` findings downgraded to warnings per ADR-0008. ([#33](https://github.com/Kuldeep2822k/cli/issues/33), [#34](https://github.com/Kuldeep2822k/cli/issues/34), [#38](https://github.com/Kuldeep2822k/cli/issues/38), [#39](https://github.com/Kuldeep2822k/cli/issues/39), [#165](https://github.com/Kuldeep2822k/cli/pull/165))
- **Assessment and mastery validation rules**: `valid-assessment-fields` enforces pillar score range and date format; `valid-topic-mastery` warns on drift from engine formula; #40 enforced as command-level regression tests. ([#36](https://github.com/Kuldeep2822k/cli/issues/36), [#37](https://github.com/Kuldeep2822k/cli/issues/37), [#40](https://github.com/Kuldeep2822k/cli/issues/40), [#163](https://github.com/Kuldeep2822k/cli/pull/163))
- **Validation barrel + `--strict` warning escalation**: `src/validation/` public barrel with census test; `palee validate --strict` exits 3 on warnings-only vaults. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#162](https://github.com/Kuldeep2822k/cli/pull/162))
- **Schema, topic-id-format, and status validation rules**: `palee_schema: 1` enforcement, `T-` kebab-case topic ID policy (legacy IDs error), and four-state `status` validation; `adopt` now generates compliant IDs. ([#28](https://github.com/Kuldeep2822k/cli/issues/28), [#29](https://github.com/Kuldeep2822k/cli/issues/29), [#31](https://github.com/Kuldeep2822k/cli/issues/31), [#159](https://github.com/Kuldeep2822k/cli/pull/159))
- **Validation rule framework with first rule catalog**: single-read vault collector, deterministic runner, human/JSON formatters; duplicate-ID, missing-dependency, and cycle checks ported as pure rules with `warning_count`/`warnings[]` JSON support. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#26](https://github.com/Kuldeep2822k/cli/issues/26), [#30](https://github.com/Kuldeep2822k/cli/issues/30), [#158](https://github.com/Kuldeep2822k/cli/pull/158))
- **Multi-cycle enumeration + quarantine in dependency engine**: iterative Tarjan SCC + Johnson-style cycle enumeration; `quarantineCyclicTopics` removes cyclic topics and dependents in O(V+E); bounded display (1000 cycles, `truncated` flag). ([#79](https://github.com/Kuldeep2822k/cli/issues/79), [#157](https://github.com/Kuldeep2822k/cli/pull/157))

### Performance (perf)

- **Parallel test execution + categorized scripts**: full suite ~112s → ~38s; added `test:unit`, `test:fast`, `test:e2e`, `test:fuzz` scripts. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Windows lock-directory stale recovery**: `EPERM`/`EBUSY` on lock-directory removal retried with bounded 5-attempt backoff instead of exit-5 crash. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))

### Fixes (fix)

- **Vault-relative paths through symlinked roots**: `walkVault` resolves root via `realpathSync`; new `relativeVaultPath()` helper keeps paths clean. ([#160](https://github.com/Kuldeep2822k/cli/issues/160), [#161](https://github.com/Kuldeep2822k/cli/pull/161))
- **Engine reads canonical `depends_on` only**: removed legacy `dependencies` alias from `TopicNode` interface. ([#140](https://github.com/Kuldeep2822k/cli/issues/140), [#152](https://github.com/Kuldeep2822k/cli/pull/152))
- **Reject unsupported `palee_schema` in hot.md**: `readHotMemory()` only accepts `palee_schema: 1`; foreign hot.md triggers rebuild (ADR-0007). ([#130](https://github.com/Kuldeep2822k/cli/issues/130))
- **Preserve explicit `0` in SM-2 fields**: `ease_factor`, `interval_days`, `repetition`, `lapses` no longer treated as missing when `0`. ([#127](https://github.com/Kuldeep2822k/cli/issues/127))
- **Normalize `depends_on`/`dependencies` aliases consistently**: unified resolution in `normalizeDependencies` across loader, validator, and roadmap. ([#126](https://github.com/Kuldeep2822k/cli/issues/126))
- **Exit code 4 on OCC conflict in `palee migrate --fix`**: per-note conflicts classified as exit 4; conflict outranks validation. ([#128](https://github.com/Kuldeep2822k/cli/issues/128), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **npm audit fixes applied**. ([#156](https://github.com/Kuldeep2822k/cli/pull/156))
- **Optimize published package files**: updated `.npmignore` to reduce tarball size. ([#173](https://github.com/Kuldeep2822k/cli/pull/173))

### Refactor (refactor)

- **Single shared derivation for roadmap imports**: `resolveTopicUpdates()` is now the single source for both validation and writeback passes. ([#139](https://github.com/Kuldeep2822k/cli/issues/139), [#154](https://github.com/Kuldeep2822k/cli/pull/154))
- **Centralize `hot.md` reads**: `readHotMemory()` in `src/storage/memory.ts` replaces six parse sites in `session.ts`. ([#130](https://github.com/Kuldeep2822k/cli/issues/130), [#145](https://github.com/Kuldeep2822k/cli/pull/145))
- **Injectable `loadTopics` cache**: accepts a dedicated `FileCache<LoadedTopic>` via backward-compatible options overload. ([#129](https://github.com/Kuldeep2822k/cli/issues/129), [#151](https://github.com/Kuldeep2822k/cli/pull/151))
- **Extract `resolveTopicMastery` helper**: consolidated three mastery fallback blocks into one helper with `pillars-first` and `existing-first` modes. ([#127](https://github.com/Kuldeep2822k/cli/issues/127), [#142](https://github.com/Kuldeep2822k/cli/pull/142))
- **Merge duplicate `WalkOptions`**: single interface retaining `followSymlinks` and `excludeDirs`. ([#125](https://github.com/Kuldeep2822k/cli/issues/125), [#132](https://github.com/Kuldeep2822k/cli/pull/132))
- **Centralize exit-code mapping**: `ExitCode` enum and `exitCodeFor()` replace copy-pasted ternaries. ([#128](https://github.com/Kuldeep2822k/cli/issues/128), [#144](https://github.com/Kuldeep2822k/cli/pull/144))

### Documentation & Maintenance (docs)

- **ADR-0008: validation-framework decisions**: records product and architecture decisions for the #25 rule backlog; fixes all dangling references to removed planning docs. ([#170](https://github.com/Kuldeep2822k/cli/issues/170), [#172](https://github.com/Kuldeep2822k/cli/pull/172))
- **Storage barrel census + JSDoc reservations**: complete export census with `@remarks` reservation markers and contract tests. ([#131](https://github.com/Kuldeep2822k/cli/issues/131), [#146](https://github.com/Kuldeep2822k/cli/pull/146))
- **CLI flag documentation alignment**: `next`/`plan` JSDoc and `@example` blocks match registered CLI flags. ([#131](https://github.com/Kuldeep2822k/cli/issues/131), [#146](https://github.com/Kuldeep2822k/cli/pull/146))
- **Phase-2 type reservation**: `Topic`/`Assessment`/`Review`/`Progress`/`Session`/`CompletedSession`/`DraftSession` documented as reserved. ([#125](https://github.com/Kuldeep2822k/cli/issues/125))
- **Changelog condensed**: entries reformatted to Keep a Changelog style. ([#167](https://github.com/Kuldeep2822k/cli/pull/167))

### Maintenance (chore)

- **Workflow security hardening**: permissions, timeouts, and `persist-credentials: false`. ([#143](https://github.com/Kuldeep2822k/cli/pull/143))
- **Remove obsolete planning docs**: Phase 1 sprint logs and checklists deleted.
- **Dependency bumps**: `actions/deploy-pages` 5.0.1, `softprops/action-gh-release` 3.0.3, `actions/configure-pages` 6.0.0, dev-dependencies group updates. ([#148](https://github.com/Kuldeep2822k/cli/pull/148), [#149](https://github.com/Kuldeep2822k/cli/pull/149), [#134](https://github.com/Kuldeep2822k/cli/pull/134), [#133](https://github.com/Kuldeep2822k/cli/pull/133), [#135](https://github.com/Kuldeep2822k/cli/pull/135), [#150](https://github.com/Kuldeep2822k/cli/pull/150))
- **Dead code detector added**: Skylos integration for detecting unused exports as the codebase scales. ([#141](https://github.com/Kuldeep2822k/cli/pull/141))
- **Issue-to-project label sync CI**. ([#141](https://github.com/Kuldeep2822k/cli/pull/141))

### Removed (removed)

- **Lock internals removed from storage barrel**: `HEARTBEAT_INTERVAL` and `STALE_TIMEOUT` pruned from public exports (remain in `src/storage/lock.ts`). ([#131](https://github.com/Kuldeep2822k/cli/issues/131))

---

## [0.4.0] - 2026-08-31

### Features (feat)
- **Storage Layer Isolation & Unified Facade**: Encapsulated all vault filesystem mutations behind `src/storage/index.ts` facade, eliminating raw `fs` calls from CLI handlers. ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **True Session Duration & Timestamp Persistence**: Persisted true start timestamps into `.palee/hot.md` and draft checkpoints with accurate study durations. ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Resilient Multi-Topic Roadmap Batch Ingestion**: Per-topic parse/write exceptions isolated so single malformed notes don't block remaining imports. ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Mermaid Interactive Pan-Zoom Controller**: GitHub-style inline controls, 60 FPS pan-zoom, drag threshold, and full-screen modal. ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116))
- **Automatic Schema Migration (`palee migrate --fix`)**: `--fix` flag upgrades schema-less notes to `palee_schema: 1` atomically. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Custom Vault Traversal Exclusions**: `excludeDirs` option in `walkVault` and `WalkOptions`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Session Draft Checkpoint Invariants**: exit code 2 and `status: 'drafts_pending'` JSON when drafts block `session start`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Flexible Dependency Aliases**: `dependencies` alias supported alongside `depends_on`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Fixes (fix)
- **Review OCC TOCTOU Elimination**: re-read target note before atomic write; emit exit 4 on concurrent modifications. ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Mastery Output & Dashboard Alignment**: standardized `XX.X%` formatting and 62-character ASCII borders. ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Deterministic FileCache Operation**: removed environment bypasses; guaranteed 2,000 ms unsettled horizon. ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **macOS Canonical Path Resolution**: `realpathSync` in `walkVault` and `deleteSessionNote` for macOS symlinked `/var/folders`. ([#122](https://github.com/Kuldeep2822k/cli/pull/122))
- **macOS Draft Delete Test Stub**: updated stub to match draft ID substring for realpath targets. ([#123](https://github.com/Kuldeep2822k/cli/pull/123))
- **Config Resilience & Atomic Saves**: `SyntaxError` recovery in `loadConfig()` with atomic `saveConfig()`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Timezone-Safe Due Date Computation**: fixed negative-UTC-offset date calculation and 2-digit year guard. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Atomic Write Concurrency**: cryptographic random entropy in temporary filenames. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **CST Document Frontmatter Formatting**: unified serialization using `Document` CST for clean YAML block lists. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Duplicate Topic ID Dependency Graph Retention**: merged dependencies from duplicate notes for complete edge connectivity. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **CLI Fatal JSON Formatting**: structured JSON error on unhandled rejections with `--json`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Maintenance & CI (chore)
- **npm OIDC Trusted Publishing & Provenance**: tokenless npm OIDC publishing with build provenance attestations. ([#124](https://github.com/Kuldeep2822k/cli/pull/124))
- **CodeRabbit Code Review Hardening**: signal handling, CI budget tolerance, and JSDoc fixes. ([#120](https://github.com/Kuldeep2822k/cli/pull/120))

---

## [0.3.1] - 2026-08-23

### Fixed
- **NPM Readme Asset Resolution**: Fixed README logo URL pointing to raw GitHub asset for npm registry rendering.

### Changed
- **CI / CD Action Version Upgrades**: Bumped GitHub Actions dependencies ([#99](https://github.com/Kuldeep2822k/cli/pull/99), [#100](https://github.com/Kuldeep2822k/cli/pull/100), [#101](https://github.com/Kuldeep2822k/cli/pull/101), [#102](https://github.com/Kuldeep2822k/cli/pull/102)).

---

## [0.3.0] - 2026-08-20

### Added
- **Batch Note Adoption (`palee adopt`)**: Recursive directory and whole-vault adoption with `--dry-run`, `--yes`, `--tag`, `--include`, and `--exclude` glob filters. ([#50](https://github.com/Kuldeep2822k/cli/pull/50), [#74](https://github.com/Kuldeep2822k/cli/pull/74))
- **Multi-Format Roadmap Parser**: Supported pure YAML, frontmatter YAML, and embedded code fence YAML roadmaps. ([#112](https://github.com/Kuldeep2822k/cli/pull/112))
- **Technical Documentation Suite**: 35-chapter VitePress documentation with 53 interactive architecture diagrams, JSDoc specs, and ADRs. ([#108](https://github.com/Kuldeep2822k/cli/pull/108), [#112](https://github.com/Kuldeep2822k/cli/pull/112), [#114](https://github.com/Kuldeep2822k/cli/pull/114))
- **OCC & Lock Conflict Exit Codes**: Distinct exit code 4 on OCC and file lock conflicts. ([#76](https://github.com/Kuldeep2822k/cli/pull/76), [#107](https://github.com/Kuldeep2822k/cli/pull/107))

### Changed
- **CLI Exit Code Standardization**: Replaced `process.exit()` with `process.exitCode` for clean stream flushing. ([#77](https://github.com/Kuldeep2822k/cli/pull/77), [#110](https://github.com/Kuldeep2822k/cli/pull/110))
- **Centralized Vault Validation**: All handlers routed through `validateVaultPath` for uniform checks. ([#78](https://github.com/Kuldeep2822k/cli/issues/78), [#111](https://github.com/Kuldeep2822k/cli/pull/111))
- **Storage Layer Boundary Unification**: Centralized `loadTopics` with in-memory caching and single-pass discovery. ([#98](https://github.com/Kuldeep2822k/cli/pull/98))
- **Shared Mastery Engine Refactoring**: Extracted `MASTERY_THRESHOLD` and unified mastery calculation. ([#85](https://github.com/Kuldeep2822k/cli/pull/85), [#94](https://github.com/Kuldeep2822k/cli/pull/94), [#95](https://github.com/Kuldeep2822k/cli/pull/95), [#106](https://github.com/Kuldeep2822k/cli/pull/106))

### Fixed
- **Archived Topic Exclusion**: Excluded archived topics from global mastery calculation. ([#97](https://github.com/Kuldeep2822k/cli/pull/97))
- **Invalid Date Guard in Progress**: Guarded progress date parsing against invalid dates. ([#96](https://github.com/Kuldeep2822k/cli/pull/96))

---

## [0.2.0] - 2026-08-14

### Added
- **Machine-Readable `--json` Output (Invariant #45)**: Added `--json` option across all reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, and `session list`). Piped or redirected output automatically defaults to JSON mode when stdout is non-TTY.
- **Structured JSON Setup Errors**: Vault validation and configuration errors emit structured `{"error": "..."}` JSON with exit code 2 when run in JSON or non-TTY mode.
- **Standardized `Difficulty` Enum & Runtime Helper**: Defined `Difficulty = 'beginner' | 'intermediate' | 'advanced'` in `src/types.ts` and added `normalizeDifficulty()` runtime helper supporting string folding, whitespace trimming, and numeric mappings (1 -> beginner, 2..3 -> intermediate, 4..5 -> advanced).
- **Empty Vault Onboarding Guidance**: Added centralized `printEmptyVaultOnboarding()` helper to provide actionable commands (`palee adopt`, `palee roadmap --from`) across empty vault states.
- **Session Topic Option**: Added `--topic <id>` option to `palee session` and implemented `resolveSessionTopic()` with active topic fallback.

### Fixed
- **Dashboard Division-by-Zero Guard**: Added explicit `total > 0` ternary check in `src/cli/dashboard.ts` to prevent `NaN%` display on empty vaults.
- **Vault Validation & Permissions**: Replaced abrupt `process.exit(0)` with clean `return` on empty states and added directory/read-permission (`R_OK`) checks at vault root.
- **Phantom Topic Elimination**: Eliminated default creation of phantom `T-general` topic notes during session operations.

---

## [0.1.0] - 2026-08-12

### Added
- Setup & Architecture with `commander`, `yaml`, and Node.js testing.
- Conflict-Aware Atomic Storage Layer with file fingerprinting, OCC, and robust file locking.
- Deterministic Engine Core (SM-2, mastery calculation, dependency graph resolution, cycle detection).
- Comprehensive CLI Layer with deterministic commands (`plan`, `next`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`).
- Phase 1 Session Memory System (`hot.md`, `index.md`, durable session logs, draft recovery).
- Full Windows path and lock-recovery support.
- Interactive draft checkpoint recovery.

### Fixed
- Fixed strict TypeScript enforcement and removed all dead code.
- Purged all narrative comments to conform to strict code standards.
