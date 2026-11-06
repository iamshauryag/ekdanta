// Counting as a form counts. Applications, grants and abstracts cap text by characters or words, and
// what they count is what lands in their box when the writer pastes: plain text, no front matter, no
// template prompts, no Markdown. formText() makes that text, and the status bar counts the very same
// string, so the number on screen is the number the portal sees.
import { prepare, toText, type PrepareOptions } from './plaintext.ts'

/** Curly quotes and apostrophes as typewriter ones, which every form takes. Non-breaking spaces as spaces. */
export function plainQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[  ]/g, ' ')
}

/** The piece as text for pasting into a form: `content` is the whole file, front matter and all. */
export function formText(content: string, page: PrepareOptions['page'] = () => null): string {
  const { body } = prepare(content, { page })
  return plainQuotes(toText(body, { style: 'plain' }).text)
}

let segmenter: Intl.Segmenter | null | undefined

/**
 * Characters as a person counts them: an emoji with a skin tone, a flag, or a letter with its accent
 * is one, as are Devanagari and Hangul syllables. A line break is one character too.
 */
export function graphemes(s: string): number {
  if (!s) return 0
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  if (!segmenter) return Array.from(s.replace(/\r\n/g, '\n')).length
  let n = 0
  for (const _ of segmenter.segment(s)) n++
  return n
}

export interface CountOptions {
  /** Leave spaces, tabs and line breaks out, as "4000 characters no spaces" asks. */
  noSpaces?: boolean
}

/** Characters in a piece of text. */
export const countChars = (text: string, opts: CountOptions = {}) => graphemes(opts.noSpaces ? text.replace(/\s+/g, '') : text)

/** Words as the editor counts them: runs between spaces that hold a letter or a digit. */
export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
