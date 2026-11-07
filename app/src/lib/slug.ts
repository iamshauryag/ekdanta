// File and id names made from what the writer typed: a title, a kind's name. Shared by the app and
// the server, so no DOM or Node here.
//
// Any script works. Latin text loses its accents (Café notes → cafe-notes, as it always has, so
// existing files keep their names); other scripts keep their letters and marks exactly as typed, in
// NFC (Hangul stays composed, Devanagari keeps its virama and nukta). Everything that isn't a letter,
// mark or digit — spaces, punctuation, emoji, and the characters file systems refuse (/\:*?"<>|) —
// becomes a single hyphen.

/** A Latin letter and any marks after it: the only runs that lose their accents. */
const LATIN_RUN = /\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu
const NOT_NAME = /[^\p{L}\p{M}\p{N}]+/gu

/** `text` as a lower-case, hyphenated name of at most `max` characters, or '' if nothing nameable is left. */
export function slug(text: string, max: number): string {
  const s = text
    .normalize('NFC')
    .replace(LATIN_RUN, (run) => run.normalize('NFKD').replace(/\p{M}/gu, ''))
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(NOT_NAME, '-')
    .replace(/^-+|-+$/g, '')
    .normalize('NFC')
  // Cut by characters, not UTF-16 units, so a character outside the BMP is never split in two.
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('').replace(/-+$/, '')
}

/** A document's file name (without .md) from its title; a title with nothing nameable gets the date. */
export const docSlug = (title: string, date: string) => slug(title, 60) || `note-${date}`

/** Two names for the same file, however the file system spells them (macOS can hand back NFD). */
export const sameName = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC')
