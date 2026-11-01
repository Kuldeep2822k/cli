/**
 * Reading-Path Input Size Guard
 *
 * @remarks
 * Storage-boundary ceiling on the bytes a note reader is willing to load
 * (issue #332). `scanNotes` and `loadTopics` used to hand `readFileSync` an
 * unbounded path, so one multi-megabyte file in the vault (an exported log, a
 * pasted diff, a generated index) was read whole and line-scanned on *every*
 * scan. The TOC reader already refuses to do that — `TOC_MAX_SOURCE_BYTES` in
 * `src/storage/toc.ts` declines an oversized document with a counted
 * `oversized` skip reason, stat-first so the bound covers the IO and not only
 * the parse (issue #263). This module is the same guard for the note-reading
 * path, kept in one place because two readers share it.
 *
 * It is deliberately a *separate* constant rather than a re-export of the TOC
 * ceiling: a topic note and a table of contents are different documents with
 * different natural sizes, and one shared name would let a change tuned for
 * READMEs silently move the note path's behaviour (and vice versa). The two
 * values are pinned equal here so the parity is explicit.
 */

/**
 * Largest note the reading path loads, in bytes — 512 KiB.
 *
 * @remarks
 * An order of magnitude above any hand-written topic note (the notes PALEE
 * reads carry a flat frontmatter block and study prose), so a legitimate note
 * is never declined; what crosses the line is a document that was not authored
 * as a note at all. Equal to `TOC_MAX_SOURCE_BYTES` (src/storage/toc.ts) by
 * decision, not by import — see the module header.
 */
const MAX_NOTE_SOURCE_BYTES = 512 * 1024;

/**
 * Builds the per-file diagnostic for a note the size guard declined.
 *
 * @param sizeInBytes - Byte size reported by `fs.statSync` for the note
 * @returns Message carried by {@link ScannedNote.readError}, naming both the
 *   observed size and the ceiling so the reader can tell "too large to read"
 *   apart from "could not be read"
 */
function oversizedNoteDiagnostic(sizeInBytes: number): string {
  return (
    `Oversized source: ${sizeInBytes} bytes exceeds the ${MAX_NOTE_SOURCE_BYTES} byte ` +
    'note read cap; the file was not read'
  );
}

/**
 * Whether a note's on-disk size is over the reading ceiling.
 *
 * @param sizeInBytes - Byte size reported by `fs.statSync`/`fs.fstatSync` for the note
 * @returns `true` when the note must not be read at all
 *
 * @remarks
 * #565 P1-10: the reading path applied this comparison inline (see `loader.ts` and
 * `scanner.ts`), and the write paths — `adopt`, `adopt --undo`, `roadmap` — applied
 * none, so a note too large to ever be read could still be adopted and reported as a
 * topic. Stating the comparison once means a write path cannot grow its own spelling
 * of the ceiling.
 *
 * Stat before read, never read-then-measure: `Buffer.byteLength` on content already in
 * memory leaves the allocation this guard exists to prevent.
 */
function noteExceedsReadCap(sizeInBytes: number): boolean {
  return sizeInBytes > MAX_NOTE_SOURCE_BYTES;
}

export { MAX_NOTE_SOURCE_BYTES, noteExceedsReadCap, oversizedNoteDiagnostic };
