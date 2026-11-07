// Edge lines: the subject, title, excerpt and opening line a piece is judged by, drawn from the
// writer's own sentences. Everything here is pure and shared by the app and the server, so the rules
// that keep a candidate honest (its source is really in the draft, it invents no number or name, it
// fits the slot) are tested in one place.

import { splitAfter } from './split.ts'

export type EdgeSlot = 'title' | 'opening' | 'subject' | 'excerpt'

/** The longest each slot may be, in characters. */
export const EDGE_LIMITS: Record<EdgeSlot, number> = { subject: 70, opening: 210, title: 90, excerpt: 300 }

export const EDGE_NAMES: Record<EdgeSlot, string> = { subject: 'Subject', opening: 'Opening line', title: 'Title', excerpt: 'Excerpt' }

/** Edge lines need a draft to draw from: at least this many of the writer's own sentences. */
export const MIN_SENTENCES = 3

export const NOTHING_FITS = 'Nothing short enough in your draft yet'
/** Asked for more after every line the draft offers has been shown. */
export const NO_MORE = 'No more lines in your draft'
export const TOO_SHORT = 'Write a few sentences first · these are drawn from your draft'

export interface EdgeCandidate {
  text: string
  /** The sentence of the draft it came from, exactly as it appears there. */
  source: string
}

/** Kinds whose title is never published: their edge is the first line people see instead. */
const OPENING_KINDS = new Set(['linkedin', 'text'])

/** Which slot ⌘3 in the title fills for a kind. */
export const titleSlot = (kind: string): EdgeSlot => (OPENING_KINDS.has(kind.toLowerCase()) ? 'opening' : 'title')

/** The front-matter field a kind gets a 'Suggest from my draft' link beside, if any. */
export function fieldSlot(kind: string): { slot: EdgeSlot; key: string } | null {
  const k = kind.toLowerCase()
  if (k === 'email') return { slot: 'subject', key: 'subject' }
  if (k === 'blog') return { slot: 'excerpt', key: 'excerpt' }
  return null
}

/** The link beside Subject or Excerpt shows only when the writer allows level-3 help. */
export const showSuggestLink = (ceiling: number) => ceiling >= 3

/**
 * What a help key pressed in the title does. Only one cell differs from the title's usual
 * behaviour (move to the body and run the level there): ⌘3, with help allowed up to 3 and a draft
 * of 3+ sentences, suggests a title (or an opening line) drawn from the draft.
 */
export function titleHelp(level: number, sentences: number, ceiling: number, kind: string): { mode: 'edge'; slot: EdgeSlot } | { mode: 'body' } {
  if (level === 3 && ceiling >= 3 && sentences >= MIN_SENTENCES) return { mode: 'edge', slot: titleSlot(kind) }
  return { mode: 'body' }
}

// Short forms whose full stop doesn't end a sentence ('Dr. Smith', 'e.g. this', 'J. Smith').
const ABBREVIATION = /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sr|Jr|St|Mt|vs|e\.g|i\.e|\p{Lu})\.$/u

// A line on its own that greets or signs off ('Hi Priya,', 'Thanks,', 'Best wishes,'): not a sentence.
const SALUTATION = /^(?:\S+\s+){0,3}\S+,$/

/** The sentences of a plain-text draft: whole sentences of two words or more, without greetings or sign-offs. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+/)
    .filter((line) => !SALUTATION.test(line.trim()))
    .flatMap((line) =>
      splitAfter(line, /([.!?…]["'”’)\]]*)\s+(?=\S)/g).reduce<string[]>((acc, part) => {
        if (acc.length && ABBREVIATION.test(acc[acc.length - 1])) acc[acc.length - 1] += ' ' + part
        else acc.push(part)
        return acc
      }, []),
    )
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 2)
}

const squash = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

/** Is `source` really in the draft? Only spacing and curly quotes may differ. */
export const inDraft = (source: string, draft: string) => !!squash(source) && squash(draft).includes(squash(source))

// A number with what makes it a different number: currency, decimals, a percent or a scale.
const NUMBER = /[$€£₹¥]?\d(?:[\d,.]*\d)?(?:\s?(?:%|percent\b|[kKmMbB]\b|bn\b|million\b|billion\b|thousand\b|x\b))?/g
const normNumber = (n: string) => n.replace(/[\s,]/g, '').toLowerCase()

/** Numbers in a candidate that don't appear in the draft, as written there ('$5M' needs '$5M', not just '5'). */
export function inventedNumbers(text: string, draft: string): string[] {
  const have = new Set((squash(draft).match(NUMBER) ?? []).map(normNumber))
  return (squash(text).match(NUMBER) ?? []).filter((n) => !have.has(normNumber(n)))
}

// Words that are capitalised for grammar, not because they name anything.
const COMMON = new Set(
  (
    'a an the and or but nor so yet for of in on at to by with from as into onto over under about after before ' +
    "i i'm me my we our us you your he she it its they them their this that these those what why how when where who which " +
    'is are was were be been am do does did have has had will would can could should may might must not no yes ' +
    'here there if then than just only also every each all some any more most less one why'
  ).split(' '),
)

/** Capitalised words (names, places, products) in a candidate that the draft never mentions. */
// Curly and straight apostrophes are the same letter: "Don’t" in a draft is "Don't" in a candidate.
export function inventedNames(text: string, draft: string): string[] {
  const words = new Set(
    (
      squash(draft)
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
    ).map((w) => w.replace(/'s$/, '')),
  )
  return (squash(text).match(/\p{Lu}[\p{L}\p{N}'-]*/gu) ?? []).filter((w) => {
    const lower = w.toLowerCase().replace(/'s$/, '')
    return !COMMON.has(lower) && !words.has(lower)
  })
}

/** Tidy a model's line for its slot: no wrapping quotes, no label, one line, no full stop after a title. */
export function cleanLine(text: string, slot: EdgeSlot) {
  let t = text
    .replace(/^\s*(subject|title|excerpt|opening line|headline)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  t = t.replace(/^["'“‘](.*)["'”’]$/s, '$1').trim()
  // One full stop goes; an ellipsis stays.
  if ((slot === 'title' || slot === 'subject') && t.endsWith('.') && !t.endsWith('..')) t = t.slice(0, -1)
  return t
}

/**
 * The candidates that survive the code guards, in order: the source really is in the draft, no
 * invented number or name, within the slot's length, not blank, not repeated, not shown before,
 * not what the field already says. At most five.
 */
export function guardCandidates(raw: unknown, draft: string, slot: EdgeSlot, opts: { avoid?: string[]; current?: string } = {}): EdgeCandidate[] {
  const list = Array.isArray(raw) ? raw : []
  // A line and the same line with a full stop are the same suggestion.
  const keyOf = (s: string) =>
    squash(s)
      .toLowerCase()
      .replace(/[.!?…]+$/, '')
  const seen = new Set([...(opts.avoid ?? []), opts.current ?? ''].map(keyOf).filter(Boolean))
  const out: EdgeCandidate[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const { text, source } = c as Partial<EdgeCandidate>
    if (typeof text !== 'string' || typeof source !== 'string') continue
    const t = cleanLine(text, slot)
    const key = keyOf(t)
    if (!t || !/[\p{L}\p{N}]/u.test(t) || t.length > EDGE_LIMITS[slot] || seen.has(key)) continue
    if (!inDraft(source, draft)) continue
    if (inventedNumbers(t, draft).length || inventedNames(t, draft).length) continue
    seen.add(key)
    out.push({ text: inWritersQuotes(t, draft), source: asWritten(source, draft) })
    if (out.length === 5) break
  }
  return out
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A sentence exactly as the draft has it (its quotes and spacing), not as the model copied it. */
export function asWritten(source: string, draft: string) {
  const pattern = squash(source)
    .split('')
    .map((ch) => (ch === "'" ? "['‘’]" : ch === '"' ? '["“”]' : ch === ' ' ? '\\s+' : escape(ch)))
    .join('')
  return draft.match(new RegExp(pattern))?.[0] ?? squash(source)
}

/** Apostrophes and quotes in the writer's style: a draft typed with curly ones gets curly ones back. */
export function inWritersQuotes(line: string, draft: string) {
  let t = line
  if (/’/.test(draft) && !/(\p{L})'(\p{L})/u.test(draft)) t = t.replace(/(\p{L})'(\p{L})/gu, '$1’$2')
  if (/[“”]/.test(draft) && !/"/.test(draft)) t = t.replace(/"([^"]*)"/g, '“$1”')
  return t
}

/**
 * The first paragraph after an opening line is accepted. A line drawn from the paragraph's own
 * first sentence replaces that sentence; any other line goes in front as a paragraph of its own,
 * so nothing the writer wrote is removed.
 */
export function openingEdit(firstParagraph: string, line: string, source: string): string {
  const first = sentencesOf(firstParagraph)[0]
  if (first && squash(first) === squash(source)) {
    const at = firstParagraph.indexOf(first)
    // A sentence in the middle of a paragraph still ends like one, even if the line was cut short.
    const end = /[.!?…:]["'”’)\]]*$/.test(line) ? '' : (first.match(/[.!?…]["'”’)\]]*$/)?.[0] ?? '')
    if (at >= 0) return firstParagraph.slice(0, at) + line + end + firstParagraph.slice(at + first.length)
  }
  return firstParagraph.trim() ? `${line}\n\n${firstParagraph}` : line
}

/** A short version of a source sentence for the faint 'from: …' line. */
export function fromLine(source: string, max = 90) {
  const s = source.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s
}
