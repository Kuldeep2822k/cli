/**
 * The character class a terminal acts on, shared by every text sink.
 *
 * @remarks
 * Two boundaries needed this set and each spelled it separately: the AI
 * provider, where foreign response text becomes a message (#INV-30), and the
 * CLI display layer, where vault text becomes terminal output (#565 P2-06).
 * They differ only in what they substitute — `?` for wire-visible text,
 * deletion for display — so the classification lives here once.
 *
 * The class is C0 except tab, newline and carriage return (the three whitespace
 * controls both callers treat separately), DEL, the C1 range, and the bidi
 * overrides, isolates and marks that can reorder a rendered line without being
 * Cc: ALM, LRM, RLM, LRE/RLE/PDF/LRO/RLO, and the isolate controls.
 */
export const TERMINAL_ACTIVE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- the class is the point of this module
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
