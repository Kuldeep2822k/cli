/**
 * Roadmap Command Handler
 * Manages learning roadmaps (deterministic import via --from)
 *
 * P3-14 (#565): the handler's phases live beside it now — chain synthesis in
 * `./roadmap-chain`, the #139 single-source field derivation in
 * `./roadmap-resolve`, the canonical-path/descriptor-bound note IO in
 * `./roadmap-note`, and the preflight graph check plus the OCC-tracked write
 * loop in `./roadmap-import`. This file stays the orchestrator: input
 * parsing and format dispatch, the validation loop and its graph check, the
 * dry-run plan, and the confirmation gate, called in the same order the
 * monolith ran them.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadConfig } from './config';
import { resolveVaultTarget } from './vault-echo';
import { ExitCode, exitCodeFor } from './exit-codes';
import {
  parseRoadmapContent,
  resolveWikilinkRoadmap,
  loadTopics,
  relativeVaultPath,
} from '../storage';
import { isWithinVault } from '../storage/wikilink';
import { isResolvableNotePath } from '../storage/vault-walker';
import { noteExceedsReadCap, oversizedNoteDiagnostic } from '../storage/source-cap';
import { detectCyclesBounded } from '../engine/dependency';
import { isValidTopicId } from '../engine/topic-id';
import { RoadmapOptions, RoadmapFile, TopicNode } from '../types';
// P3-14 (#565): the roadmap phases, extracted from this handler.
import { applyRoadmapAutoChain, type RoadmapChainResult } from './roadmap-chain';
import { declaredIdOfNote, resolveTopicUpdates } from './roadmap-resolve';
import { canonicalDeclaredPath } from './roadmap-note';
import { planSurvivesSkippedNotes, importRoadmapTopics } from './roadmap-import';

// P3-14 (#565): the descriptor-bound read moved with the note IO to
// `./roadmap-note`; re-exported so this module's public surface — the default
// handler and this helper, both imported by tests and callers — is unchanged.
export { readBoundNote } from './roadmap-note';

/**
 * CLI command handler for validating and importing learning roadmaps into the vault.
 *
 * @param options - Roadmap options including `--from` file path, `--dry-run`
 * plan-only mode (prints the per-note write plan and writes nothing, exit `0`),
 * and `--yes` confirmation.
 * @returns Promise resolving when roadmap validation and import complete.
 * @remarks Sets process.exitCode = 2 on missing/invalid arguments, a `--from` path
 * that is not a regular file, or a missing vault; process.exitCode = 3 on dependency
 * cycles or validation errors in the roadmap, process.exitCode = 1 on partial import
 * failure, and process.exitCode = 5 on unexpected runtime exceptions.
 * @example
 * ```typescript
 * await roadmapCommand({ from: 'roadmap.yaml', yes: true });
 * ```
 */
async function roadmapCommand(options: RoadmapOptions): Promise<void> {
  try {
    if (!options.from) {
      console.error('Error: --from <file> is required');
      console.error('Usage: palee roadmap --from <roadmap.yaml|roadmap.md>');
      process.exitCode = ExitCode.Usage;
      return;
    }

    const config = loadConfig();
    // The roadmap's own source file is printed later; this names the vault those
    // notes are written into, which is the fact a mis-scoped run never reported (#311).
    // `json: false` keeps PALEE_JSON from switching this human-only command's
    // vault refusal to JSON above prose results.
    const target = resolveVaultTarget(config, { json: false });
    if (!target) return;
    const vaultPath = target.vaultPath;
    const roadmapPath = path.resolve(options.from);

    if (!fs.existsSync(roadmapPath)) {
      console.error(`Error: Roadmap file not found: ${roadmapPath}`);
      process.exitCode = ExitCode.Usage;
      return;
    }

    // A directory passes `existsSync` but `readFileSync` throws a raw `EISDIR`, which
    // the outer catch maps to an unexpected runtime exception (exit 5) — every other
    // usage error here exits 2. `statSync` (which follows a symlink) is used, not
    // `lstat`: the roadmap is an input this command only reads — it is never a vault
    // write target — so a symlink to a regular file is a legitimate `--from`. Only a
    // directory, or a dangling link (already caught by `existsSync`), is refused.
    if (!fs.statSync(roadmapPath).isFile()) {
      console.error(`Error: Roadmap path is not a file: ${roadmapPath}`);
      process.exitCode = ExitCode.Usage;
      return;
    }

    const rawContent = fs.readFileSync(roadmapPath, 'utf8');
    const parseResult = parseRoadmapContent(rawContent, roadmapPath);

    let roadmap: RoadmapFile;
    if (parseResult.format === 'wikilink') {
      // Wikilink format (#73, INV-48): resolve [[...]] chains against the vault.
      // Ambiguous/unresolved targets fail closed here (exit 3) with zero writes.
      try {
        roadmap = resolveWikilinkRoadmap(vaultPath, parseResult.sections ?? []);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = ExitCode.Validation;
        return;
      }
      console.log(`Resolved ${roadmap.topics.length} wikilink topics from ${roadmapPath}`);
    } else {
      if (!parseResult.roadmap || !parseResult.roadmap.topics || !Array.isArray(parseResult.roadmap.topics)) {
        console.error(`Error: ${parseResult.error || 'Roadmap must have a "topics" array'}`);
        process.exitCode = ExitCode.Usage;
        return;
      }
      roadmap = parseResult.roadmap;
    }

    // --auto-chain is scoped to YAML / frontmatter / code-block roadmaps
    // (INV-47). The wikilink format arrives already chained per `## Track`
    // section, so re-chaining it would fuse independent tracks.
    // The success-tone count is logged only after graph validation passes
    // (#73 review item 3): a chain the validator then rejected must not have
    // announced itself as fact.
    let chainResult: RoadmapChainResult | null = null;
    if (options.autoChain && parseResult.format !== 'wikilink') {
      chainResult = applyRoadmapAutoChain(roadmap.topics);
    }

    const errors: string[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const topicsMap = new Map<string, TopicNode>();

    const resolvedVault = fs.existsSync(vaultPath) ? fs.realpathSync(path.resolve(vaultPath)) : path.resolve(vaultPath);

    // Load existing vault topics before the validation loop so we can resolve
    // effective dependencies using the same rule for both validation and writeback.
    const existingTopics = loadTopics(vaultPath);
    const existingTopicsById = new Map(existingTopics.map((topic) => [topic.id, topic]));
    // The note that lives at each declared path, keyed through the same
    // canonicalizer the declarations use so `./x.md`, an absolute in-vault path
    // and the loader's vault-relative spelling of one note meet at one key.
    const existingTopicsByPath = new Map(
      existingTopics.map((topic) => [canonicalDeclaredPath(resolvedVault, topic.path), topic] as const)
    );

    // Effective deps per roadmap topic, computed once and shared by validation + doImport.
    // User-intent rules: explicit empty array clears, omitted preserves existing, populated replaces.
    const effectiveDepsMap = new Map<string, string[]>();

    for (const topic of roadmap.topics) {
      const { id, title, path: relativePath, difficulty, order } = topic;

      if (!id) errors.push('Topic missing "id" field');
      if (!title) errors.push('Topic missing "title" field');
      if (!relativePath) {
        errors.push('Topic missing "path" field');
      }

      // Only a present id/path can duplicate anything. An id-less topic was
      // still added to the seen-sets, so the second one was reported twice:
      // once for the missing field, once as a phantom `Duplicate topic ID: undefined`.
      if (id) {
        if (seenIds.has(id)) {
          errors.push(`Duplicate topic ID: ${id}`);
        }
        seenIds.add(id);
      }

      if (relativePath) {
        if (seenPaths.has(relativePath)) {
          errors.push(`Duplicate path: ${relativePath}`);
        }
        seenPaths.add(relativePath);
      }

      if (difficulty && !['beginner', 'intermediate', 'advanced'].includes(difficulty)) {
        errors.push(`Invalid difficulty for ${id}: ${difficulty}`);
      }

      if (order !== undefined && typeof order !== 'number') {
        errors.push(`Invalid order for ${id}: must be a number`);
      }

      // ID format (#308). The checks above this line are all all-or-nothing: a
      // roadmap holding any of them exits 3 with zero bytes written. A malformed
      // id was the one defect this gate passed — `if (!id)` asks only that the
      // field is non-empty, so `T-Alpha`, `bad-noprefix` and `T-bad_slug` were
      // written into the vault under a `Roadmap validated successfully.` line and
      // met by `palee validate` afterwards, at which point the notes, and every
      // edge naming those ids, were already on disk. Same policy, same gate:
      // `isValidTopicId` is the single source of truth the validate side uses
      // (`valid-topic-id-format`), so import and validate cannot disagree. It
      // also refuses a non-string `id`, which YAML produces for `id: 20240115` and
      // `id: [T-a]` — values the loader treats as no identity at all.
      // Checked on the parsed topic list, so all four input formats (pure YAML,
      // Markdown frontmatter, fenced YAML block, wikilink) are covered: the
      // wikilink resolver inherits a note's stored `palee_id`, so a bad id living
      // in the vault is refused here rather than rewritten around.
      if (id && !isValidTopicId(id)) {
        errors.push(
          `Invalid topic ID format: ${JSON.stringify(id)} (expected T- plus lowercase ` +
            'kebab-case slug, e.g. T-git-rebase)'
        );
      }

      // A degenerate placeholder id (`T-00000000-000000-00000000`) satisfies the
      // kebab-case shape — every segment is digits — so the format gate above passed
      // it and the import wrote a ghost note under a bogus, unsatisfiable identity.
      // Refuse the all-zero shape explicitly: it is never a hand-authored lesson id,
      // and the same all-or-nothing gate means a roadmap holding one writes zero bytes.
      // Side effect: a single all-zero segment (`T-0`) is also refused — an acceptable
      // trade-off, since a bare `T-0` is as useless as the placeholder it is meant to stop.
      if (id && isValidTopicId(id) && /^T-0+(?:-0+)*$/.test(id)) {
        errors.push(
          `Invalid topic ID: ${id} is a placeholder (all-zero segments). ` +
            'Give the topic a real kebab-case id, e.g. T-git-rebase.'
        );
      }

      // Path boundary validation: ensure topic path does not escape vault
      if (relativePath) {
        const absoluteTopicPath = canonicalDeclaredPath(resolvedVault, relativePath);
        if (!isWithinVault(resolvedVault, absoluteTopicPath)) {
          errors.push(`Topic "${id || '(unnamed)'}" path escapes vault boundary: ${relativePath}`);
        } else if (!isResolvableNotePath(relativeVaultPath(resolvedVault, absoluteTopicPath))) {
          // A path the walker cannot see is a note that exists for exactly one
          // command. `path: .md` is the sharpest case: `path.extname('.md')` is
          // empty, so the writer makes a directory named `.md`, drops `.md/.md`
          // inside it, reports "Created: 1 notes" and exits `0` — while every
          // segment starting with a dot is invisible to `walkVault`, so no other
          // command ever loads the note it just promised to create. Checked
          // before the first write, so the batch that would create it never starts.
          errors.push(
            `Topic "${id || '(unnamed)'}" path is not a visible Markdown note path in the vault: ${relativePath}`
          );
        } else if (id) {
          // A note the vault already adopted answers to the id on its own
          // frontmatter. Importing a different id over that path retired it:
          // every edge naming the old id resolved to no topic, which hard-blocks
          // the dependent notes out of `palee plan`, while `validate` counts a
          // missing dependency only as a warning and exits 0. The learner found
          // out afterwards, from a stderr list. INV-32 puts the decision before
          // any write instead, and names both ids so the roadmap can be corrected.
          const incumbent = existingTopicsByPath.get(absoluteTopicPath);
          // #565 P1-10: a target over the read cap cannot be imported. `loadTopics` and
          // the write loop both decline such a file, so the importer cannot see the
          // `depends_on` the note already holds — which means it cannot prove the graph it
          // writes stays acyclic, and an identity minted here would never be surfaced by
          // any reading command. Fail closed, before the first write, like the wikilink
          // format does for the same condition.
          //
          // `lstatSync`, not `existsSync` + `statSync`: this probe asks about the
          // directory entry, the same question every guard on the write path asks.
          // `existsSync` follows a link and reads a dangling one as absent (#565 P1-08).
          //
          // The size is then read only off a regular file (#565 P1-10 review): a
          // directory entry has a size too — a wide Linux directory crosses 512 KiB — and
          // refusing the whole batch for one would turn a target the write loop already
          // declines per topic, as "not a regular file", into a vault-wide error. A link
          // and a directory are decided by that inspection, which stays the one place
          // that judges what is importable; this preflight judges only the notes.
          let targetStat: fs.Stats | null = null;
          try {
            targetStat = fs.lstatSync(absoluteTopicPath);
          } catch {
            targetStat = null;
          }
          if (targetStat !== null && targetStat.isFile() && noteExceedsReadCap(targetStat.size)) {
            errors.push(
              `Topic "${id}" targets ${relativePath}. ${oversizedNoteDiagnostic(targetStat.size)} — every ` +
                'reading command skips it, so it cannot be imported. Nothing was written.'
            );
          } else if (incumbent && incumbent.id !== id) {
            errors.push(
              `Topic "${id}" targets ${relativePath}, which is already adopted as "${incumbent.id}". ` +
                `Importing would retire "${incumbent.id}" and orphan every edge that names it. ` +
                `Give this entry the id the note already carries, or point it at a new path.`
            );
          } else if (!incumbent) {
            // No incumbent is not the same as no identity: the loader is blind to a
            // `palee_id` that is not a usable string, so a note declaring
            // `palee_id: 20240115` looked unadopted here and the import wrote over
            // it anyway. Ask the note. A block that will not parse is deliberately
            // not refused: its write throws in `updateFrontmatter`, the topic is
            // isolated and named, the bytes are untouched, and pre-invalidating the
            // whole batch would cost the vault the import resilience it documents.
            const declared = declaredIdOfNote(absoluteTopicPath);
            // Only a string can *be* this entry's id. `String(raw)` would read the
            // single-element list `[T-a]` as `"T-a"` and wave the entry through,
            // then replace the array with a string — while `loadTopics` and the
            // wikilink resolver both call a non-string id unusable. Match them.
            if (
              declared.kind === 'declared'
              && !(typeof declared.raw === 'string' && declared.raw.trim() === id)
            ) {
              errors.push(
                `Topic "${id}" targets ${relativePath}, which declares palee_id ` +
                  `${JSON.stringify(declared.raw)} — a declared identity this entry does not carry. ` +
                  `Give the entry the id the note declares, or correct the note to "${id}"; ` +
                  'importing over a declared identity replaces it silently.'
              );
            }
          }
        }
      }

      // Single-source-of-truth derivation (#139): both the graph/validation pass
      // and the doImport writeback resolve effective fields through
      // resolveTopicUpdates — never re-derive here.
      const resolved = resolveTopicUpdates({
        topic,
        existingById: existingTopicsById.get(id),
        existingAtPath: {}, // validation checks roadmap-declared fields; at-path frontmatter is a writeback concern
      });
      effectiveDepsMap.set(id, resolved.depends_on);
      topicsMap.set(id, { palee_id: id, depends_on: resolved.depends_on, topic_mastery: 0 });
    }

    for (const t of existingTopics) {
      if (!topicsMap.has(t.id)) {
        // `exactOptionalPropertyTypes` rejects explicit `undefined`, so the
        // key is only set when the note actually carries dependencies; the
        // cycle pass treats a missing `depends_on` the same as `undefined`.
        topicsMap.set(t.id, {
          palee_id: t.id,
          ...(t.depends_on !== undefined ? { depends_on: t.depends_on } : {}),
          topic_mastery: 0,
        });
      }
    }

    for (const topic of roadmap.topics) {
      const deps = effectiveDepsMap.get(topic.id) ?? [];
      for (const depId of deps) {
        if (!topicsMap.has(depId)) {
          errors.push(`Topic ${topic.id} depends on missing topic: ${depId}`);
        }
      }
    }

    const { cycles, truncated } = detectCyclesBounded(topicsMap);
    for (const cycle of cycles) {
      let message = `Dependency cycle detected: ${cycle.join(' → ')}`;
      // Name the hops the flag invented: a learner who authored one dependency
      // should not have to deduce which edge --auto-chain added to the loop.
      if (chainResult && chainResult.synthesizedEdges.size > 0) {
        const ours: string[] = [];
        for (let i = 0; i + 1 < cycle.length; i++) {
          if (chainResult.synthesizedEdges.has(cycle[i] + '\u0000' + cycle[i + 1])) {
            ours.push(cycle[i] + ' → ' + cycle[i + 1]);
          }
        }
        if (ours.length > 0) {
          message += ' (synthesized by --auto-chain: ' + ours.join(', ') + '; the rest are authored)';
        }
      }
      errors.push(message);
    }
    if (truncated) {
      errors.push('Dependency cycle enumeration truncated at 1000 cycles — additional cycles may exist');
    }

    if (errors.length > 0) {
      console.error('Validation errors:');
      for (const err of errors) {
        console.error(`  • ${err}`);
      }
      process.exitCode = ExitCode.Validation;
      return;
    }

    // Deferred to this point so a chain the validator then rejects never
    // announces itself as fact (#73 review item 3).
    if (chainResult) {
      // The count is edges actually synthesized, not topics in the file: a
      // cycle-closing edge is dropped into `skippedEdges` instead, and a topic
      // that starts a chain received nothing at all, so reporting the topic
      // count as "chained" overclaimed the work this pass did (INV-47).
      console.log(
        `Auto-chain: ${chainResult.synthesizedEdges.size} chain edge(s) synthesized across ${roadmap.topics.length} roadmap topics.`
      );
      if (chainResult.skippedEdges.length > 0) {
        console.log(
          `Auto-chain: ${chainResult.skippedEdges.length} chain edge(s) skipped to keep the graph acyclic.`
        );
      }
    }

    console.log('Roadmap validated successfully.');
    console.log(`  Topics: ${roadmap.topics.length}`);
    console.log(`  Source: ${roadmapPath}`);
    console.log();
    console.log('This will create/update the following files:');
    for (const topic of roadmap.topics) {
      console.log(`  • ${topic.path}`);
    }
    console.log();

    // The vault-facing state the preflight graph check and the import's write
    // loop share (P3-14: both phases live in `./roadmap-import`, which receives
    // this bundle; the maps are mutated in place above, so the references the
    // bundle holds are the same objects the passes read).
    const writeCtx = {
      resolvedVault,
      topics: roadmap.topics,
      existingTopicsById,
      topicsMap,
    };

    // #442 (bug 6): the real ghost-note defect — a fabricated identity — is refused
    // outright by the placeholder gate in the validation loop (all-zero ids). A
    // well-formed id that is simply new is the legitimate purpose of `roadmap --from`,
    // and it is already disclosed by the create/update listing above and the
    // `Created: N notes` summary after import, so no separate pre-confirm warning is
    // emitted here (that fired on every fresh-curriculum import and before a decline).

    // #309: this command rewrites `depends_on` across the vault, so `--dry-run`
    // prints the full per-note plan — id, target path, resolved `depends_on`
    // (chain synthesis and on-disk preservation made visible), create-vs-update
    // from the same `lstat` existence test the import uses — and returns before
    // the confirm gate. Zero bytes are written. The plan reads `effectiveDepsMap`,
    // derived through `resolveTopicUpdates`, the single source of truth the
    // writeback consumes, so the printed list is the list an import would write.
    if (options.dryRun) {
      // #565 P1-10 review: this branch used to print the plan and exit `0` for the very
      // bytes the import refuses with exit `3`, because the skipped-note graph check ran
      // only inside `doImport`. `--dry-run` promises the plan an import would carry (#309),
      // and that promise has to include the refusal — otherwise the learner approves an
      // import that cannot proceed and hears about it only when they run it for real.
      if (!planSurvivesSkippedNotes(writeCtx)) return;
      let createCount = 0;
      let updateCount = 0;
      console.log('Dry-run plan (no files were written):');
      for (const topic of roadmap.topics) {
        const absolutePath = canonicalDeclaredPath(resolvedVault, topic.path);
        let exists = true;
        try {
          fs.lstatSync(absolutePath);
        } catch {
          exists = false;
        }
        if (exists) {
          updateCount++;
        } else {
          createCount++;
        }
        const noteState = exists ? 'update existing note' : 'create new note';
        console.log(`  • ${topic.id} → ${topic.path} (${noteState})`);

        const deps = effectiveDepsMap.get(topic.id) ?? [];
        const shown = deps.map((dep) =>
          chainResult !== null && chainResult.synthesizedEdges.has(`${topic.id}` + '\u0000' + dep)
            ? `${dep} (synthesized by --auto-chain)`
            : dep
        );
        let note = '';
        if (topic.depends_on === undefined) {
          note = exists
            ? deps.length > 0
              ? ' (entry declares no depends_on: the note keeps its own edges)'
              : ' (entry declares no depends_on)'
            : ' (new note, no dependencies)';
        } else if (topic.depends_on.length === 0 && deps.length === 0) {
          const held = existingTopicsById.get(topic.id)?.depends_on?.length ?? 0;
          note =
            held > 0
              ? ` (explicit empty list: would clear ${held} existing dependenc${held === 1 ? 'y' : 'ies'})`
              : ' (explicit empty list)';
        }
        console.log(`      depends_on: ${shown.length > 0 ? shown.join(', ') : '(none)'}${note}`);
      }
      console.log();
      console.log(
        `Dry-run complete. ${createCount} note(s) would be created, ${updateCount} updated. No files were modified.`
      );
      process.exitCode = ExitCode.Success;
      return;
    }

    if (!options.yes && !process.stdin.isTTY) {
      console.error('Error: Non-interactive environment detected. Use --yes to confirm import.');
      process.exitCode = ExitCode.Usage;
      return;
    }

    if (options.yes) {
      console.log('Auto-confirmed via --yes.');
      await importRoadmapTopics({ ...writeCtx, vaultPath });
    } else {
      console.log('Proceed? (y/N): ');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // readline stops calling the question callback once stdin reaches EOF, so a
      // run whose input ends here would wait on a promise that never settles and
      // exit 0 having written nothing. An empty answer already means "Aborted."
      const answer = await new Promise<string>((resolve) => {
        const onEof = (): void => resolve('');
        rl.once('close', onEof);
        rl.question('', (text) => {
          rl.off('close', onEof);
          resolve(text);
        });
      });
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
      await importRoadmapTopics({ ...writeCtx, vaultPath });
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.error(`Error: ${err.message}`);
    process.exitCode = exitCodeFor(e);
    return;
  }
}

export default roadmapCommand;
