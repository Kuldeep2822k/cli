# ADR-0015: Identity Preservation — An Identity on Disk Is Not a Command's to Invent

## Status

Accepted

## Context

`loadTopics` requires a non-empty **string** `palee_id` by design (B7, `src/engine/tier0-hygiene.ts`). A note whose id YAML read as a number (`palee_id: 20240115`), or whose frontmatter will not parse at all, is therefore absent from its output — invisible to the scan.

Both commands that adopt *by path* then went on to mint a fresh id for that same note. The topic was renamed under the learner: every edge naming the old id resolved to nothing, the dependent notes left `palee plan` permanently, and `palee validate` counted a missing dependency only as a warning and exited 0. The learner found out afterwards, from a stderr list — or not at all.

This was the first batch from the v0.6.0 audit sweep (#269's "Loss of user-authored state" group, #277), and the rule it established is the one this ADR records.

## Decision

**An identity on disk is not a command's to invent.** When a note at the target path already declares a `palee_id` — of any YAML type — the import either adopts that identity or refuses; it never overwrites it silently.

Four mechanisms implement the rule:

1. **The note is asked directly, not through the loader.** `declaredIdOfNote` reads the note's own frontmatter, because `loadTopics` is blind to a non-string id by design and an import keyed on the scan would overwrite a declared identity anyway — the same silent rename, reached through the scan instead of around it.
2. **Only a string can be the entry's id.** `String(["T-list-a"])` is `"T-list-a"`, so an entry naming that id passed preflight over a note declaring `palee_id: [T-list-a]`, and the write coerced the array to a string. Every other declared type is now refused, matching `loadTopics` and the wikilink resolver, which both call a non-string id unusable. Symmetrically, `String([])` is the empty string, so a declared-but-unusable value read as "nothing declared" and minted — only a blank *string* now declares nothing.
3. **The mint refuses, and the scan skips by name.** A note carrying a truthy non-string id is neither adopted nor chained under `--auto-chain` (B7), and `adopt` skips it by name rather than treating it as an unadopted bridge note that resolves to no id at all.
4. **An unterminated frontmatter opener is judged by the parser's own delimiters.** An opener with no closing fence yields no frontmatter and no error, so the note entered the batch and the commit prepended a fresh block with a minted id — stranding the learner's own in the body. Both delimiters are compared exactly, as the parser matches them: a padded `--- ` opener is no frontmatter at all (adoptable), while an indented ` ---` closes nothing (refused). The disagreeing direction is the one that strands an identity.

### What is deliberately not refused

A frontmatter block that **will not parse** is not made a validation error. Its write throws in `updateFrontmatter`, the topic is isolated and named, its bytes are never replaced — and making it a validation error "traded one named failure for the whole batch refusing to run, which is the resilience `palee roadmap` documents." One named failure the learner can act on beats a batch that never starts.

The same asymmetry governs the adopt scan: a malformed note keeps a bad note out of the scan's conclusions instead of aborting it — named, skipped, and the rest of the batch adopts (INV-11).

## Consequences

### Positive

- The silent rename class is closed at both adopting commands, and the refusal names both ids so the roadmap can be corrected ("Give this entry the id the note already carries, or point it at a new path").
- The rule has one owner per concern: B7 in the hygiene module for what counts as an identity, `declaredIdOfNote` for reading one off disk, and the two commands refuse rather than invent.
- Every trap the audit found is pinned by its own test, including the `String()` coercions — the tests fail without the guards and nothing else.

### Negative / Tradeoffs

- **A vault carrying numeric ids cannot be migrated by adoption.** Such notes are skipped, not repaired; fixing the note is the learner's to do (or `migrate`'s, on a future pass). The failure direction is deliberate: guessing an identity is the defect this ADR exists to prevent.
- **The exact-delimiter match means a padded `--- ` opener stays adoptable** even though it looks like a mistake to a human — because the parser sees no frontmatter there, and adoption is documented as strictly non-destructive.

## Alternatives Considered

1. **Coerce a non-string id to a string and adopt it.**
   - *Why Rejected*: `loadTopics` reads the field as 0 or nothing, and `validate` rejects it — three answers from one note, and the command that adopts by path would be the most permissive. The loader's blindness is the contract; the commands now match it instead of routing around it.
2. **Make a non-string `palee_id` a validation error that blocks the batch.**
   - *Why Rejected*: it trades one named failure for the whole batch refusing to run. `palee roadmap` documents resilience as a property — a bad note costs its own topic, not the import.
3. **Trim the delimiter lines before comparing** (accept `--- ` as an opener).
   - *Why Rejected*: it disagrees with the parser in both directions, and the disagreeing direction is the one that strands an identity — an indented closer accepted means a second frontmatter block prepended over an unreadable `palee_id`.
4. **Keep minting for unparseable notes but warn louder.**
   - *Why Rejected*: a warning is not a refusal. The learner's identity was already gone by the time the warning printed, and every edge naming it was already dangling.
