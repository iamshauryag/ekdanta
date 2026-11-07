// Counting as a form counts. Applications, grants and abstracts cap text by characters or words, and
// what they count is what lands in their box when the writer pastes: plain text, no front matter, no
// template prompts, no Markdown. formText() makes that text, and the status bar counts the very same
// string, so the number on screen is the number the portal sees.
import { tokenizer } from '../editor/markdown.ts'
import { prepare, toText, type PrepareOptions } from './plaintext.ts'
import { isReferencesHeading } from './targets.ts'

/** Curly quotes and apostrophes as typewriter ones, which every form takes. Non-breaking spaces as spaces. */
export function plainQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[  ]/g, ' ')
}

/** The piece as text for pasting into a form: `content` is the whole file, front matter and all. */
export function formText(content: string, page: PrepareOptions['page'] = () => null): string {
  return plainText(prepare(content, { page }).body)
}

const plainText = (markdown: string) => plainQuotes(toText(markdown, { style: 'plain' }).text)

/** A cheap first look: no heading could name a list of sources unless one of these words is there. */
const MAY_CITE = /works\s+c|reference|bibliography/i

/**
 * Words toward a word or page limit: the form's text, less a Works Cited, References or Bibliography
 * heading and what sits under it (up to the next heading of the same or a higher level), the same rule
 * countable() in targets.ts applies to the editor's blocks. Character limits count everything: a form
 * counts what is pasted into it.
 */
export function countedWords(content: string, page: PrepareOptions['page'] = () => null): { words: number; excluded: { heading: string; words: number }[] } {
  const { body } = prepare(content, { page })
  const words = countWords(plainText(body))
  if (!MAY_CITE.test(body)) return { words, excluded: [] }
  const lines = body.split('\n')
  const tokens = tokenizer().parse(body, {})
  const excluded: { heading: string; words: number; from: number; to: number }[] = []
  let level = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.level !== 0 || t.nesting === -1 || !t.map) continue
    const heading = t.type === 'heading_open' ? Number(t.tag.slice(1)) : 0
    if (heading && level && heading <= level) level = 0
    if (heading && !level && isReferencesHeading(plainText(tokens[i + 1]?.content ?? ''))) {
      level = heading
      excluded.push({ heading: plainText(tokens[i + 1].content).trim(), words: 0, from: t.map[0], to: t.map[1] })
    } else if (level) excluded[excluded.length - 1].to = t.map[1]
  }
  if (!excluded.length) return { words, excluded: [] }
  const out = excluded.map((x) => ({ heading: x.heading, words: countWords(plainText(lines.slice(x.from, x.to).join('\n'))) }))
  return { words: Math.max(0, words - out.reduce((n, x) => n + x.words, 0)), excluded: out }
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
