/**
 * Splitting text at sentence ends without regex lookbehind.
 *
 * Safari before 16.4 cannot parse a lookbehind group, and one inside a regex literal is a syntax
 * error for the whole bundle: the page stays blank. So the client never uses one. Instead of
 * "split on whitespace that follows a full stop", a boundary is written as a global regex whose
 * first capture group is the part that stays with the piece before it (the stop, perhaps a closing
 * quote) and whose remainder is the separator that is dropped. compat.test.ts keeps it that way.
 */

/**
 * Split `text` at every match of `boundary`. Group 1 of each match stays at the end of the piece
 * before it; the rest of the match is dropped. `boundary` must be global and its group 1 must be
 * the start of the match. Behaves as `String.prototype.split` would with the group turned into a
 * lookbehind, provided the dropped part cannot be empty and group 1 holds no whitespace.
 */
export function splitAfter(text: string, boundary: RegExp): string[] {
  if (!boundary.global) throw new Error('splitAfter needs a global regex')
  const out: string[] = []
  let start = 0
  for (const m of text.matchAll(boundary)) {
    const cut = m.index + m[1].length
    out.push(text.slice(start, cut))
    start = m.index + m[0].length
  }
  out.push(text.slice(start))
  return out
}

/** Whitespace after a full stop, question mark or exclamation mark. */
export const AFTER_STOP = /([.!?])\s+/g
