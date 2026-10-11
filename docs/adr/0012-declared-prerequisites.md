# ADR-0012: Declared Prerequisites — Reading a Note's Own Text

## Status

Accepted

## Context

ADR-0009's gating rule has three gates: the learner's own frontmatter, the numbered tree, and the note's own declaration. The first two existed from the start. The third — a note that writes `## Prerequisites` and links its predecessors — is the one this ADR records, along with the feature that was built and then deliberately removed on the way there (#232 → #240).

An author who writes `## Prerequisites` and links `[[m/01-setup]]` is making a statement of exactly the class a hand-written `depends_on` makes. Unlike an order inferred from where a file sits in a listing, the link is the author's chosen name for the thing they need. Those edges gate.

## Decision

### What counts as a declaration

A section whose heading is the trigger phrase and nothing else — `## Prerequisites`, `## Requires`, `## Required knowledge`, `## Depends on` (and the singular/prior variants) — collects links from its list items until the next heading of any level. The heading match is deliberately narrow: `## Prerequisites for the lab` does not turn an arbitrary section into a dependency list.

Only links count. `- Setup` is read for its `[[Setup]]` or its `(setup.md)`; a bare word is not a reference the engine can resolve without guessing. Fenced code, HTML comments and inline code spans are blanked first — a `## Prerequisites` block inside a documentation example, a commented-out entry, or a backticked one are written to be read, not followed — through the same `stripUnfollowableMarkup` the TOC scanner calls (ADR-0011), so the two scanners cannot drift on what a fence is. Task-list items (`- [ ]`) are dropped whole: an unchecked box is an intention, and importing one hands a gating edge to a note the author had not actually written.

### Filter the cues, keep gating

An item under the heading is its own declaration, and the words around the link qualify it. Three cues disqualify an item; everything else still authors its edge:

| cue | example | why it cannot gate |
|---|---|---|
| `negation` | `does not require [[x]]` | denies the very gate it names |
| `reversal` | `This note is a prerequisite for [[y]]` | states something true about the other direction |
| `disjunction` | `requires [[x]] or [[y]]` | offers a choice `areDependenciesSatisfied`, which knows only AND, cannot honour either way |

The screen runs on the item's prose with the links blanked out first, because names say things: `[[m/01-or-basics]]` and `[[x|either of the two]]` are not the author hedging. An item with two links and one `or` between them loses both rather than guessing which half was meant. The `for` arm of the reversal cue is the one that has to look ahead — `[[m/01]] is required for this lesson` puts the link at the far end of a normal prerequisite, while `This note is a prerequisite for [[m/02]]` makes the link the dependent; only the second is a reversal.

The cost is a real-but-hedged prerequisite — one edge lost, the numbered tree's still in place. Under-chaining is the direction this module chooses everywhere else.

### Resolution is fail-closed and never fatal

A reference resolves through a caller-owned lookup, and a miss costs its own edge and nothing else: a name naming no note is `missing`, a name naming several is `ambiguous`, and both are counted so the report can say so. The lookup index the adopt batch builds contains only the notes the batch may point at — the ones being adopted and the in-scope already-adopted ones — deliberately *not* every topic in the vault, so a note the learner excluded with `--exclude` cannot become a declared prerequisite because another note linked to it. That is the same guarantee the chain itself already honours.

A markdown link folds against the directory of the note holding it (`[setup](01-a.md)` inside `m/03-c.md` names `m/01-a.md`), which is why a reference carries its form: a wikilink names a vault path or a note name, a markdown link is relative to its holder, and a name alone cannot say which rule applies.

### The declared list replaces the inferred edge

One `depends_on_source` label covers a note's whole list, so a declared list replaces the chain's inferred predecessor rather than joining it, and the note is labelled `declared`. A note's own hand-written frontmatter `depends_on` is treated the same way — same claim, same label — and survives first adoption instead of being flattened to `[]` (#271).

### The prose scanner was removed

An earlier revision scanned sentences anywhere in the body for `requires X`. It was deleted, and the deletion is the decision worth recording:

- Measured over 11,168 real notes in two curricula, the prose branch produced **zero edges**. Every edge the feature produced came from a link.
- The shapes it *would* have turned into edges were exactly the review findings: `"requires patience and practice"`, `"requires more complex implementation"`, `"does not require X"`, `"no longer requires X"`.
- The apparatus built to stop it inventing gates — aside removal, clause boundaries, contrastive conjunctions, a two-mechanism negation detector — had a documented hole the author could not close: walking past a subject-free insertion cleared `does not, under any circumstances, when it is hard, require` and broke `does not need a calculator and requires Setup`, which the suite pins. Run over 35 strings, fixing one broke the other.

A sentence cannot be told apart from a description of what a lesson involves, and a wrong guess here hides a note from `palee plan` permanently, because mastery only falls and a gate never lifts itself. **A prerequisite worth gating on is a link.** The negation screen itself was not thrown away — it was recovered from that commit's parent and raised into the section branch, because two ideas of what a negation reads like is how one of them gets fixed and the other keeps gating.

## Consequences

### Positive

- The third gating source exists, so a vault whose author documented prerequisites in prose links gets them honoured on first adoption.
- The cue filter is a filter, not a parser: three rules, no clause analysis, and each rejected item is visible in the report (`Declared: N edge(s) … (M name(s) resolved to no single note)`).
- Removing the prose scanner deleted a whole class of future defects along with the feature — the tests there pin the hedged strings to declaring nothing.

### Negative / Tradeoffs

- **An unrecognized hedge still gates.** The reversal list is deliberately short (the phrasings #261 reported); an author who writes "this builds on X" under a prerequisites heading still authors an edge. The failure direction is deliberate: a hedge the engine cannot see is indistinguishable from a statement, and inventing a reverse edge to fix it would be a bigger claim than this module makes about any sentence.
- **A hedged real prerequisite is lost silently-ish.** It costs its own edge and the numbered tree's edge stays in place — reported, not silent, but the learner does not get the gate the author hedged into existence.

## Alternatives Considered

1. **Keep scanning prose for `requires X`.**
   - *Why Rejected*: zero measured yield over 11,168 notes, a defect list of exactly the shapes it would have turned into gates, and a negation apparatus with a documented unclosable hole. The feature was net-negative even before the maintenance cost.
2. **Parse hedged items instead of filtering them** (resolve `requires X or Y` to a choice).
   - *Why Rejected*: `areDependenciesSatisfied` knows only AND. Modelling OR-groups is #224's per-edge policy design (ADR-0013); until edges carry policy, the honest reading of a disjunction is "the engine does not lock a learner out on this."
3. **Join declared edges with the inferred ones instead of replacing.**
   - *Why Rejected*: one label per note (ADR-0009). Keeping an inferred `toc` edge beside a declared one would quietly promote an enumeration guess into a gate — the exact defect the tiered fix contains.
4. **Read the prerequisites section case-insensitively anywhere in the note** (any heading containing the phrase).
   - *Why Rejected*: `## Prerequisites for the lab` would turn an arbitrary section into a dependency list. The heading must be the trigger phrase and nothing else.
