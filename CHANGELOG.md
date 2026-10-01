# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- **A note's own prerequisites now author its edges** ([PAL-205](https://github.com/Kuldeep2822k/cli/issues/205)): `palee adopt --auto-chain` reads each note's text before inferring anything about it. A `## Prerequisites` section (also `## Requires`, `## Required knowledge`, `## Depends on`) contributes its wikilinks and markdown links — resolved against the notes this batch can point at, by exact vault-relative path or by unique basename. Sentences are not read: an earlier revision also parsed a "requires knowledge of X" phrase out of prose, and measured over 11,168 notes in two Azure curricula every edge the feature produced came from a link while that branch produced none, so this ships scoped to the one form whose referent is not a guess. A unique hit is written as `depends_on` with `depends_on_source: declared`, and it **replaces** that note's inferred edge rather than joining it: one provenance label covers a note's whole list, so keeping an inferred `toc` edge beside a declared one would silently promote an enumeration guess into a gate. Several declared names fan in. A name matching nothing, or matching several notes, is a counted skip and the note keeps the edge the numbered tree justified. A `## Prerequisites` block inside a fenced example, an escaped `\[[link]]`, a task-list checkbox, and a heading that merely starts with the trigger phrase (`## Prerequisites for the lab`) all declare nothing. Two notes naming each other is a cycle, refused by the existing pre-write check with exit `3` and zero writes. The report prints `Declared: N edge(s) from the notes' own prerequisite text` with the count of declarations it could not read.

- **`palee assess` records a four-pillar assessment and recomputes mastery**: `topic_mastery` is the only thing that opens a prerequisite gate, and no command in v0.5.2 raised it — every topic behind an unmastered prerequisite stayed out of `palee plan` permanently, whatever the learner did. `palee assess <topic> [--conceptual N] [--practical N] [--debug N] [--feynman N]` writes the pillars it is given, leaves the others untouched (and says so), recomputes `topic_mastery` with the existing `(c + p + d + 2·f) / 5` weighting, and reports what the change unlocks. SM-2 scheduling is not touched, and the `0.70` threshold is unchanged. Scores outside `0–1` are rejected rather than clamped, so a typed `--conceptual 85` cannot silently become a full mark. ([#227](https://github.com/Kuldeep2822k/cli/issues/227))
- **`palee validate --fix` now repairs invalid SM-2 fields**: `--fix` previously reported "not implemented"; it now repairs invalid SM-2 review fields and reports each repair in the output. ([#210](https://github.com/Kuldeep2822k/cli/pull/210))

- **The auto-chain report counts the notes it leaves ungated** ([#205](https://github.com/Kuldeep2822k/cli/issues/205)): alongside the tier counts, a plan that opens chains now prints `Unchained:  N note(s) the chain gave no predecessor, so their `depends_on` stays empty and nothing gates them`. `N edge(s) written` on its own read as "N notes chained", and on the commit screen a chain head was named nowhere at all - the write plan prints only under `--dry-run`. Notes excluded or demoted by Tier-0 hygiene never enter the plan and are counted by their own lines, not here.
- **The docs described a gating model the code no longer implements** ([#238](https://github.com/Kuldeep2822k/cli/issues/238)): `palee adopt --auto-chain` defaults to `strict`, and `depends_on_source` takes four values whose `toc` and `tie` members are advisory - both true since #223 and #234 - while `docs/02-1`, `docs/02-2`, `docs/03-2` and `planning/invariants.md` still said the default was `full`, gave the domain as `numbered|toc`, and stated that the field "never affects gating". Read together, those pages told a learner that a README enumeration could lock a note away and that no label protects them from it. INV-46 now separates a numbering decision from an equal-rank tie and says which of the two gates; INV-47 records that a synthesized roadmap edge gates because it is written unlabeled; the readiness pages gained the advisory short-circuit; and the refusal and `Auto-chain:` strings quoted in the docs are the ones the CLI prints, including the `N tie (advisory)` bucket and the separate `Declared:` line.

### Fixed

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

- **Draft recovery exits 2 when input runs out**: the interactive recovery menu previously exited 0 silently when stdin ended mid-prompt, leaving the checkpoint unresolved; it now terminates with exit code 2. ([#202](https://github.com/Kuldeep2822k/cli/pull/202))
- **Commander usage errors follow the ExitCode contract**: unknown commands/options and missing arguments previously bypassed the exit-code mapping (Commander defaulted to 1); help, `--version`, and bare invocation now exit 0, all other usage errors exit 2. ([#197](https://github.com/Kuldeep2822k/cli/pull/197))
- **Roadmap import no longer mints zero-valued pillar scores**: absent assessment pillars resolved to `0.0` and were written onto notes, causing false mastery-drift warnings under `validate --strict`. ([#196](https://github.com/Kuldeep2822k/cli/pull/196))
- **Hot-memory rebuild keeps sessions with unparseable timestamps**: unparseable `started_at` values previously wiped the derived hot memory to "No learning history recorded yet." while the session files stayed intact. ([#211](https://github.com/Kuldeep2822k/cli/pull/211))
- **Stale draft timestamps clamped to 24h**: draft recovery and session-end draft selection now clamp `started_at` older than 24 hours, matching the draft-write freshness check. ([#208](https://github.com/Kuldeep2822k/cli/pull/208))
- **Roadmap import no longer reads through a symlinked note path**: existence is tested with `lstat`, the target must resolve inside the vault, and the read is bound to the descriptor of the validated file — so a link planted after the check cannot bring outside content into a note. ([#217](https://github.com/Kuldeep2822k/cli/issues/217), [#218](https://github.com/Kuldeep2822k/cli/pull/218))

### Changed

- **Enumeration order no longer gates** ([#205](https://github.com/Kuldeep2822k/cli/issues/205)): `depends_on` edges that came from a listing document's order (`depends_on_source: toc`) are now advisory. `palee plan` still ranks by them and `palee validate` still detects cycles through them, but they never hide a note from the ready list — a note chained after another in a `README` enumeration is offered immediately instead of waiting for that note to reach 70% mastery. Numbered-tree edges (`depends_on_source: numbered`, or a note you wrote yourself) are unchanged and still gate; a same-rank tie inside one directory is labelled `tie` and is advisory on the same reasoning. This is a containment change, not a deletion: adjudicating 127 TOC-tier edges against the content of the notes they join, 97 (76.4%) were not prerequisites, and because no v0.5.x command raises `topic_mastery` a single such edge locked its note away permanently.
- **`palee adopt --auto-chain` now defaults to `--chain-tier strict`**: a bare `--auto-chain` chains the numbered tree only (the clean figure measured for that tier is enumeration fidelity — how exactly it reproduces the numbering the author already wrote — not a prerequisite audit, and the 127-edge census above is the enumeration tier's, so no false-edge count is claimed for `strict`); chaining a repository's `README`/`SUMMARY` enumeration now has to be asked for with `--chain-tier toc` or `--chain-tier full`. Notes already chained by the enumeration in an earlier run keep their edges, and they are advisory now either way, so re-adopting is not required.
- **A same-number tie is reported, labelled `tie`, and no longer gates**: two notes in one directory carrying the same numeric prefix (`02-a.md` and `02-b.md`, or `lab-a.md` and `lab-b.md`) were ordered between themselves by their filenames, while the report described the plan as numbered and named nothing. The dry-run now says `1 of 2 planned notes have the same number or phase as the note before them, so the order between them is alphabetical` and names the path, and that edge is written as `depends_on_source: tie` — advisory, like a `toc` edge: it still ranks the note and still takes part in cycle detection, but it no longer holds the note off the ready list. The tree declined to order a tied pair, so a filename collation is not a prerequisite claim. Genuinely unnumbered notes keep their existing warning and are not double-counted. **A vault adopted before this change is not unlocked by it alone**: those notes stored the tie as `depends_on_source: numbered`, which cannot be told apart from a numbering-decided edge without re-deriving the order, and `adopt` never rewrites an already-adopted note. `palee migrate --relabel-ties` does that re-derivation — see the entry below — so until it is run, this applies only to edges written from now on.
- **Stored ties can be relabelled without touching the edges** ([#237](https://github.com/Kuldeep2822k/cli/issues/237)): `palee migrate` now audits notes held behind a same-directory sibling of equal rank that still carry `depends_on_source: numbered`, and `palee migrate --relabel-ties` rewrites that label to `tie` — which makes the edge advisory and puts the note back on `palee plan`'s ready list. It re-asks the planner's own predicates (`tiedByName` for equal rank, `compareLessonOrderTier0` for which of the two the enumeration would place first) rather than restating them, so the two cannot drift apart and demote an order the numbering really did decide — a stored edge running the other way is a learner's gate, not a stale tie, and is left alone. Three things keep it conservative, because one label covers a note's whole list: only a note with exactly one stored predecessor is a candidate, a note with no label at all is the learner's own writing and is never touched, and `depends_on` is never rewritten. The report and the writes come from one scan, so no note is announced one way and treated another; the window that matters is between a decision and its own write, and each write closes it by re-confirming the note's bytes and its predecessor's identity before anything is promoted. The audit writes nothing without the flag, and is idempotent; a note whose stored predecessor no longer resolves is counted and named as such, then left to the edge-integrity report, because with the pair broken no order can be derived from it; an OCC conflict, an active lock, or a predecessor that turns out to hold another topic by the time the write lands exits `4` and re-runs, leaving that note gated.
- **Homework no longer opens the next module**: the bridge into a module used to attach to the previous module's final backbone note, and placing `assignment|quiz|solution` last inside a directory — the rule that stops a lesson depending on its own homework — made that note the homework. So `02-search/01-b` was gated behind `01-foundations/assignment.md`: 48 of the 88 measured ML-For-Beginners edges and 29 of 72 in Web-Dev. The cross-directory bridge now uses the group's last non-homework backbone, and a module whose only backbone is homework opens a new chain instead of handing its assignment to everything downstream. Homework still follows the lesson it assesses inside its own directory, and a directory that collapses to leaves still passes the bridge through unchanged.
- **An enumeration that chains nothing is a refusal, not a success**: a README whose links all resolve to notes this tier will not order (a `solution/` subtree, a translation copy) used to print `Auto-chain: enabled (full tier — 0 edge(s) written)` and withhold the pointer this vault needs, because the refusal was keyed off the presence of links rather than the edges they produced. It is now keyed off what the plan can chain, and the two ways that can fail say which one happened: `0 edges (no numbered layout, no chainable order signal) — consider palee roadmap` when the vault states no order, and `0 edges (no numbered layout; --chain-tier strict does not read a README enumeration) — try --chain-tier toc` when an enumeration is there but the selected tier declines it. That second line is a promise, so it is keyed to the notes an enumeration offers rather than its links: one lesson reachable under two spellings (`guide/only.md` and `./guide/only.md`) is one candidate, and `--chain-tier toc` deduplicates to a lone chain head that writes no edge — advising it there would trade the roadmap pointer for a second refusal.
- **Wikilink roadmap detection requires `palee_roadmap: true`**: `palee roadmap --from <note.md>` no longer imports a Markdown document that does not explicitly mark itself as a roadmap. Previously any `.md` with a heading and one `[[...]]` bullet was classified as a wikilink roadmap, so pointing `--from` at an ordinary note imported its outbound links and rewrote `depends_on` on every note it linked to. Such a file is now rejected with exit `2` and zero writes; add `palee_roadmap: true` to the frontmatter of a genuine wikilink roadmap. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))

- **Documentation site refresh**: resolved audit drift, navigation gaps, and Mermaid diagram clipping/layout issues; the navbar now displays the current package version. ([#189](https://github.com/Kuldeep2822k/cli/pull/189))
- **Dependency updates**: `duriantaco/skylos` 4.36.1 → 4.38.0, `yaml` 2.9.0 → 2.9.1. ([#203](https://github.com/Kuldeep2822k/cli/pull/203), [#174](https://github.com/Kuldeep2822k/cli/pull/174))

- **INV-46/47 restated; auto-chain docs aligned with landed behavior** ([PAL-205-D](https://github.com/Kuldeep2822k/cli/issues/205)): `planning/invariants.md` INV-46 now carries three binding sub-clauses — Tier-0 hygiene (classification contract, `paleeIdOf` scan/plan agreement, demote-never-fabricate failure direction, mandatory report counts), tier composition and precedence (hygiene above both tiers, structure-justified cross-directory gating, numbering dominance, TOC edges replace rather than add, `depends_on_source` provenance), and the honest-refusal path (exit `0` with zero fabricated edges when no order signal exists; unjustified transitions open their own chain); the never-rewrite rule stays in the INV-46 parent clause. INV-47 states the cycle-skip rule and that the chained-count counts only edges actually synthesized. Command docs corrected against heads `27ab870`/`9ac6690`: cross-module bridging qualified to justified transitions, `toc` documented as currently producing identical plans to `full`, the hygiene report-block description completed (invalid-`palee_id` count, nothing-left-to-chain pointer, tier and TOC-edge count on the `Auto-chain:` line), and `solutions/` added to the PAL-205-B phase-directory list. Second pass rebased onto final C head `0d10120`: INV-46 now states the owner-ruled vault-root bridge and the C-defect-1 refusal condition (no-signal only when the scoped enumeration resolves no TOC link and the plan writes zero edges); INV-47 quotes the final A6 summary line `Auto-chain: N chain edge(s) synthesized across M roadmap topics.`; the unnumbered-warning wording is unified with feat/73-auto-chain@900b3ec (warning fires only where alphabetical order actually decides); TOC skipped-link counts are documented as plan-data-only with a `--verbose` follow-up; and two carried nits are recorded as known issues — the B6 alphabetical-warning seam above a true-refusal plan, and badge-wrapped TOC links (`[![x](i.png)](t.md)`) parsing `missing` fail-closed. Docs-only; no behavior changed.

---

## [0.5.2] - 2026-09-19

### Fixed

- **Frontmatter parser robustness**: detects body text swallowed into frontmatter by unclosed fences; supports quoted keys with colons and unquoted keys with spaces, slashes, or non-ASCII characters; preserves `raw`/`body` for whitespace-only fenced blocks. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation rule runner is exception-safe**: rule crashes now surface as structured findings instead of exit-5 crashes. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **Validation barrel export order aligned** with rule registration order. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#188](https://github.com/Kuldeep2822k/cli/pull/188))
- **`valid-dependency-list` covers the legacy `dependencies` alias** with an advisory warning to migrate to `depends_on`. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#181](https://github.com/Kuldeep2822k/cli/issues/181), [#187](https://github.com/Kuldeep2822k/cli/pull/187))

### Changed

- **Documented the legacy `dependencies` alias advisory** in rule metadata, docs, and Mermaid diagrams. ([#187](https://github.com/Kuldeep2822k/cli/pull/187))

---

## [0.5.1] - 2026-09-18

### Fixed

- **`no-dependency-cycle` reports every cycle**, not just the first (bounded at 1000, with a truncation finding). ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#184](https://github.com/Kuldeep2822k/cli/pull/184))
- **Derived-view rebuilds never delete canonical sessions**; draft sessions are excluded from the hot-memory rebuild. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#185](https://github.com/Kuldeep2822k/cli/pull/185))
- **Numeric `assessed_at` values normalize to ISO 8601** through the adopt/loader round-trip. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#186](https://github.com/Kuldeep2822k/cli/pull/186))
- **Leading BOM stripped** so frontmatter parses for files saved by Windows editors. ([#171](https://github.com/Kuldeep2822k/cli/issues/171), [#183](https://github.com/Kuldeep2822k/cli/pull/183))

### Changed

- **ADR-0008 review clarifications**; v0.5.0 entries moved out of `[Unreleased]`. ([#182](https://github.com/Kuldeep2822k/cli/pull/182))
- **Dependency updates**: `duriantaco/skylos` 4.35.0 → 4.36.1. ([#175](https://github.com/Kuldeep2822k/cli/pull/175))

---

## [0.5.0] - 2026-09-15

### Added

- **Validation rule framework**: single-read vault collector, deterministic runner, human/JSON formatters; duplicate-ID, missing-dependency, and cycle checks ported as pure rules. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#26](https://github.com/Kuldeep2822k/cli/issues/26), [#30](https://github.com/Kuldeep2822k/cli/issues/30), [#158](https://github.com/Kuldeep2822k/cli/pull/158))
- **Validation rules for schema, topic IDs, and status**: `palee_schema: 1` enforcement, `T-` kebab-case topic ID policy, four-state `status` validation; `adopt` generates compliant IDs. ([#28](https://github.com/Kuldeep2822k/cli/issues/28), [#29](https://github.com/Kuldeep2822k/cli/issues/29), [#31](https://github.com/Kuldeep2822k/cli/issues/31), [#159](https://github.com/Kuldeep2822k/cli/pull/159))
- **`validate --strict` warning escalation** and a `src/validation/` public barrel with census test. ([#25](https://github.com/Kuldeep2822k/cli/issues/25), [#162](https://github.com/Kuldeep2822k/cli/pull/162))
- **Assessment and mastery validation rules** (`valid-assessment-fields`, `valid-topic-mastery`); #40 enforced as command-level regression tests. ([#36](https://github.com/Kuldeep2822k/cli/issues/36), [#37](https://github.com/Kuldeep2822k/cli/issues/37), [#40](https://github.com/Kuldeep2822k/cli/issues/40), [#163](https://github.com/Kuldeep2822k/cli/pull/163))
- **Review-state, review-dates, and dependency-list validation rules**; `no-missing-dependency` downgraded to warning per ADR-0008. ([#33](https://github.com/Kuldeep2822k/cli/issues/33), [#34](https://github.com/Kuldeep2822k/cli/issues/34), [#38](https://github.com/Kuldeep2822k/cli/issues/38), [#39](https://github.com/Kuldeep2822k/cli/issues/39), [#165](https://github.com/Kuldeep2822k/cli/pull/165))
- **Memory-subsystem validation rules** (`valid-managed-note-kind`, `valid-session-schema`, `no-session-unknown-topic`, `valid-session-index`). ([#27](https://github.com/Kuldeep2822k/cli/issues/27), [#41](https://github.com/Kuldeep2822k/cli/issues/41), [#42](https://github.com/Kuldeep2822k/cli/issues/42), [#44](https://github.com/Kuldeep2822k/cli/issues/44), [#168](https://github.com/Kuldeep2822k/cli/pull/168))
- **Hot-memory and safe-vault-paths validation rules**; shared `displayValue` helper fixes `NaN`/`Infinity` rendering in diagnostics. ([#43](https://github.com/Kuldeep2822k/cli/issues/43), [#45](https://github.com/Kuldeep2822k/cli/issues/45), [#166](https://github.com/Kuldeep2822k/cli/issues/166), [#169](https://github.com/Kuldeep2822k/cli/pull/169))
- **Multi-cycle enumeration and quarantine** in the dependency engine (bounded display with `truncated` flag). ([#79](https://github.com/Kuldeep2822k/cli/issues/79), [#157](https://github.com/Kuldeep2822k/cli/pull/157))

### Changed

- **Parallel test execution**: full suite ~112s → ~38s; added `test:unit`, `test:fast`, `test:e2e`, `test:fuzz` scripts. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Windows lock-directory stale recovery** with bounded 5-attempt backoff instead of exit-5 crashes. ([#121](https://github.com/Kuldeep2822k/cli/issues/121))
- **Internal refactors**: single shared derivation for roadmap imports, centralized `hot.md` reads and exit-code mapping, injectable `loadTopics` cache. ([#139](https://github.com/Kuldeep2822k/cli/issues/139), [#130](https://github.com/Kuldeep2822k/cli/issues/130), [#129](https://github.com/Kuldeep2822k/cli/issues/129), [#128](https://github.com/Kuldeep2822k/cli/issues/128), [#154](https://github.com/Kuldeep2822k/cli/pull/154), [#145](https://github.com/Kuldeep2822k/cli/pull/145), [#151](https://github.com/Kuldeep2822k/cli/pull/151), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **ADR-0008: validation-framework decisions** recorded; dangling planning-doc references fixed. ([#170](https://github.com/Kuldeep2822k/cli/issues/170), [#172](https://github.com/Kuldeep2822k/cli/pull/172))
- **Dependency and workflow updates**: workflow security hardening, GitHub Actions bumps, dead-code detection via Skylos. ([#143](https://github.com/Kuldeep2822k/cli/pull/143), [#148](https://github.com/Kuldeep2822k/cli/pull/148), [#141](https://github.com/Kuldeep2822k/cli/pull/141))

### Fixed

- **Vault-relative paths through symlinked roots** via `realpathSync`. ([#160](https://github.com/Kuldeep2822k/cli/issues/160), [#161](https://github.com/Kuldeep2822k/cli/pull/161))
- **Exit code 4 on OCC conflict** in `palee migrate --fix`. ([#128](https://github.com/Kuldeep2822k/cli/issues/128), [#144](https://github.com/Kuldeep2822k/cli/pull/144))
- **Explicit `0` preserved in SM-2 fields** (`ease_factor`, `interval_days`, `repetition`, `lapses`). ([#127](https://github.com/Kuldeep2822k/cli/issues/127))
- **`depends_on`/`dependencies` aliases normalized consistently** across loader, validator, and roadmap. ([#126](https://github.com/Kuldeep2822k/cli/issues/126))
- **Unsupported `palee_schema` in hot.md triggers rebuild** (ADR-0007). ([#130](https://github.com/Kuldeep2822k/cli/issues/130))
- **npm audit fixes applied**; published package files optimized via `.npmignore`. ([#156](https://github.com/Kuldeep2822k/cli/pull/156), [#173](https://github.com/Kuldeep2822k/cli/pull/173))

### Removed

- **Lock internals pruned from the storage barrel** (`HEARTBEAT_INTERVAL`, `STALE_TIMEOUT`; still in `src/storage/lock.ts`). ([#131](https://github.com/Kuldeep2822k/cli/issues/131))

---

## [0.4.0] - 2026-08-31

### Added

- **Storage layer isolation**: all vault filesystem mutations behind the `src/storage/index.ts` facade. ([#86](https://github.com/Kuldeep2822k/cli/issues/86), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **True session durations** persisted to `.palee/hot.md` and draft checkpoints. ([#88](https://github.com/Kuldeep2822k/cli/issues/88), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Resilient roadmap batch ingestion**: per-topic failures no longer block remaining imports. ([#89](https://github.com/Kuldeep2822k/cli/issues/89), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Interactive Mermaid pan-zoom controls** in the docs site. ([#115](https://github.com/Kuldeep2822k/cli/pull/115), [#116](https://github.com/Kuldeep2822k/cli/pull/116))
- **`palee migrate --fix`**: atomically upgrades schema-less notes to `palee_schema: 1`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Custom vault traversal exclusions** (`excludeDirs`). ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Session draft checkpoint invariants**: exit code 2 and `drafts_pending` JSON when drafts block `session start`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Flexible dependency aliases**: `dependencies` supported alongside `depends_on`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Fixed

- **Review OCC race eliminated**: target note re-read before atomic write; exit 4 on concurrent modification. ([#87](https://github.com/Kuldeep2822k/cli/issues/87), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Mastery output and dashboard alignment** standardized. ([#91](https://github.com/Kuldeep2822k/cli/issues/91), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **Deterministic file-cache operation** (2,000 ms unsettled horizon). ([#90](https://github.com/Kuldeep2822k/cli/issues/90), [#120](https://github.com/Kuldeep2822k/cli/pull/120))
- **macOS canonical path resolution** for symlinked `/var/folders` paths. ([#122](https://github.com/Kuldeep2822k/cli/pull/122))
- **Config resilience**: `SyntaxError` recovery in `loadConfig()` with atomic saves. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Timezone-safe due-date computation** with 2-digit year guard. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Atomic write concurrency** via cryptographic entropy in temp filenames. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Duplicate topic IDs**: dependencies merged for complete graph connectivity. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **Structured JSON errors** on unhandled rejections with `--json`. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))
- **CST frontmatter formatting**: unified `Document` serialization for clean YAML block lists. ([#117](https://github.com/Kuldeep2822k/cli/pull/117))

### Changed

- **npm OIDC trusted publishing** with build provenance attestations. ([#124](https://github.com/Kuldeep2822k/cli/pull/124))

---

## [0.3.1] - 2026-08-23

### Fixed

- **README logo URL** fixed for npm registry rendering.

### Changed

- **GitHub Actions dependencies bumped**. ([#99](https://github.com/Kuldeep2822k/cli/pull/99), [#100](https://github.com/Kuldeep2822k/cli/pull/100), [#101](https://github.com/Kuldeep2822k/cli/pull/101), [#102](https://github.com/Kuldeep2822k/cli/pull/102))

---

## [0.3.0] - 2026-08-20

### Added

- **Batch note adoption (`palee adopt`)** with `--dry-run`, `--yes`, `--tag`, `--include`, `--exclude` filters. ([#50](https://github.com/Kuldeep2822k/cli/pull/50), [#74](https://github.com/Kuldeep2822k/cli/pull/74))
- **Multi-format roadmap parser** (pure YAML, frontmatter YAML, embedded code-fence YAML). ([#112](https://github.com/Kuldeep2822k/cli/pull/112))
- **Technical documentation suite**: 35-chapter VitePress docs with interactive architecture diagrams. ([#108](https://github.com/Kuldeep2822k/cli/pull/108), [#112](https://github.com/Kuldeep2822k/cli/pull/112), [#114](https://github.com/Kuldeep2822k/cli/pull/114))
- **Distinct exit code 4** on OCC and file-lock conflicts. ([#76](https://github.com/Kuldeep2822k/cli/pull/76), [#107](https://github.com/Kuldeep2822k/cli/pull/107))

### Changed

- **Exit-code standardization**: `process.exitCode` replaces `process.exit()` for clean stream flushing. ([#77](https://github.com/Kuldeep2822k/cli/issues/77), [#110](https://github.com/Kuldeep2822k/cli/pull/110))
- **Centralized vault validation** through `validateVaultPath`. ([#78](https://github.com/Kuldeep2822k/cli/issues/78), [#111](https://github.com/Kuldeep2822k/cli/pull/111))
- **Unified storage layer boundary** with in-memory caching and single-pass discovery. ([#98](https://github.com/Kuldeep2822k/cli/pull/98))
- **Shared mastery engine** with extracted `MASTERY_THRESHOLD`. ([#85](https://github.com/Kuldeep2822k/cli/issues/85), [#94](https://github.com/Kuldeep2822k/cli/pull/94), [#95](https://github.com/Kuldeep2822k/cli/pull/95), [#106](https://github.com/Kuldeep2822k/cli/pull/106))

### Fixed

- **Archived topics excluded** from global mastery calculation. ([#97](https://github.com/Kuldeep2822k/cli/pull/97))
- **Invalid-date guard** in progress date parsing. ([#96](https://github.com/Kuldeep2822k/cli/pull/96))

---

## [0.2.0] - 2026-08-14

### Added

- **Machine-readable `--json` output** across reading commands (`next`, `plan`, `progress`, `dashboard`, `validate`, `session list`); non-TTY output defaults to JSON.
- **Structured JSON setup errors** with exit code 2 in JSON/non-TTY mode.
- **Standardized `Difficulty` enum** (`beginner` | `intermediate` | `advanced`) with `normalizeDifficulty()` runtime helper.
- **Empty-vault onboarding guidance** pointing at `palee adopt` and `palee roadmap --from`.
- **`--topic <id>` option** for `palee session` with active-topic fallback.

### Fixed

- **Dashboard division-by-zero guard** against `NaN%` on empty vaults.
- **Vault validation and permissions**: clean returns on empty states plus directory/read-permission checks at the vault root.
- **Phantom topic elimination**: no more default `T-general` topic notes during session operations.

---

## [0.1.0] - 2026-08-12

### Added

- Project setup with `commander`, `yaml`, and Node.js testing.
- Conflict-aware atomic storage layer with file fingerprinting, OCC, and robust file locking.
- Deterministic engine core (SM-2, mastery calculation, dependency graph resolution, cycle detection).
- CLI layer with deterministic commands (`plan`, `next`, `progress`, `review`, `validate`, `roadmap --from`, `adopt`).
- Phase 1 session memory system (`hot.md`, `index.md`, durable session logs, draft recovery).
- Full Windows path and lock-recovery support.
- Interactive draft checkpoint recovery.

### Fixed

- Strict TypeScript enforcement with dead code removed.
- Narrative comments purged to conform to strict code standards.
