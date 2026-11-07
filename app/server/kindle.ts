// Highlights from elsewhere, read offline: a Kindle's "My Clippings.txt" and a Readwise CSV export.
// This is the one Kindle parser; everything that imports clippings goes through it. Pure: text in,
// books out, no file system.
import Papa from 'papaparse'
import { normText, sameWork, type Highlight } from '../src/lib/brain.ts'

export interface ImportHighlight extends Highlight {
  /** The location range Kindle gave, for spotting a highlight the reader later extended. */
  range?: [number, number]
  page?: number
}

export interface ImportBook {
  title: string
  author: string
  highlights: ImportHighlight[]
}

export interface Parsed {
  books: ImportBook[]
  /** Entries that looked like clippings but couldn't be read. */
  skipped: number
}

// Words Kindle uses for each kind of clipping and for where it is, in the languages it ships in.
const HIGHLIGHT = /highlight|markierung|surlignement|subrayado|evidenziazione|markering|destaque|marca|подчеркивание|выделение|ハイライト|标注|標註|하이라이트/i
const NOTE = /\bnote\b|\bnotiz\b|\bnota\b|\bnotitie\b|заметка|メモ|笔记|筆記|메모/i
const BOOKMARK = /bookmark|lesezeichen|signet|marcador|segnalibro|bladwijzer|закладка|ブックマーク|书签|書籤|북마크/i
const CLIP = /\bclip\b|ausschnitt|extrait|recorte|ritaglio/i
const LOCATION = /(?:location|loc\.|position|pos\.|emplacement|posición|posizione|positie|posição|позиция|положение|位置|위치)\s*(?:no\.\s*)?(\d+)(?:\s*[-–]\s*(\d+))?/i
const LOCATION_CJK = /(?:位置|位置No\.)\s*(\d+)(?:\s*[-–]\s*(\d+))?|(\d+)(?:\s*[-–]\s*(\d+))?\s*(?:の位置|位置)/
const PAGE = /(?:\bpage|\bseite|página|\bpagina|\bpágina|страница|стр\.|ページ|页|頁|페이지)\s*(\d+)|(\d+)\s*(?:ページ|页|頁|페이지)/i

/** "Title (Author)" → its parts. The author is in the last brackets. */
function titleLine(line: string): { title: string; author: string } {
  const m = line.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
  return m && m[1].trim() ? { title: m[1].trim(), author: m[2].trim() } : { title: line.trim(), author: '' }
}

type Kind = 'highlight' | 'note' | 'bookmark' | 'clip' | null

function kindOf(meta: string): Kind {
  if (BOOKMARK.test(meta)) return 'bookmark'
  if (NOTE.test(meta) && !HIGHLIGHT.test(meta)) return 'note'
  if (HIGHLIGHT.test(meta)) return 'highlight'
  if (CLIP.test(meta)) return 'clip'
  return null
}

function placeOf(meta: string): { range?: [number, number]; page?: number } {
  const out: { range?: [number, number]; page?: number } = {}
  const loc = meta.match(LOCATION) ?? meta.match(LOCATION_CJK)
  if (loc) {
    const a = +(loc[1] ?? loc[3])
    const b = +(loc[2] ?? loc[4] ?? a)
    if (a) out.range = [a, Math.max(a, b)]
  }
  const page = meta.match(PAGE)
  if (page) out.page = +(page[1] ?? page[2])
  return out
}

const locationOf = (p: { range?: [number, number]; page?: number }) => (p.range ? `loc ${p.range[0]}` : p.page ? `p. ${p.page}` : undefined)

/** Two highlights that are one passage the reader went back and lengthened (or shortened). */
function sameSpot(a: ImportHighlight, b: ImportHighlight): boolean {
  const na = normText(a.text)
  const nb = normText(b.text)
  if (na === nb) return true
  const near = a.range && b.range ? a.range[0] <= b.range[1] && b.range[0] <= a.range[1] : a.page !== undefined && a.page === b.page
  if (!near) return false
  if (na.includes(nb) || nb.includes(na)) return true
  // An edit that moved one end: the passage shares a long run at its start or its end.
  const prefix = (x: string, y: string) => {
    let i = 0
    while (i < x.length && x[i] === y[i]) i++
    return i
  }
  const rev = (s: string) => [...s].reverse().join('')
  return prefix(na, nb) >= 25 || prefix(rev(na), rev(nb)) >= 25
}

/** Add a highlight to a book, keeping the longest of overlapping edits. */
function keep(book: ImportBook, h: ImportHighlight) {
  const i = book.highlights.findIndex((x) => sameSpot(x, h))
  if (i < 0) return book.highlights.push(h)
  if (normText(h.text).length > normText(book.highlights[i].text).length) book.highlights[i] = h
}

function bookFor(books: ImportBook[], title: string, author: string): ImportBook {
  let book = books.find((b) => b.title === title && b.author === author) ?? books.find((b) => sameWork(b, { title, author }))
  if (!book) books.push((book = { title, author, highlights: [] }))
  return book
}

/**
 * Read a Kindle "My Clippings.txt". Entries are separated by "==========": a "Title (Author)" line,
 * a line saying what and where ("- Your Highlight on page 12 | Location 123-125 | Added on …"), a
 * blank line, then the text. Highlights are kept, grouped by book; notes and bookmarks are left out.
 * The meta line is read in any of Kindle's languages; an entry that still can't be read is counted.
 */
export function parseClippings(raw: string): Parsed {
  const text = raw.replace(/﻿/g, '').replace(/\r\n?/g, '\n')
  const books: ImportBook[] = []
  let skipped = 0
  for (const entry of text.split(/^={8,}\s*$/m)) {
    const lines = entry.split('\n')
    while (lines.length && !lines[0].trim()) lines.shift()
    if (!lines.length) continue
    const head = lines.shift()!.trim()
    const meta = (lines.shift() ?? '').trim()
    const body = lines.join('\n').trim()
    if (!meta.startsWith('-') || !head) {
      skipped++
      continue
    }
    const kind = kindOf(meta)
    if (kind === 'bookmark' || kind === 'note') continue
    if (!body) {
      // A highlight with nothing in it (Kindle's clipping limit, or DRM) can't be kept.
      if (kind !== 'highlight' && kind !== 'clip') skipped++
      continue
    }
    const place = placeOf(meta)
    if (!kind || (!place.range && place.page === undefined && kind !== 'clip')) {
      skipped++
      continue
    }
    const { title, author } = titleLine(head)
    keep(bookFor(books, title, author), { text: body, location: locationOf(place), ...place })
  }
  for (const b of books) b.highlights.sort((x, y) => (x.range?.[0] ?? x.page ?? 0) - (y.range?.[0] ?? y.page ?? 0))
  return { books, skipped }
}

/** Does this text look like a Kindle clippings file? */
export const isClippings = (raw: string) => /^={8,}\s*$/m.test(raw) && /^-\s.*\|/m.test(raw)

/**
 * Read a Readwise CSV export: one row per highlight, with "Highlight", "Book Title", "Book Author",
 * "Location Type" and "Location" columns. Rows without a highlight or a title are counted as skipped.
 */
export function parseReadwiseCsv(raw: string): Parsed {
  const res = Papa.parse<Record<string, string>>(raw.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase() })
  const books: ImportBook[] = []
  let skipped = 0
  for (const row of res.data) {
    const text = (row['highlight'] ?? '').trim()
    const title = (row['book title'] ?? row['title'] ?? '').trim()
    if (!text || !title) {
      skipped++
      continue
    }
    const author = (row['book author'] ?? row['author'] ?? '').trim()
    const type = (row['location type'] ?? '').trim().toLowerCase()
    const n = parseInt(row['location'] ?? '', 10)
    const h: ImportHighlight = { text }
    if (n > 0 && type === 'location') {
      h.location = `loc ${n}`
      h.range = [n, n]
    } else if (n > 0 && type === 'page') {
      h.location = `p. ${n}`
      h.page = n
    } else if (n >= 0 && type === 'time') {
      h.location = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
    }
    keep(bookFor(books, title, author), h)
  }
  // A CSV that isn't Readwise's has no rows with both columns.
  return { books, skipped: skipped + res.errors.filter((e) => e.type !== 'FieldMismatch').length }
}

/** Is this text a Readwise CSV? */
export const isReadwiseCsv = (raw: string) => /^﻿?[^\n]*\bhighlight\b[^\n]*\bbook title\b/i.test(raw.slice(0, 500))

/** Read either format, whichever it is. */
export function parseHighlightsFile(raw: string, name = ''): Parsed & { format: 'kindle' | 'readwise' | null } {
  if (isReadwiseCsv(raw) || /\.csv$/i.test(name)) return { ...parseReadwiseCsv(raw), format: 'readwise' }
  if (isClippings(raw)) return { ...parseClippings(raw), format: 'kindle' }
  return { books: [], skipped: 0, format: null }
}
