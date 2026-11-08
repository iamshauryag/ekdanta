// Break it down: a long piece (an essay, a newsletter issue, a script) into shorter posts for other
// platforms. The pure part, shared by the app and the server, so no DOM or Node here.
//
// A piece is read as numbered paragraphs ("units") of plain text. A plan says, for each post, which of
// the writer's own passages it draws on (each an exact span of one paragraph) and its angle. Creating
// the posts makes new drafts from those passages; how much the model may change the wording is the
// help ceiling's call, made on the server (server/breakdown.ts).
import type Token from 'markdown-it/lib/token.mjs'
import { tokenizer } from '../editor/markdown.ts'
import { isPromptParagraph } from './special.ts'
import { locateFind, words } from './assistant.ts'
import type { Kind } from './kinds.ts'
import { LINKEDIN_POST_LIMIT, SHORT_VIDEO_WORDS, X_POST_LIMIT, X_THREAD_MAX_PARTS, linkedinLength, xLength } from './targets.ts'

// ---- Formats ----------------------------------------------------------------------------------

export type Shape = 'post' | 'thread' | 'script'
export type Measure = 'linkedin' | 'x' | 'words'

export interface Format {
  /** 'linkedin', 'x-post', 'x-thread', 'short-video', or 'kind:<id>' for one of the writer's own kinds. */
  id: string
  /** Singular, as a writer says it: "X post". */
  label: string
  shape: Shape
  measure: Measure
  /** The most a post (a thread: each part) can be, in the measure's unit. */
  limit: number
  /** A limit the platform enforces (true), or only the kind's typical length (false). */
  hard: boolean
  /** A thread's most parts. */
  parts?: number
  /** Kind ids that fit, best first; the first the writer has files the post. */
  kinds: string[]
  /** The kind to add when the writer has none of those. */
  newKind?: string
  /** What the new draft's `target:` says, so the status bar shows the limit while they write. */
  target?: string
}

const X_KINDS = ['x', 'x-post', 'tweet', 'tweets', 'twitter', 'x-thread', 'thread', 'threads']

export const FORMATS: Format[] = [
  {
    id: 'linkedin',
    label: 'LinkedIn post',
    shape: 'post',
    measure: 'linkedin',
    limit: LINKEDIN_POST_LIMIT,
    hard: true,
    kinds: ['linkedin', 'linkedin-post'],
    newKind: 'LinkedIn post',
    target: `${LINKEDIN_POST_LIMIT} characters`,
  },
  { id: 'x-post', label: 'X post', shape: 'post', measure: 'x', limit: X_POST_LIMIT, hard: true, kinds: X_KINDS, newKind: 'X post', target: `${X_POST_LIMIT} characters` },
  { id: 'x-thread', label: 'X thread', shape: 'thread', measure: 'x', limit: X_POST_LIMIT, hard: true, parts: X_THREAD_MAX_PARTS, kinds: X_KINDS, newKind: 'X post' },
  {
    id: 'short-video',
    label: 'Short video script',
    shape: 'script',
    measure: 'words',
    limit: SHORT_VIDEO_WORDS,
    hard: true,
    kinds: ['short-video', 'short-video-script', 'shorts', 'short', 'reel', 'reels', 'tiktok', 'youtube-script'],
    newKind: 'Short video script',
    target: `<=${SHORT_VIDEO_WORDS} words`,
  },
]

/** The formats on offer: the built-in ones, then each of the writer's other kinds as a plain post of its typical length. */
export function formatsFor(kinds: Kind[]): Format[] {
  const covered = new Set(FORMATS.flatMap((f) => (kindFor(f, kinds) ? [kindFor(f, kinds)!.id] : [])))
  const own = kinds
    .filter((k) => !covered.has(k.id) && k.id !== 'essay')
    .map((k): Format => ({ id: `kind:${k.id}`, label: k.name, shape: 'post', measure: 'words', limit: k.words, hard: false, kinds: [k.id] }))
  return [...FORMATS, ...own]
}

export const findFormat = (kinds: Kind[], id: string) => formatsFor(kinds).find((f) => f.id === id)

/** The writer's kind a format files into, or undefined when it has to be added. */
export const kindFor = (f: Format, kinds: Kind[]) => {
  for (const id of f.kinds) {
    const k = kinds.find((k) => k.id === id)
    if (k) return k
  }
  return undefined
}

/** A post's length in the format's own measure. */
export function measure(f: Pick<Format, 'measure'>, text: string): number {
  if (f.measure === 'x') return xLength(text)
  if (f.measure === 'linkedin') return linkedinLength(text)
  return words(text)
}

export const unitName = (f: Pick<Format, 'measure'>) => (f.measure === 'words' ? 'words' : 'characters')

/** How a draft sits against its format: its length (a thread: its longest part), its parts, and whether it's over. */
export function fit(f: Format, body: string): { length: number; limit: number; parts: number; over: boolean } {
  if (f.shape === 'thread') {
    const parts = threadParts(body)
    const length = Math.max(0, ...parts.map((p) => measure(f, p)))
    return { length, limit: f.limit, parts: parts.length, over: length > f.limit || parts.length > (f.parts ?? Infinity) }
  }
  const length = measure(f, body)
  return { length, limit: f.limit, parts: 1, over: f.hard && length > f.limit }
}

// ---- The piece as paragraphs ------------------------------------------------------------------

export interface Unit {
  id: number
  /** The paragraph as plain text: no Markdown marks, links as their labels, footnote markers left out. */
  text: string
  /** The heading it sits under ('' before the first). */
  heading: string
}

const FOOTNOTE_REF = /\[\^[^\]\s]+\]/g
const FOOTNOTE_DEF = /^\s*\[\^[^\]\s]+\]:/

function inline(t: Token | undefined): string {
  let out = ''
  const links: { at: number; url: string }[] = []
  for (const c of t?.children ?? []) {
    switch (c.type) {
      case 'text':
      case 'code_inline':
        out += c.content
        break
      case 'softbreak':
        out += ' '
        break
      case 'hardbreak':
        out += '\n'
        break
      case 'wikilink': {
        const meta = c.meta as { target: string; label: string | null }
        out += meta.label ?? meta.target.split('#')[0].split('/').pop() ?? ''
        break
      }
      case 'link_open':
        links.push({ at: out.length, url: c.attrGet('href') ?? '' })
        break
      case 'link_close': {
        const link = links.pop()
        if (!link) break
        const label = out.slice(link.at)
        // A web address the reader needs goes after its label; a link inside the vault has none to give.
        if (/^https?:/i.test(link.url) && link.url !== label) out += ` (${link.url})`
        break
      }
      // Pictures stay in the piece: their files are next to it, and a post is text.
    }
  }
  return out
    .replace(FOOTNOTE_REF, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
}

/** The piece's paragraphs (list items and quotes included), in order, with the heading each is under. Front matter must be gone. */
export function unitsOf(body: string): Unit[] {
  const tokens = tokenizer().parse(body, {})
  const out: Unit[] = []
  let heading = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'heading_open') {
      heading = inline(tokens[i + 1])
      i += 2
    } else if (t.type === 'paragraph_open') {
      const tok = tokens[i + 1]
      i += 2
      const raw = tok?.content ?? ''
      if (FOOTNOTE_DEF.test(raw) || isPromptParagraph(raw)) continue
      const text = inline(tok)
      if (/[\p{L}\p{N}]/u.test(text)) out.push({ id: out.length + 1, text, heading })
    } else if (t.type === 'table_open') {
      // Tables don't break down into posts.
      while (i < tokens.length && tokens[i].type !== 'table_close') i++
    }
  }
  return out
}

/** Words in the piece, counted in every script (Chinese, Japanese, Thai included). */
export const unitWords = (units: Unit[]) => units.reduce((n, u) => n + words(u.text), 0)

/** Below this, a piece is short enough to post as it is. */
export const SHORT_WORDS = 100

/** Why a piece can't be broken down, or null when it can. */
export function tooShort(units: Unit[]): string | null {
  if (!units.length) return 'There’s no text in this piece to break down yet.'
  if (units.length < 2 || unitWords(units) < SHORT_WORDS) return 'This piece is short enough to post as it is: there’s nothing to break it down into.'
  return null
}

// ---- Passages ---------------------------------------------------------------------------------

export interface Passage {
  /** The paragraph it's from. */
  unit: number
  /** The writer's exact words: a span of that paragraph's text. */
  text: string
}

/**
 * The writer's passage for a quote: the exact span of one paragraph that it matches (quotes, dashes and
 * spacing folded), in the paragraph's own words, never the quote's. Null when no paragraph has it.
 */
export function findPassage(units: Unit[], quote: string, hint?: number): Passage | null {
  const q = quote.trim()
  if (!q || !/[\p{L}\p{N}]/u.test(q)) return null
  const order = hint ? [...units.filter((u) => u.id === hint), ...units.filter((u) => u.id !== hint)] : units
  for (const u of order) {
    const at = locateFind(u.text, q)
    if (at) return { unit: u.id, text: u.text.slice(at.start, at.end).trim() }
  }
  return null
}

// ---- Sentences and threads --------------------------------------------------------------------

/** Sentences, each with its closing punctuation, ended by Western or CJK stops. */
export function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)」』\]]*|$)\s*/gu) ?? []).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s))
}

/** CJK sentences sit together without a space; others take one. */
const joinSentences = (a: string, b: string) => (/[。！？」』]$/.test(a) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}「『]/u.test(b) ? a + b : `${a} ${b}`)

/** A passage cut into parts that fit, at sentence ends, in the writer's words. A sentence longer than the limit stays whole. */
export function splitToFit(text: string, limit: number, length: (s: string) => number): string[] {
  if (length(text) <= limit) return [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentencesOf(text)) {
    const joined = cur ? joinSentences(cur, s) : s
    if (cur && length(joined) > limit) {
      out.push(cur)
      cur = s
    } else cur = joined
  }
  if (cur) out.push(cur)
  return out
}

/** A thread's part break: an Obsidian comment line, hidden in Obsidian's reading view and never mistaken for a `---` rule. */
export const PART_MARKER = '%% part %%'

export const threadParts = (body: string) =>
  body
    .split(/^[ \t]*%%[ \t]*part[ \t]*%%[ \t]*$/gim)
    .map((p) => p.trim())
    .filter(Boolean)

/** Plain text that stays plain in Markdown: a line that would start a heading, list or quote is escaped. */
export const asMarkdown = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/, '$1\\$2'))
    .join('\n')

export const joinParts = (parts: string[]) => parts.map(asMarkdown).join(`\n\n${PART_MARKER}\n\n`)

/** A new draft's body made only of the writer's passages (and the opening line they kept), arranged for the format. */
export function quotedBody(f: Format, passages: string[], opening?: string): string {
  const blocks = [...(opening?.trim() ? [opening.trim()] : []), ...passages.map((p) => p.trim()).filter(Boolean)]
  if (f.shape !== 'thread') return blocks.map(asMarkdown).join('\n\n')
  return joinParts(blocks.flatMap((b) => splitToFit(b, f.limit, (s) => measure(f, s))))
}

// ---- A plan from the piece's own sections (no model) -------------------------------------------

export interface Target {
  format: string
  count: number
}

export interface PlannedPost {
  id: string
  format: string
  /** What the post is about, as a direction the writer reads; never a line to paste. */
  angle: string
  /** Help level 4 and up: a suggested opening line, used only if the writer keeps it. */
  hook?: string
  passages: Passage[]
}

/** Total posts a plan makes, at most. */
export const MAX_POSTS = 12
export const MAX_PER_TARGET = 10

/** The paragraphs grouped by heading, in order; a piece with too few headings is cut into runs of about equal length. */
function sections(units: Unit[], want: number): Unit[][] {
  const byHeading: Unit[][] = []
  for (const u of units) {
    const last = byHeading[byHeading.length - 1]
    if (last && last[0].heading === u.heading) last.push(u)
    else byHeading.push([u])
  }
  if (byHeading.length >= want) return byHeading
  const n = Math.min(want, units.length)
  const out: Unit[][] = []
  for (let i = 0; i < n; i++) out.push(units.slice(Math.floor((i * units.length) / n), Math.floor(((i + 1) * units.length) / n)))
  return out.filter((s) => s.length)
}

/** Passages from a section that fill a post of this format without going past its limit (always at least one). */
function fill(f: Format, section: Unit[]): Passage[] {
  const out: Passage[] = []
  let used = 0
  const room = f.shape === 'thread' ? f.limit * Math.min(8, f.parts ?? 8) : f.limit
  for (const u of section) {
    let text = u.text
    // A short post takes the paragraph's opening sentences that fit, not the whole paragraph.
    if (f.shape === 'post' && measure(f, text) > room - used) {
      const lead = splitToFit(text, Math.max(1, room - used), (s) => measure(f, s))[0]
      if (out.length && measure(f, lead) > room - used) break
      text = lead
    }
    out.push({ unit: u.id, text })
    used += measure(f, text) + (f.measure === 'words' ? 0 : 2)
    if (used >= room) break
  }
  return out
}

/** One format per post wanted, in the order asked, within the caps. */
export function slotsFor(targets: Target[], kinds: Kind[]): Format[] {
  return targets
    .flatMap((t) => {
      const f = findFormat(kinds, String(t?.format ?? ''))
      const n = Math.max(1, Math.min(MAX_PER_TARGET, Math.round(Number(t?.count) || 1)))
      return f ? Array.from({ length: n }, () => f) : []
    })
    .slice(0, MAX_POSTS)
}

/**
 * A plan made in code from the piece's own sections, for help level 1 and when no model answers: one
 * section (or run of paragraphs) per post, in order, each filled with the writer's passages that fit.
 * The angle is the section's heading, the writer's own words, when there is one.
 */
export function sectionPlan(units: Unit[], targets: Target[], kinds: Kind[]): PlannedPost[] {
  const slots = slotsFor(targets, kinds)
  if (!slots.length || !units.length) return []
  const secs = sections(units, slots.length)
  return slots.map((f, i) => {
    // More posts than sections: posts share sections, spread across the piece.
    const sec = secs[Math.floor((i * secs.length) / slots.length)]
    return { id: `p${i + 1}`, format: f.id, angle: sec[0].heading, passages: fill(f, sec) }
  })
}

// ---- Adapted wording: how much of it is the writer's -------------------------------------------

const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const wordList = (s: string) =>
  wordSegmenter
    ? Array.from(wordSegmenter.segment(s.toLowerCase()))
        .filter((w) => w.isWordLike)
        .map((w) => w.segment)
    : s
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter(Boolean)

/** The share of a text's words that appear in the writer's passages (0–1). An adaptation that keeps their words scores high. */
export function ownShare(text: string, passages: string[]): number {
  const mine = new Set(passages.flatMap(wordList))
  const theirs = wordList(text)
  if (!theirs.length) return 1
  return theirs.filter((w) => mine.has(w)).length / theirs.length
}

// ---- Links back to the piece -------------------------------------------------------------------

const baseName = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/i, '')

/**
 * How a new post names its piece in `from:`: `[[name]]` as Obsidian writes it, or `[[folder/name]]` when
 * another note has the same name. A wiki link finds its page by name, so a move keeps it working, and a
 * rename in Ekdanta or Obsidian rewrites it.
 */
export function wikiLinkTo(paths: string[], rel: string): string {
  const name = baseName(rel)
  const clash = paths.some((p) => p !== rel && baseName(p).normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase())
  return `[[${clash ? rel.replace(/\.md$/i, '') : name}]]`
}

/** The note a `from:` value links to, found as Obsidian finds it: by path when it has one, else by name (the shortest path wins). */
export function resolveWikiLink(paths: string[], value: string | undefined): string | null {
  const m = value?.trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/)
  if (!m) return null
  const target = m[1].trim().replace(/\.md$/i, '').normalize('NFC').toLowerCase()
  const key = (p: string) => p.replace(/\.md$/i, '').normalize('NFC').toLowerCase()
  if (target.includes('/')) return paths.find((p) => key(p) === target) ?? paths.find((p) => key(p).endsWith('/' + target)) ?? null
  const named = paths.filter((p) => baseName(key(p)) === target).sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  return named[0] ?? null
}

/** The posts drawn from a piece: every note whose `from:` links to it. */
export function derivedFrom<T extends { path: string; from?: string }>(files: T[], rel: string): T[] {
  const paths = files.map((f) => f.path)
  return files.filter((f) => f.path !== rel && f.from && resolveWikiLink(paths, f.from) === rel)
}

/** What `wording:` in a new post's front matter says about who wrote it. */
export const WORDING = { yours: 'yours', opening: 'yours, with a suggested opening line', adapted: 'adapted by the model from yours' } as const

// ---- What the server answers (server/breakdown.ts) ---------------------------------------------

export interface Habit {
  /** Past pieces of this kind it was read from. */
  pieces: number
  /** Their middle length, in the format's measure. */
  length: number
  /** A voice profile exists for the kind. */
  voice: boolean
}

export interface FormatInfo {
  id: string
  label: string
  shape: Shape
  measure: Measure
  limit: number
  unit: string
  hard: boolean
  parts?: number
  /** The kind it's filed as, and its folder; `adds` when that kind doesn't exist yet and creating will add it. */
  kind: string
  folder: string
  adds: boolean
  habit: Habit
}

export interface Options {
  title: string
  level: number
  /** What the help ceiling allows here, in the writer's words. */
  note: string
  allows: { plan: 'off' | 'sections' | 'model'; opening: boolean; adapt: 'none' | 'passages' | 'whole' }
  /** Why the piece can't be broken down, or null. */
  short: string | null
  words: number
  formats: FormatInfo[]
}

export type PlanReply =
  | { kind: 'plan'; level: number; by: 'model' | 'sections'; units: Unit[]; posts: PlannedPost[]; notes: string[] }
  | { kind: 'short'; message: string }
  | { kind: 'off'; message: string }
  | { kind: 'error'; message: string }

export interface PostRequest {
  format: string
  angle?: string
  /** The opening line the plan suggested, and whether the writer kept it. */
  hook?: string
  useHook?: boolean
  /** Ask the model to adapt the wording (help ceiling 5 and up). */
  adapt?: boolean
  passages: string[]
}

export interface Created {
  path: string
  title: string
  format: string
  wording: string
  length: number
  limit: number
  unit: string
  over: boolean
}

export interface CreateReply {
  created: Created[]
  notes: string[]
  addedKinds: string[]
}
