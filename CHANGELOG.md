# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A hedged item under `## Prerequisites` no longer authors a gate** ([#261](https://github.com/Kuldeep2822k/cli/issues/261)): the section scan took every link it found and labelled the result `declared`, so `does not require [[x]]`, `requires [[x]] or [[y]]` and `this note is a prerequisite for [[x]]` each locked a learner behind a note the sentence ruled out, denied, or pointed the other way — and links inside an HTML comment or an inline code span were read like any other. An item carrying one of those cues now contributes nothing, using the negation vocabulary #232 shipped rather than a second one; an unambiguous bullet, including `- [[a]] and [[b]] are required`, still writes its `declared` edge and still gates.
- **A note stored with a decomposed name keeps the one spelling the walk reported** ([#269](https://github.com/Kuldeep2822k/cli/issues/269)): `withWalkedCasing` re-spells a resolved wikilink from the vault walk so a differently-cased link cannot give an adopted note a second `palee_id`, but it folded the index *key* with `foldNoteKey` (case + NFC) while comparing the full paths with `toLowerCase()` alone. APFS opens the stored `cafe` + U+0301 note for a composed link and `realpathSync` echoes the typed spelling, so the two sides differed by normalization rather than casing, nothing matched, and the resolver returned a path no directory listing contains — the exact divergence the re-spell exists to remove. Both sides now fold the way `foldNoteKey` folds. The guard fails on a case-only compare on every platform; it was the macOS CI failure that showed the divergence was still reachable.
- **A stray `]` or an unbalanced `(` no longer makes the README scan quadratic** ([#263](https://github.com/Kuldeep2822k/cli/issues/263)): the link scanner bailed out only when *no* `]` followed an unclosed `[`, so a single closing bracket anywhere in the file sent `findLabelEnd` walking to end-of-text for every remaining `[` — 160 KB of brackets cost 64 s, and `palee adopt --auto-chain` read every README in the vault, so one pasted diff stalled the run. The scan now answers "can this label still close?" from one balance pass (same links, same order: 20 000 brackets 0.6 s → 2 ms), and a second pass over `(`/`)` answers the same question for a destination that never balances: in `[a](b(c) ` repeated every `)` is consumed inside a deeper pair, so each remaining link walked the rest of the file — 360 KB cost 20 s before it was bounded and 6 ms after. A TOC document over 512 KiB is declined with an `oversized` skip reason and a warning instead of parsed at all.
- **A tie is a tie at every rank** ([#255](https://github.com/Kuldeep2822k/cli/issues/255)): `assignment`/`quiz` and `README`/`SUMMARY` pairs in a numbered directory were ordered by their filenames alone yet labelled `numbered`, so they gated and the alphabetical-order warning stayed silent. `tiedByName` now reports what its own docstring said — every pair the comparator resolves by collation — so those edges are advisory `tie`, the warning counts them, and `palee migrate --relabel-ties` can retire the ones v0.6.0 already wrote.
- **`palee migrate --relabel-ties` demotes only edges the chain could have written** ([#251](https://github.com/Kuldeep2822k/cli/issues/251)): a stored `numbered` edge that steps over a same-rank sibling still in the directory keeps gating, while the nearest *surviving* sibling still demotes — so deleting the middle note never strands the vault behind a false gate.
- **A TOC destination can no longer resolve onto a note the author never named** ([#262](https://github.com/Kuldeep2822k/cli/issues/262)): the anchor is split before percent-decoding, so `[sharp](notes/c%23.md)` reaches `notes/c#.md` instead of being cut to `notes/c.md`; a bare destination carrying an unescaped space is refused as `unescaped-space` rather than truncated at the space onto `notes/my.md`; and a backslash escapes exactly CommonMark's ASCII punctuation class (spec 2.4) and nothing else, so `[a](notes/v1\.2.md)` reaches `notes/v1.2.md` while `01-a\02-b.md` keeps its literal backslash instead of collapsing onto the real sibling `01-a02-b.md`. Each form silently authored — or, with the dot still escaped, silently lost — a persisted, gating edge against a note nobody named. The same escape class applies inside `<angle brackets>`: that form differs from a bare one only in where it ends, so a raw space there is data rather than a refusal. `%20` escapes and `"title"` suffixes are unchanged.
- **`palee assess` names the pillar a low score was never able to supply** ([#260](https://github.com/Kuldeep2822k/cli/issues/260)): mastery is `(conceptual + practical + debug + 2 * feynman) / 5`, so Feynman's double weight means the three ordinary pillars cap at `0.60` and can never reach the `0.70` gate alone. A below-threshold assessment with no Feynman score now prints a hint naming `--feynman` and the arithmetic, instead of reading as "your score was too low".

## [0.6.0] - 2026-10-01

### Migration

0.6.0 changes which `depends_on` edges gate a note, and nothing rewrites an already-adopted note, so a vault built under 0.5.x needs one explicit step to feel the fix. `palee plan` names the victims under `Blocked by prerequisites`.

- **Notes that carry a label.** Run `palee migrate --relabel-ties --dry-run` to list every candidate, then `palee migrate --relabel-ties` to demote the stale `depends_on_source: numbered` ties to `tie`. Only the label is written.
- **Notes with no label, which is what the 0.5.x auto-chain wrote.** An absent `depends_on_source` means "the learner typed this list", so these keep gating and `--relabel-ties` alone neither touches nor mentions them ([#266](https://github.com/Kuldeep2822k/cli/issues/266)). Once you have confirmed the unlabeled notes are chained lessons rather than prerequisites you authored, run `palee migrate --relabel-ties --include-unlabeled-ties --dry-run`, read the whole list, then repeat without `--dry-run`. Notes that are not a single backward edge onto a same-rank sibling — a multi-entry list, an edge into another directory, an edge over a surviving sibling, a note also carrying the legacy `dependencies` key — are refused and stay gated.
- **Nothing else.** No upgrade path, no `palee migrate` run without flags, and no `--dry-run` writes anything; `palee_schema` stays at `1`.

### Added

- **`palee adopt --auto-chain`**: derives each note's `depends_on` from numbered directory/file prefixes, bridges modules and already-adopted notes, and validates the planned graph for cycles before any write (exit `3`, zero writes on failure); conflicts with `--depends-on` and single-file mode (exit `2`). ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **`palee roadmap --auto-chain`**: chains roadmap topics by their `order` field; explicit non-empty `depends_on` always wins; an edge that would close a cycle against an authored dependency is skipped with a warning. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **Wikilink roadmap format**: a Markdown roadmap that sets `palee_roadmap: true` in frontmatter chains headings + `[[links]]` per section; links resolve by exact path then unique basename, and ambiguous or unresolvable links fail closed (exit `3`, zero writes). ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- **Tier-0 hygiene filters** ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205)): before chaining, notes are classified `backbone`/`leaf`/`excluded` — repo-meta files, translation copies, templates, and phase-directory contents (`solution/`, `answers/`, …) never become prerequisites; the report prints backbone, leaf, and per-rule skip counts.
- **`--chain-tier <strict|toc|full>`** ([PAL-205-C](https://github.com/Kuldeep2822k/cli/issues/73)): `strict` (default) chains the numbered tree only; `toc`/`full` additionally chain the repo's `README`/`SUMMARY` enumeration in document order, fail-closed on unresolvable links; unknown tier values are a usage error (exit `2`).
- **A note's own prerequisites author its edges** ([PAL-205](https://github.com/Kuldeep2822k/cli/issues/205)): a `## Prerequisites` section's wikilinks and markdown links become `depends_on` with `depends_on_source: declared`, replacing the inferred edge — prose sentences are not parsed.
- **`palee assess <topic>`** ([#227](https://github.com/Kuldeep2822k/cli/issues/227)): records the four assessment pillars and recomputes `topic_mastery` with the existing weighting; scores outside `0–1` are rejected, not clamped.
- **`palee validate --fix` now repairs invalid SM-2 fields** ([#210](https://github.com/Kuldeep2822k/cli/pull/210)).
- **The auto-chain report counts the notes it leaves ungated** ([#205](https://github.com/Kuldeep2822k/cli/issues/205), [#245](https://github.com/Kuldeep2822k/cli/pull/245)): a plan that opens chains prints an `Unchained:` line so chain heads are visible instead of silent.

### Fixed

- `--include`/`--exclude`/`--tag` filters now apply before the already-adopted check, so an excluded note can no longer enter the chain. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Fenced code blocks are stripped with a CommonMark-correct line-based parser, so examples can no longer rewrite a roadmap or mint a title. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Resolved paths are re-spelled from the vault index, so a differently-cased wikilink can no longer overwrite an adopted note's `palee_id`. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- Escaped `\[[links]]` are treated as literal text, not links. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The alphabetical-order warning now counts the notes it actually describes. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- The adopt summary reports the edges actually written per tier instead of claiming every note was chained by prefix order. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- `adopt --auto-chain <path>` works again: the tier moved to `--chain-tier` and the flag is a plain boolean. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The TOC tier no longer misreports its own enumeration order as alphabetical. ([#73](https://github.com/Kuldeep2822k/cli/issues/73))
- The vault root no longer trips the unnumbered-directory warning. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- Directory comparison only consults the level that decides the order. ([PAL-205-B](https://github.com/Kuldeep2822k/cli/issues/205))
- **`palee plan` names the notes it holds back** ([#219](https://github.com/Kuldeep2822k/cli/issues/219), [#220](https://github.com/Kuldeep2822k/cli/pull/220)): a new `Blocked by prerequisites` section (plus a `blocked` array in `--json`) distinguishes unmet prerequisites from ids missing from the vault, and `palee roadmap --from` reports edges to ids that were never written.
- **A valueless `--chain-tier` is a usage error, not the widest tier** ([#247](https://github.com/Kuldeep2822k/cli/pull/247)): it now returns `null`, which the CLI turns into a usage error instead of silently selecting `full`.
- **Draft recovery exits 2 when input runs out** ([#202](https://github.com/Kuldeep2822k/cli/pull/202)).
- **Commander usage errors follow the exit-code contract**: help, `--version`, and bare invocation exit 0; all other usage errors exit 2. ([#197](https://github.com/Kuldeep2822k/cli/pull/197))
- **Roadmap import no longer mints zero-valued pillar scores** ([#196](https://github.com/Kuldeep2822k/cli/pull/196)).
- **Hot-memory rebuild keeps sessions with unparseable timestamps** ([#211](https://github.com/Kuldeep2822k/cli/pull/211)).
- **Stale draft timestamps clamped to 24h** ([#208](https://github.com/Kuldeep2822k/cli/pull/208)).
- **Roadmap import no longer reads through a symlinked note path** ([#217](https://github.com/Kuldeep2822k/cli/issues/217), [#218](https://github.com/Kuldeep2822k/cli/pull/218)).

### Changed

- **Enumeration order no longer gates** ([#205](https://github.com/Kuldeep2822k/cli/issues/205)): `depends_on_source: toc` and `tie` edges are advisory — they rank and take part in cycle detection but never hide a note from the ready list.
- **`palee adopt --auto-chain` now defaults to `--chain-tier strict`**; chaining a `README`/`SUMMARY` enumeration requires `--chain-tier toc` or `--chain-tier full`.
- **A same-number tie is reported, labelled `tie`, and no longer gates**: the dry-run names the tied pair instead of ordering them by filename. ([#234](https://github.com/Kuldeep2822k/cli/pull/234))
- **Stored ties can be relabelled without touching the edges** ([#237](https://github.com/Kuldeep2822k/cli/issues/237), [#239](https://github.com/Kuldeep2822k/cli/pull/239)): `palee migrate --relabel-ties` rewrites stale `numbered` labels to `tie`, putting those notes back on the ready list. As shipped that reached only notes carrying the label, which is not every note it advertised — the 0.5.x auto-chain left its edges with no `depends_on_source` key at all, and those need the `--include-unlabeled-ties` opt-in ([#266](https://github.com/Kuldeep2822k/cli/issues/266)).
- **Homework no longer opens the next module**: cross-module bridges attach to the last non-homework backbone note, so a lesson is never gated behind another module's assignment.
- **An enumeration that chains nothing is a refusal, not a success**: a README with no chainable order prints `0 edges …` with a pointer (`palee roadmap` or `--chain-tier toc`) instead of a success line.
- **Wikilink roadmap detection requires `palee_roadmap: true`** ([#73](https://github.com/Kuldeep2822k/cli/issues/73)): `palee roadmap --from` rejects unmarked Markdown documents with exit 2 and zero writes.
- **Documentation refresh**: site refresh ([#189](https://github.com/Kuldeep2822k/cli/pull/189)); INV-46/47 restated with auto-chain docs aligned to shipped behavior ([PAL-205-D](https://github.com/Kuldeep2822k/cli/issues/205)).
- **Docs corrected to the shipped gating model**: `strict` default and four-value `depends_on_source` ([#238](https://github.com/Kuldeep2822k/cli/issues/238), [#246](https://github.com/Kuldeep2822k/cli/pull/246)); new `architecture/` views with stated drift ([#249](https://github.com/Kuldeep2822k/cli/pull/249)).
- **Dependency updates**: `duriantaco/skylos` 4.36.1 → 4.39.2, `yaml` 2.9.0 → 2.9.1. ([#203](https://github.com/Kuldeep2822k/cli/pull/203), [#174](https://github.com/Kuldeep2822k/cli/pull/174), [#229](https://github.com/Kuldeep2822k/cli/pull/229))



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
