// Length targets for a piece: front-matter `target: 1500-2000`. The writer types what their brief says
// ("1500", "1500-2000", "<=750", "5 pages", "5-6 pages") and the status bar shows how far along they are.
// Nothing here ever rewrites what was typed: a target it can't read shows as "?".
// Forms and portals cap characters instead ("4000 characters", "4000 characters no spaces"): one
// number of characters is a hard maximum, amber in its last 5% and red past it.

export type Unit = 'words' | 'pages' | 'characters'

export interface Target {
  unit: Unit
  /** The lowest length that meets the brief, or null when only a maximum was given. */
  min: number | null
  /** The highest length that meets it, or null when only a minimum was given. */
  max: number | null
  /** One number ("1500"): about that many (for characters: at most that many). */
  single: boolean
  /** Characters only: spaces and line breaks aren't counted ("4000 characters no spaces"). */
  noSpaces?: true
}

export type Parsed = Target | 'invalid' | null

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`
const UNIT = String.raw`(?:\s*(words?|w|pages?|pp?|pgs?|characters?|chars?|ch))?`
const num = (s: string) => Number(s.replace(/,/g, ''))
const unitOf = (u: string | undefined): Unit => (u && /^p/i.test(u) ? 'pages' : u && /^c/i.test(u) ? 'characters' : 'words')
/** What a character limit says it counts, after the number: "no spaces", "(including spaces and line breaks)". */
const SPACES = /\s*[,(]?\s*(?:(no|without|excluding|excl\.?|not counting)|including|incl\.?|with)\s+(?:spaces?(?:\s+(?:and|or|&)\s+line\s*breaks?)?|line\s*breaks?)\s*\)?$/i
const sane = (n: number) => Number.isFinite(n) && n > 0 && n <= 1_000_000

/** Read a target, or null when there is none, or 'invalid' when it can't be read. */
export function parseTarget(raw: string | undefined | null): Parsed {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return null
  const spaces = s.match(SPACES)
  if (spaces) {
    const t = parseTarget(s.slice(0, spaces.index))
    if (!t || t === 'invalid' || t.unit !== 'characters') return 'invalid'
    return spaces[1] ? { ...t, noSpaces: true } : t
  }
  let m = s.match(new RegExp(`^${NUM}${UNIT}$`, 'i'))
  if (m) {
    const n = num(m[1])
    return sane(n) ? { unit: unitOf(m[2]), min: n, max: n, single: true } : 'invalid'
  }
  m = s.match(new RegExp(`^${NUM}${UNIT}\\s*(?:-|–|—|to)\\s*${NUM}${UNIT}$`, 'i'))
  if (m) {
    const a = num(m[1])
    const b = num(m[3])
    if (!sane(a) || !sane(b) || (m[2] && m[4] && unitOf(m[2]) !== unitOf(m[4]))) return 'invalid'
    return { unit: unitOf(m[4] ?? m[2]), min: Math.min(a, b), max: Math.max(a, b), single: false }
  }
  m = s.match(new RegExp(`^(<=|≤|<|max(?:imum)?|at most|up to|under|no more than)\\s*${NUM}${UNIT}$`, 'i'))
  if (m) {
    const n = num(m[2])
    return sane(n) ? { unit: unitOf(m[3]), min: null, max: n, single: false } : 'invalid'
  }
  m = s.match(new RegExp(`^(>=|≥|>|min(?:imum)?|at least|over)\\s*${NUM}${UNIT}$`, 'i'))
  if (m) {
    const n = num(m[2])
    return sane(n) ? { unit: unitOf(m[3]), min: n, max: null, single: false } : 'invalid'
  }
  return 'invalid'
}

const fmt = (n: number) => n.toLocaleString('en-US')

/** The target as the status bar shows it, without its unit: "1,500–2,000", "≤ 750", "≥ 1,000", "1,500". */
export function formatTarget(t: Parsed): string {
  if (t === 'invalid') return '?'
  if (!t) return ''
  if (t.single || t.min === t.max) return fmt(t.min!)
  if (t.min === null) return `≤ ${fmt(t.max!)}`
  if (t.max === null) return `≥ ${fmt(t.min)}`
  return `${fmt(t.min)}–${fmt(t.max)}`
}

export type Progress = { state: 'neutral' | 'in' | 'near' | 'over'; fill: number }

/** How close to a character limit counts as near it: the last 5%. */
export const NEAR = 0.05

/**
 * How a count sits against a target: neutral on the way there, in range (green), over the maximum (amber).
 * One number of words means "about that many": within 10% either way. One number of pages means that many.
 * A maximum alone counts as in range from 80% of it.
 */
export function progress(count: number, t: Target): Progress {
  if (t.unit === 'characters') return limitProgress(count, t)
  let lo: number
  let hi: number
  if (t.single) {
    lo = t.unit === 'pages' ? t.min! : Math.round(t.min! * 0.9)
    hi = t.unit === 'pages' ? t.max! : Math.round(t.max! * 1.1)
  } else {
    lo = t.min ?? (t.unit === 'pages' ? t.max! : Math.round(t.max! * 0.8))
    hi = t.max ?? Infinity
  }
  const state = count > hi ? 'over' : count >= lo && count > 0 ? 'in' : 'neutral'
  const top = Number.isFinite(hi) ? hi : lo
  return { state, fill: top > 0 ? Math.max(0, Math.min(1, count / top)) : 0 }
}

/**
 * A character limit is a hard cap, as a portal enforces it: neutral, green once a minimum is met,
 * amber from 95% of the maximum (3,800 of 4,000), red past it. One number is a maximum.
 */
function limitProgress(count: number, t: Target): Progress {
  const max = t.max
  const min = t.single ? null : t.min
  const state = max !== null && count > max ? 'over' : max !== null && count >= max - Math.floor(max * NEAR) ? 'near' : min !== null && count >= min && count > 0 ? 'in' : 'neutral'
  const top = max ?? min ?? 0
  return { state, fill: top > 0 ? Math.max(0, Math.min(1, count / top)) : 0 }
}

/** The unit as the status bar writes it after a count. */
export const unitLabel = (t: Target) => (t.unit === 'characters' ? (t.noSpaces ? 'characters, no spaces' : 'characters') : t.unit)

// ---- Presets ---------------------------------------------------------------------------------

/** Common forms, written into `target:` as the writer would type them. */
export const PRESETS = [
  { id: 'commonapp', label: 'Common App', note: '250–650 words', target: '250-650 words' },
  { id: 'ucas', label: 'UCAS', note: '4,000 characters, counting spaces and line breaks', target: '4000 characters' },
  { id: 'abstract', label: 'Abstract', note: 'Up to 250 words', target: '<=250 words' },
] as const

/** The preset a target is, however it was typed ("4,000 chars" is UCAS), or null for anything else. */
export function presetOf(raw: string | undefined | null): (typeof PRESETS)[number] | null {
  const t = parseTarget(raw)
  if (!t || t === 'invalid') return null
  return PRESETS.find((p) => JSON.stringify(parseTarget(p.target)) === JSON.stringify(t)) ?? null
}

// ---- What counts ------------------------------------------------------------------------------

/** A top-level block of the document: its heading level (0 for anything else), its text if a heading, and its words. */
export interface Block {
  heading: number
  text: string
  words: number
}

/** A heading that starts the list of sources, which a word limit doesn't count. */
export const isReferencesHeading = (text: string) =>
  /^(works cited|works consulted|references|reference list|bibliography|select bibliography)$/i.test(
    text
      .replace(/[\s:.]+$/, '')
      .replace(/^\s+/, '')
      .replace(/\s+/g, ' '),
  )

/**
 * The words that count toward a limit: everything but a Works Cited, References or Bibliography heading
 * and what sits under it (up to the next heading of the same or a higher level). The header and title
 * page are never in the body, so they're never counted.
 */
export function countable(blocks: Block[]): { words: number; excluded: { heading: string; words: number }[] } {
  let words = 0
  const excluded: { heading: string; words: number }[] = []
  let skipping = 0 // the level of the references heading being skipped, or 0
  for (const b of blocks) {
    if (b.heading && skipping && b.heading <= skipping) skipping = 0
    if (b.heading && !skipping && isReferencesHeading(b.text)) {
      skipping = b.heading
      excluded.push({ heading: b.text.trim(), words: b.words })
      continue
    }
    if (skipping) excluded[excluded.length - 1].words += b.words
    else words += b.words
  }
  return { words, excluded }
}

// ---- Pages ---------------------------------------------------------------------------------

/** Rough words per double-spaced 12pt page, for when the page view isn't on screen to measure. */
export const WORDS_PER_PAGE = { letter: 275, a4: 290 } as const

export const pagesFromWords = (words: number, paper: 'letter' | 'a4') => (words > 0 ? Math.max(1, Math.ceil(words / WORDS_PER_PAGE[paper])) : 0)

/** How many pages a column of text this tall fills, given the height of a page's text block. */
export const pagesFromHeight = (height: number, perPage: number) => (perPage > 0 ? Math.max(1, Math.ceil((height - 1) / perPage)) : 1)

// ---- Platform limits -------------------------------------------------------------------------
// The hard limits a post meets when it's pasted into a platform. Counts are close to the platforms' own:
// LinkedIn counts characters as the reader sees them; X counts a link as 23 and wide scripts (CJK) and emoji as 2.

export const LINKEDIN_POST_LIMIT = 3000
export const X_POST_LIMIT = 280
/** X has no hard cap on a thread; past this many parts readers drop off, so a plan keeps within it. */
export const X_THREAD_MAX_PARTS = 25
/** X counts every link as this many characters, however long it is. */
export const X_URL_LENGTH = 23
/** About a minute spoken, at a conversational pace (2.5 words a second). */
export const SHORT_VIDEO_WORDS = 150

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemeList = (text: string): string[] => (graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (s) => s.segment) : Array.from(text))

const X_LINK = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"’”)]/gi

/** X's weight for one character: 1 for Latin through Arabic and common punctuation, 2 for wide scripts and emoji. */
function xWeight(g: string): number {
  const cp = g.codePointAt(0)!
  if (/\p{Extended_Pictographic}/u.test(g) || /\p{Regional_Indicator}/u.test(g)) return 2
  if (cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) return 1
  return 2
}

/** A post's length as X counts it. */
export function xLength(text: string): number {
  const s = text.trim().normalize('NFC')
  let n = 0
  let last = 0
  const plain = (t: string) => graphemeList(t).reduce((sum, g) => sum + xWeight(g), 0)
  for (const m of s.matchAll(X_LINK)) {
    n += plain(s.slice(last, m.index)) + X_URL_LENGTH
    last = m.index! + m[0].length
  }
  return n + plain(s.slice(last))
}

/** A post's length as LinkedIn counts it: the characters a reader sees, leading and trailing space left out. */
export const linkedinLength = (text: string) => graphemeList(text.trim()).length
