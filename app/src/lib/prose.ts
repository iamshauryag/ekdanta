// Small text rules for help at the caret: the word being typed, whether the writer has written a
// sentence yet, and turning a model's reply into whole sentences. Shared by the app and the server,
// so no DOM here.
import { splitAfter } from './split.ts'

/** Letters and digits, with apostrophes inside a word ("don't"). */
const WORD_END = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*['’]?$/u
const WORD_START = /^[\p{L}\p{N}]*(?:['’][\p{L}\p{N}]+)*/u

/**
 * The word the caret is in or just after: `partial` is its letters before the caret, `suffix` those
 * after. Both are empty when the caret sits after a space, punctuation or an inline leaf (a page link,
 * a line break), which the caller says by passing what is directly before and after as text.
 */
export function wordAtCaret(before: string, after: string): { partial: string; suffix: string } {
  const partial = before.match(WORD_END)?.[0] ?? ''
  if (!partial) return { partial: '', suffix: '' }
  return { partial, suffix: after.match(WORD_START)?.[0] ?? '' }
}

/**
 * Short words that are complete as typed, so "the|" asks for the next word rather than "there" or
 * "theory". Longer words are left to the model, which says whether the fragment is finished.
 */
const COMPLETE = new Set(
  'a an the and or but nor so yet of to in on at by for with from as is was are were be been am i me my we our us you your he she it its they them their his her this that these those not no if then than when who what why how do did does has had have can could will would should may might must just very all any some one'.split(
    ' ',
  ),
)
export const isCompleteWord = (word: string) => COMPLETE.has(word.toLowerCase())

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/**
 * Has the writer written at least one sentence of their own? Generated text (⌘3 next word, ⌘4, ⌘5
 * continuing) needs one; before that, help offers questions only. Four words, or a short sentence
 * that ends ("I walk."), counts.
 */
export function hasOwnSentence(text: string) {
  const words = countWords(text)
  return words >= 4 || (words >= 2 && /[\p{L}\p{N}][.!?…]/u.test(text))
}

/** A model's prose as plain sentences: list markers, heading hashes and quote marks at line starts go. */
export function plainProse(raw: string) {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
        .replace(/^\*\*(.+)\*\*$/, '$1')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split prose into sentences, each keeping its closing punctuation (and any closing quote). */
export function sentences(text: string): string[] {
  return splitAfter(text, /([.!?…]["'”’)\]]*)\s+/g)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
}

/**
 * Whole sentences from the start of `text`: at most `maxSentences`, and no more than `maxWords`
 * words in all (the first sentence is kept even if it alone is longer, unless it runs past twice the
 * budget). An unfinished last sentence is dropped.
 */
export function wholeSentences(text: string, maxWords: number, maxSentences = 4): string {
  const all = sentences(text).filter((s) => /[.!?…]["'”’)\]]*$/.test(s))
  const kept: string[] = []
  let words = 0
  for (const s of all) {
    const n = countWords(s)
    if (kept.length >= maxSentences) break
    if (kept.length && words + n > maxWords) break
    if (!kept.length && n > maxWords * 2) break
    kept.push(s)
    words += n
  }
  return kept.join(' ')
}

/**
 * A list item of at most `maxWords`. Items are often fragments without a full stop, so a short one is
 * kept whole; a longer one is cut at its last whole sentence, or else at its last comma, semicolon or
 * colon, so it never stops mid-thought. Nothing usable inside the limit gives ''.
 */
export function listItem(text: string, maxWords = 40): string {
  const t = text.trim()
  if (countWords(t) <= maxWords) return t
  const whole = wholeSentences(t, maxWords, 4)
  if (whole && countWords(whole) <= maxWords) return whole
  const head = t.split(/\s+/).slice(0, maxWords).join(' ')
  const cut = head.search(/[,;:][^,;:]*$/)
  return cut > 0 && countWords(head.slice(0, cut)) >= 3 ? head.slice(0, cut) : ''
}

/** The first sentence of a ghost, keeping its leading space; the rest keeps its own. */
export function splitFirstSentence(text: string): [string, string] {
  const m = text.match(/^\s*[\s\S]*?[.!?…]+["'”’)\]]*(?=\s|$)/)
  if (!m) return [text, '']
  return [m[0], text.slice(m[0].length)]
}

/** The first word of a ghost, with the space before it. */
export const firstWord = (text: string) => text.match(/^\s*\S+/)?.[0] ?? text

export const capitalizeFirst = (text: string) => text.replace(/^(\s*["'“‘(]*)(\p{Ll})/u, (_, lead: string, c: string) => lead + c.toUpperCase())

/**
 * Join a continuation onto the writer's text. At the start of a paragraph it begins with a capital
 * and no space; on the writer's line it gets exactly one space, unless it opens with punctuation.
 */
export function joinOnto(scope: string, text: string, atParagraphStart: boolean) {
  const t = text.replace(/\n+/g, ' ').trimStart()
  if (atParagraphStart) return capitalizeFirst(t)
  if (!/\s$/.test(scope) && scope.length && !/^[,.;:!?)'’"…]/.test(t)) return ' ' + t
  return t
}

/**
 * Letters a model says finish the writer's last word, and any punctuation it put straight after them
 * ("d." is "d" then "."). Only a few letters count; anything else finishes nothing.
 */
export function wordEnding(s: string): [string, string] {
  const m = s.trim().match(/^([\p{L}\p{N}'’-]{1,20})([.,;:!?…]*)$/u)
  return m ? [m[1], m[2]] : ['', '']
}

/** Does a suggestion just repeat the text that already follows the caret? */
export function repeatsFollowing(text: string, after?: string) {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const t = norm(text)
  const a = norm(after ?? '')
  return t.length > 0 && a.length > 0 && (a.startsWith(t) || a.startsWith(t.split(' ').slice(0, 4).join(' ')) || (t.split(' ').length >= 6 && a.includes(t)))
}
