// Document mode: a piece laid out as a page in MLA, APA or Chicago style, for writing that is handed in.
// Everything is flat front-matter on the piece (layout, style, paper, author, instructor, course,
// institution, date, target, due), so the file stays readable anywhere. This module is shared by the
// app and the server, so it has no DOM in it.
import type { Kind, KindDoc } from './kinds.ts'

export type DocStyle = 'mla' | 'apa' | 'chicago' | 'none'
export type Paper = 'letter' | 'a4'

export const STYLES: { id: DocStyle; label: string; note: string }[] = [
  { id: 'mla', label: 'MLA', note: 'Heading block, centred title' },
  { id: 'apa', label: 'APA', note: 'Title page, page numbers' },
  { id: 'chicago', label: 'Chicago', note: 'Title page' },
  { id: 'none', label: 'Plain', note: 'Just the page' },
]

/** Paper sizes, and the height of the text block inside 1in margins (for the page estimate). */
export const PAPER: Record<Paper, { label: string; width: string; height: string; css: string; widthIn: number; heightIn: number }> = {
  letter: { label: 'Letter', width: '8.5in', height: '11in', css: 'letter', widthIn: 8.5, heightIn: 11 },
  a4: { label: 'A4', width: '210mm', height: '297mm', css: 'A4', widthIn: 210 / 25.4, heightIn: 297 / 25.4 },
}
export const MARGIN_IN = 1
/** The height of a page's text block in CSS pixels (96 per inch). */
export const textBlockPx = (paper: Paper) => (PAPER[paper].heightIn - 2 * MARGIN_IN) * 96

/** The fields that make up the header or title page. */
export const HEADER_FIELDS = ['author', 'instructor', 'course', 'institution', 'date'] as const
export type HeaderField = (typeof HEADER_FIELDS)[number]

const isStyle = (s: string | undefined): s is DocStyle => s === 'mla' || s === 'apa' || s === 'chicago' || s === 'none'

export interface DocSettings {
  /** Shown as pages on a desk. */
  page: boolean
  /** The style, or null when none was chosen. An unknown one is kept in the file and shown as plain. */
  style: DocStyle | null
  paper: Paper
  target: string
  due: string
}

/** A piece's document settings, from its front matter. */
export function docOf(meta: Record<string, string | undefined>): DocSettings {
  const style = meta.style?.trim().toLowerCase()
  return {
    page: meta.layout?.trim().toLowerCase() === 'page',
    style: style ? (isStyle(style) ? style : 'none') : null,
    paper: meta.paper?.trim().toLowerCase() === 'a4' ? 'a4' : 'letter',
    target: meta.target?.trim() ?? '',
    due: meta.due?.trim() ?? '',
  }
}

/** Whether the piece offers the Document button: it has a layout or style, or its kind sets document defaults. */
export const usesDocument = (meta: Record<string, string | undefined>, kind?: Kind) => !!(meta.layout?.trim() || meta.style?.trim() || kind?.doc)

/** A kind's document defaults as front-matter keys, for a new piece of that kind. */
export function docDefaults(doc: KindDoc | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (doc?.layout) out.layout = doc.layout
  if (doc?.style) out.style = doc.style
  if (doc?.paper) out.paper = doc.paper
  if (doc?.target) out.target = doc.target
  return out
}

/**
 * A new, empty piece changed kind: take off what the old kind put on (keys still as it set them) and put on
 * the new kind's defaults, without overwriting anything the writer set themselves.
 */
export function kindSwitchPatch(meta: Record<string, string | undefined>, from: KindDoc | undefined, to: KindDoc | undefined): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  const old = docDefaults(from)
  const next = docDefaults(to)
  for (const [k, v] of Object.entries(old)) if (meta[k] === v && !(k in next)) patch[k] = null
  for (const [k, v] of Object.entries(next)) if (meta[k] === undefined || meta[k] === old[k]) patch[k] = v
  for (const k of Object.keys(patch)) if (patch[k] === (meta[k] ?? null)) delete patch[k]
  return patch
}

// ---- Dates -------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A YYYY-MM-DD date as a local calendar day, or null. */
export function parseDay(value: string | undefined): Date | null {
  const m = value?.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
}

/** The date as the style writes it: MLA "6 November 2026", APA and Chicago "November 6, 2026". Anything else stays as written. */
export function formatDate(value: string | undefined, style: DocStyle | null, now = new Date()): string {
  if (value?.trim() && !parseDay(value)) return value.trim()
  const d = parseDay(value) ?? now
  return style === 'mla' ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

const dayNumber = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)

/** "Due in 3 days", "Due today", "Overdue by 2 days", or null for no (or an unreadable) due date. */
export function dueLabel(due: string | undefined, now = new Date()): string | null {
  const d = parseDay(due)
  if (!d) return null
  const days = dayNumber(d) - dayNumber(now)
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days > 1) return `Due in ${days} days`
  if (days === -1) return 'Due yesterday'
  return `Overdue by ${-days} days`
}

// ---- Header, title page and running head --------------------------------------------------------

/** The first author's surname: "Jane Q. Smith" → "Smith", "Smith, Jane; Doe, John" → "Smith". */
export function surname(author: string | undefined): string {
  const first = (author ?? '').split(';')[0].trim()
  if (!first) return ''
  if (first.includes(',')) return first.split(',')[0].trim()
  const words = first.split(/\s+/).filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv|phd|md)$/i.test(w.replace(/,$/, '')))
  return words[words.length - 1] ?? ''
}

export type Header = { type: 'block'; lines: string[] } | { type: 'title-page'; title: string; lines: string[] } | null

/**
 * What goes above the text. MLA: the four-line block (author, instructor, course, date) and then the
 * centred title. APA and Chicago: a title page. A missing field's line is left out, never shown blank.
 */
export function headerOf(style: DocStyle | null, fields: Partial<Record<HeaderField, string>>, title: string, now = new Date()): Header {
  const f = (k: HeaderField) => fields[k]?.trim() ?? ''
  const date = formatDate(f('date') || undefined, style, now)
  if (style === 'mla') return { type: 'block', lines: [f('author'), f('instructor'), f('course'), date].filter(Boolean) }
  if (style === 'apa') return { type: 'title-page', title, lines: [f('author'), f('institution'), f('course'), f('instructor'), date].filter(Boolean) }
  if (style === 'chicago') return { type: 'title-page', title, lines: [f('author'), f('course'), f('instructor'), date].filter(Boolean) }
  return null
}

/** The running head at the top right of each printed page: MLA "Surname 4", APA and Chicago the page number. */
export function runningHead(style: DocStyle | null, author: string | undefined): { prefix: string; onFirst: boolean } | null {
  if (style === 'mla') {
    const s = surname(author)
    return { prefix: s ? s + ' ' : '', onFirst: true }
  }
  if (style === 'apa') return { prefix: '', onFirst: true }
  // A Chicago title page carries no number.
  if (style === 'chicago') return { prefix: '', onFirst: false }
  return null
}

const cssString = (s: string) =>
  '"' +
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\f]+/g, ' ') +
  '"'

/** The print rules for the page: paper size, 1in margins and the running head in the top-right margin box. */
export function pageCss(style: DocStyle | null, paper: Paper, author: string | undefined, font: string): string {
  const head = runningHead(style, author)
  const box = head ? ` @top-right { content: ${cssString(head.prefix)} counter(page); font: 12pt ${font}; color: #000; vertical-align: middle; }` : ''
  const first = head && !head.onFirst ? `\n@page :first { @top-right { content: none; } }` : ''
  return `@page { size: ${PAPER[paper].css}; margin: ${MARGIN_IN}in;${box} }${first}`
}
