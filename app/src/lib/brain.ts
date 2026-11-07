// The Brain: notes on what the writer reads, hears and watches, one Markdown note per source, with the
// highlights they kept. Shared by the app and the server, so no DOM and no file system here.
//
// A source note is plain Markdown that Obsidian reads as well:
//
//   ---
//   type: book
//   title: Thinking, Fast and Slow
//   author: Kahneman, Daniel
//   status: done
//   ---
//
//   ## Summary
//
//   ## Notes
//
//   ## Highlights
//
//   > Nothing in life is as important as you think it is, while you are thinking about it.
//   — loc 1234

export const SOURCE_TYPES = ['book', 'podcast', 'video', 'article'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]
export const STATUSES = ['want', 'reading', 'done'] as const
export type SourceStatus = (typeof STATUSES)[number]

/** Each type's folder inside the brain folder. */
export const TYPE_FOLDERS: Record<SourceType, string> = { book: 'books', podcast: 'podcasts', video: 'videos', article: 'articles' }
export const TYPE_LABELS: Record<SourceType, string> = { book: 'Book', podcast: 'Podcast', video: 'Video', article: 'Article' }
export const STATUS_LABELS: Record<SourceStatus, string> = { want: 'Want to read', reading: 'Reading', done: 'Done' }
/** What the person behind each kind of source is called. */
export const CREATOR_LABELS: Record<SourceType, string> = { book: 'Author', podcast: 'Host', video: 'Channel', article: 'Author' }

export const DEFAULT_BRAIN_FOLDER = 'brain'

/** The front-matter fields of a source note (the shared source contract, flat). */
export interface SourceFields {
  type: SourceType
  title: string
  author?: string
  url?: string
  isbn?: string
  year?: string
  status?: SourceStatus | ''
  rating?: string
  started?: string
  finished?: string
  tags?: string
}

/** The order fields are written in. */
export const FIELD_ORDER = ['type', 'title', 'author', 'url', 'isbn', 'year', 'status', 'rating', 'started', 'finished', 'tags'] as const

export const asType = (v: unknown): SourceType | null => (SOURCE_TYPES.includes(v as SourceType) ? (v as SourceType) : null)
export const asStatus = (v: unknown): SourceStatus | '' => (STATUSES.includes(v as SourceStatus) ? (v as SourceStatus) : '')

const normPath = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+|^\/+|\/+$/g, '')
    .toLowerCase()

/** Is this vault path a note in the brain folder? */
export function isBrainPath(path: string, folder: string = DEFAULT_BRAIN_FOLDER): boolean {
  const f = normPath(folder || DEFAULT_BRAIN_FOLDER)
  const p = normPath(path)
  return !!f && p.startsWith(f + '/')
}

/** A brain folder as typed in settings, tidied; '' if it can't be one. */
export function cleanBrainFolder(value: unknown): string {
  if (typeof value !== 'string') return ''
  const f = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
  if (!f || f.length > 120 || f.split('/').some((part) => !part.trim() || part.startsWith('.') || part === '..')) return ''
  return f
}

/** A source's type from its front matter, or else the folder it sits in. */
export function typeOf(meta: Record<string, string>, path: string): SourceType {
  const t = asType(meta.type?.toLowerCase())
  if (t) return t
  const folder = path.split('/').slice(-2, -1)[0]?.toLowerCase()
  return (Object.entries(TYPE_FOLDERS).find(([, f]) => f === folder)?.[0] as SourceType) ?? 'book'
}

// ---- Matching ---------------------------------------------------------------------------------

/** Letters and digits only, lower case, accents dropped: for comparing titles, authors and highlights. */
export function normText(s: string): string {
  return unescapeMd(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A title without its subtitle or edition: "Thinking, Fast and Slow: A Summary (Penguin Edition)" → "thinking fast and slow". */
export function titleKey(title: string): string {
  const main = title.replace(/\s*[([][^)\]]*(edition|ed\.|unabridged|abridged|kindle|ebook)[^)\]]*[)\]]/gi, '').split(/:\s| — | – | - /)[0]
  return normText(main)
}

/** An author's names as a set of words, so "Kahneman, Daniel" and "Daniel Kahneman" agree. */
export function authorWords(author: string | undefined): Set<string> {
  return new Set(
    normText(author ?? '')
      .split(' ')
      .filter((w) => w.length > 1),
  )
}

/** Same title, and authors that share a name (or one side doesn't say). */
export function sameWork(a: { title: string; author?: string }, b: { title: string; author?: string }): boolean {
  if (!titleKey(a.title) || titleKey(a.title) !== titleKey(b.title)) return false
  const wa = authorWords(a.author)
  const wb = authorWords(b.author)
  if (!wa.size || !wb.size) return true
  return [...wa].some((w) => wb.has(w))
}

/** Digits (and a final X) of an ISBN, or '' if it isn't one. */
export function cleanIsbn(s: string | undefined): string {
  const d = (s ?? '').replace(/[\s-]/g, '').toUpperCase()
  return /^(\d{9}[\dX]|\d{13})$/.test(d) ? d : ''
}

/** The YouTube video id in any of its URL shapes, or null. */
export function youtubeId(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '').toLowerCase()
  let id: string | null = null
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v')
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)
      id = m?.[1] ?? null
    }
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null
}

/** Seconds from a YouTube-style start time: "754", "754s", "12m34s", "1h2m3s". */
export function parseStart(t: string | null): number | null {
  if (!t) return null
  if (/^\d+s?$/.test(t)) return parseInt(t, 10)
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!m || !(m[1] || m[2] || m[3])) return null
  return (+(m[1] ?? 0) * 60 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|si|feature|igshid)$/i

/**
 * One spelling of a URL, for telling whether a source is already in the brain: YouTube's youtu.be,
 * shorts and &t= variants become the plain watch URL; tracking parameters, the fragment, "www." and
 * a trailing slash go.
 */
export function normalizeUrl(raw: string): string {
  const yt = youtubeId(raw)
  if (yt) return `https://www.youtube.com/watch?v=${yt}`
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return raw.trim()
  }
  if (!/^https?:$/.test(u.protocol)) return raw.trim()
  u.hash = ''
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k)
  u.protocol = 'https:'
  return u.toString().replace(/\/(\?|$)/, '$1')
}

/** Is this something the server may fetch? Only http(s) URLs. */
export function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/** What a pasted string asks to look up: a web page, an ISBN, a title to search, or something refused. */
export function lookupKind(input: string): 'url' | 'isbn' | 'title' | 'refused' | 'empty' {
  const s = input.trim()
  if (!s) return 'empty'
  if (cleanIsbn(s)) return 'isbn'
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]+:\s/i.test(s)) return isWebUrl(s) ? 'url' : 'refused'
  if (/^(www\.)?[\w-]+(\.[\w-]+)+\/\S*$/i.test(s)) return 'url' // "youtu.be/abc" without a scheme
  return 'title'
}

/** A source already in the brain that is the same as this one: same ISBN, same URL, or same title and author. */
export function findSame<T extends { isbn?: string; url?: string; title: string; author?: string }>(sources: T[], f: { isbn?: string; url?: string; title?: string; author?: string }): T | undefined {
  const isbn = cleanIsbn(f.isbn)
  if (isbn) {
    const hit = sources.find((s) => cleanIsbn(s.isbn) === isbn)
    if (hit) return hit
  }
  if (f.url?.trim()) {
    const url = normalizeUrl(f.url)
    const hit = sources.find((s) => s.url && normalizeUrl(s.url) === url)
    if (hit) return hit
  }
  if (f.title?.trim()) return sources.find((s) => sameWork(s, { title: f.title!, author: f.author }))
}

// ---- Locations --------------------------------------------------------------------------------

/** "12:34" or "1:02:03" → seconds, or null. */
export function clockSeconds(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return (+(m[1] ?? 0) * 60 + +m[2]) * 60 + +m[3]
}

export const clock = (sec: number) => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** A URL that starts playing at this many seconds. */
export function urlAt(url: string, sec: number): string {
  const yt = youtubeId(url)
  if (yt) return `https://www.youtube.com/watch?v=${yt}&t=${sec}s`
  try {
    const u = new URL(url)
    u.searchParams.set('t', String(sec))
    return u.toString()
  } catch {
    return url
  }
}

/**
 * How a highlight's place is written after it: "loc 1234", "p. 12", or a timestamp linked to the
 * moment ("[12:34](https://…&t=754s)"). Accepts what a writer types: "1234", "loc 1234", "p 12",
 * "page 12", "12:34".
 */
export function formatLocation(input: string, type: SourceType, url?: string): string {
  const s = input.trim()
  if (!s) return ''
  const sec = clockSeconds(s)
  if (sec !== null) return url && isWebUrl(url) ? `[${clock(sec)}](${urlAt(url, sec)})` : clock(sec)
  const page = s.match(/^(?:p\.?|pp?\.|page)\s*(\d+)$/i)
  if (page) return `p. ${page[1]}`
  const loc = s.match(/^(?:loc\.?|location)?\s*(\d+)$/i)
  // A bare number is a page in a printed book's terms only if the writer says so; Kindle counts locations.
  if (loc) return type === 'book' || /^loc/i.test(s) ? `loc ${loc[1]}` : s
  return s.replace(/\n+/g, ' ')
}

/** A location as plain text, for a chip: "[12:34](…)" → "12:34". */
export const locationText = (loc: string) => loc.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1')

// ---- Highlights in a note ---------------------------------------------------------------------

export interface Highlight {
  text: string
  location?: string
}

const MD_SPECIAL = /([\\`*_[\]<>~|])/g

/** Write text so Markdown shows it as it is: inside a quote, '>' or '#' or '*' mean nothing. */
export function escapeMd(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(MD_SPECIAL, '\\$1')
        .replace(/==/g, '\\=\\=')
        .replace(/^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s)|(\d+)([.)])(?=\s))/, (_m, sp: string, mark: string, num?: string, dot?: string) => (num ? `${sp}${num}\\${dot}` : `${sp}\\${mark}`))
        .replace(/^(\s*)([-=]{3,}\s*)$/, '$1\\$2'),
    )
    .join('\n')
}

/** The text a reader sees: backslash escapes removed. */
export function unescapeMd(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/** A highlight as Markdown: the quote, then where it is. */
export function renderHighlight(h: Highlight): string {
  const quote = escapeMd(
    h.text
      .trim()
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
  )
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
  return h.location ? `${quote}\n— ${h.location}` : quote
}

const LOCATION_TAIL = /(?:^|\s)— ?((?:loc|p\.|pp\.)\s*[\d–-]+|\[\d{1,2}(?::\d{2}){1,2}\]\([^)\s]*\)|\d{1,2}(?::\d{2}){1,2})\s*$/

/** The Highlights section of a note: where it starts and ends in the body, or null. */
export function highlightsSection(body: string): { start: number; end: number } | null {
  const m = body.match(/^##\s+Highlights\s*$/im)
  if (!m || m.index === undefined) return null
  const start = m.index + m[0].length
  const next = body.slice(start).search(/^#{1,2}\s/m)
  return { start, end: next < 0 ? body.length : start + next }
}

/**
 * The highlights in a note's Highlights section: each blockquote, with the "— loc 1234" after it (on
 * the next line, inside the quote's last line, or run on after a space, as an editor may leave it).
 * Lines the writer added between quotes are left alone.
 */
export function parseHighlights(body: string): Highlight[] {
  const sec = highlightsSection(body)
  if (!sec) return []
  const lines = body.slice(sec.start, sec.end).split('\n')
  const out: Highlight[] = []
  let quote: string[] | null = null
  const finish = (location?: string) => {
    if (!quote) return
    let text = quote.join('\n').trim()
    if (!location) {
      const tail = text.match(LOCATION_TAIL)
      if (tail) {
        location = tail[1]
        text = text.slice(0, tail.index).trim()
      }
    }
    text = unescapeMd(text)
    if (text) out.push(location ? { text, location } : { text })
    quote = null
  }
  for (const line of lines) {
    const q = line.match(/^\s*>\s?(.*)$/)
    if (q) {
      ;(quote ??= []).push(q[1])
      continue
    }
    const loc = line.match(/^\s*— ?(.+?)\s*$/)
    if (quote && loc) finish(loc[1])
    else finish()
  }
  finish()
  return out
}

/** Highlight text in a standard form, for telling one already kept from a new one. */
const normHighlight = (t: string) => normText(t)

const words = (t: string) => new Set(normHighlight(t).split(' ').filter(Boolean))
function overlap(a: Set<string>, b: Set<string>) {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n / Math.max(1, Math.min(a.size, b.size))
}

/**
 * Is this incoming highlight one the note already has? The same words, one inside the other (the
 * writer trimmed it, or Kindle extended it), or mostly the same words at the same place (the writer
 * fixed a typo).
 */
export function alreadyKept(kept: Highlight[], h: Highlight): boolean {
  const n = normHighlight(h.text)
  if (!n) return true
  const w = words(h.text)
  const loc = locationText(h.location ?? '').toLowerCase()
  return kept.some((k) => {
    const m = normHighlight(k.text)
    if (!m) return false
    if (m === n || (Math.min(m.length, n.length) >= 20 && (m.includes(n) || n.includes(m)))) return true
    const o = overlap(w, words(k.text))
    if (o >= 0.85 && Math.min(m.length, n.length) >= 20) return true
    return !!loc && locationText(k.location ?? '').toLowerCase() === loc && o >= 0.5
  })
}

/**
 * Add highlights to a note's body, append-only: those it already has are skipped, and nothing the
 * writer wrote is changed. A note without a Highlights section gets one at the end.
 */
export function mergeHighlights(body: string, incoming: Highlight[]): { body: string; added: number } {
  const kept = parseHighlights(body)
  const fresh: Highlight[] = []
  for (const h of incoming) {
    if (!h.text.trim() || alreadyKept([...kept, ...fresh], h)) continue
    fresh.push({ text: h.text.trim(), location: h.location?.trim() || undefined })
  }
  if (!fresh.length) return { body, added: 0 }
  const blocks = fresh.map(renderHighlight).join('\n\n')
  let sec = highlightsSection(body)
  if (!sec) {
    body = `${body.replace(/\s*$/, '')}${body.trim() ? '\n\n' : ''}## Highlights\n`
    sec = highlightsSection(body)!
  }
  const before = body.slice(0, sec.end).replace(/\s*$/, '')
  const after = body.slice(sec.end)
  return { body: `${before}\n\n${blocks}\n${after ? '\n' + after.replace(/^\s*/, '') : ''}`, added: fresh.length }
}

/** A new source note's body. */
export function newSourceBody(highlights: Highlight[] = []): string {
  const base = '## Summary\n\n## Notes\n\n## Highlights\n'
  return highlights.length ? mergeHighlights(base, highlights).body : base
}

/** Front-matter lines for a source, in the contract's order. Empty fields are left out (type, title and status stay). */
export function sourceMeta(f: SourceFields): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of FIELD_ORDER) {
    const v = String(f[k] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (v || k === 'type' || k === 'title') out[k] = v
  }
  return out
}
