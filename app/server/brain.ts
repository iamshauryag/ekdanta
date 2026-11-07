// The Brain on disk: one note per source in the brain folder (books/, podcasts/, videos/, articles/),
// adding sources and highlights, importing highlights, and looking a source up online when asked.
import { promises as fs } from 'node:fs'
import { joinDoc, joinFrontMatter, splitFrontMatter } from '../src/lib/frontmatter.ts'
import {
  TYPE_FOLDERS,
  asStatus,
  asType,
  cleanIsbn,
  findSame,
  isBrainPath,
  isWebUrl,
  lookupKind,
  mergeHighlights,
  newSourceBody,
  normalizeUrl,
  parseHighlights,
  sourceMeta,
  typeOf,
  youtubeId,
  type Highlight,
  type SourceFields,
  type SourceType,
} from '../src/lib/brain.ts'
import { parseHighlightsFile, type ImportBook } from './kindle.ts'
import { HttpError } from './net.ts'
import { Refused, getPublic } from './outbound.ts'
import { loadSettings } from './settings.ts'
import { listFiles, readDoc, resolveInVault, slugify, writeDoc } from './vault.ts'

export interface SourceSummary extends SourceFields {
  path: string
  highlights: number
  mtime: number
}

export const brainFolder = async () => (await loadSettings()).brainFolder

/** Every source note in the brain folder, with its fields and how many highlights it keeps. */
export async function listSources(): Promise<SourceSummary[]> {
  const folder = await brainFolder()
  const out: SourceSummary[] = []
  for (const f of await listFiles()) {
    if (!isBrainPath(f.path, folder)) continue
    const { meta, body } = splitFrontMatter(await readDoc(f.path).catch(() => ''))
    out.push({
      path: f.path,
      mtime: f.mtime,
      type: typeOf(meta, f.path),
      title: meta.title || f.title,
      author: meta.author || meta.creator || meta.channel || meta.host || '',
      url: meta.url ?? '',
      isbn: meta.isbn ?? '',
      year: meta.year ?? '',
      status: asStatus(meta.status?.toLowerCase()),
      rating: /^[1-5]$/.test(meta.rating ?? '') ? meta.rating : '',
      started: meta.started ?? '',
      finished: meta.finished ?? '',
      tags: meta.tags ?? '',
      highlights: parseHighlights(body).length,
    })
  }
  return out
}

/** Fields from the app, checked: a known type, a title, a 1–5 rating, a known status, an http(s) URL. */
function cleanFields(f: Partial<SourceFields>): SourceFields {
  const type = asType(f.type) ?? 'book'
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 500) : '')
  const url = str(f.url)
  const fields: SourceFields = {
    type,
    title: str(f.title),
    author: str(f.author),
    url: url && isWebUrl(url) ? (youtubeId(url) ? normalizeUrl(url) : url) : '',
    // An ISBN belongs to a book; one left over from switching the type would be wrong.
    isbn: type === 'book' ? cleanIsbn(str(f.isbn)) : '',
    year: /^\d{1,4}$/.test(str(f.year)) ? str(f.year) : '',
    status: asStatus(f.status),
    rating: /^[1-5]$/.test(str(f.rating)) ? str(f.rating) : '',
    started: str(f.started),
    finished: str(f.finished),
    tags: str(f.tags),
  }
  if (url && !fields.url) throw new HttpError(400, 'Only web addresses (http or https) can be saved as a source’s link')
  // A stub made from a link alone is named after the link until the writer names it.
  if (!fields.title && fields.url) fields.title = new URL(fields.url).hostname.replace(/^www\./, '') + new URL(fields.url).pathname.replace(/\/$/, '')
  if (!fields.title) throw new HttpError(400, 'A source needs a title or a link')
  return fields
}

/** `folder/name.md`, or `folder/name-2.md` and so on if that's taken. */
async function freePath(folder: string, name: string) {
  for (let n = 1; ; n++) {
    const rel = `${folder}/${name}${n > 1 ? '-' + n : ''}.md`
    const taken = await fs.access(resolveInVault(rel)).then(
      () => true,
      () => false,
    )
    if (!taken) return rel
  }
}

async function createNote(fields: SourceFields, highlights: Highlight[] = []) {
  const folder = `${await brainFolder()}/${TYPE_FOLDERS[fields.type]}`
  const rel = await freePath(folder, slugify(fields.title))
  await writeDoc(rel, joinFrontMatter('', sourceMeta(fields), newSourceBody(highlights)), { reason: 'create' })
  return rel
}

/** Add a source, or find the one already there (same ISBN, URL, or title and author). */
export async function addSource(input: Partial<SourceFields>): Promise<{ path: string; existed: boolean }> {
  const fields = cleanFields(input)
  const same = findSame(await listSources(), fields)
  if (same) return { path: same.path, existed: true }
  return { path: await createNote(fields), existed: false }
}

async function brainNote(rel: string) {
  if (!isBrainPath(rel, await brainFolder())) throw new HttpError(400, 'Not a note in the Brain')
  return readDoc(rel)
}

/** Append one highlight to a source note's Highlights. */
export async function addHighlight(rel: string, text: string, location = ''): Promise<{ added: number }> {
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'The highlight is empty')
  // Only the body changes: the front matter goes back exactly as it was, whatever it holds.
  const fm = splitFrontMatter(await brainNote(rel))
  const merged = mergeHighlights(fm.body, [{ text: text.slice(0, 20_000), location: String(location ?? '').slice(0, 300) }])
  if (merged.added) await writeDoc(rel, joinDoc({ ...fm, body: merged.body }), { reason: 'save' })
  return { added: merged.added }
}

// ---- Importing highlights ---------------------------------------------------------------------

export interface ImportPlan {
  format: 'kindle' | 'readwise' | null
  books: { title: string; author: string; path: string | null; highlights: number; fresh: number }[]
  /** Highlights not already in the brain. */
  fresh: number
  skipped: number
}

async function plan(raw: string, name: string): Promise<{ plan: ImportPlan; books: ImportBook[] }> {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'The file is empty')
  const parsed = parseHighlightsFile(raw, name)
  const sources = await listSources()
  const books: ImportPlan['books'] = []
  for (const b of parsed.books) {
    const same = findSame(sources, { title: b.title, author: b.author })
    const body = same ? splitFrontMatter(await readDoc(same.path)).body : newSourceBody()
    books.push({ title: b.title, author: b.author, path: same?.path ?? null, highlights: b.highlights.length, fresh: mergeHighlights(body, b.highlights).added })
  }
  return { plan: { format: parsed.format, books, fresh: books.reduce((n, b) => n + b.fresh, 0), skipped: parsed.skipped }, books: parsed.books }
}

/** What importing this file would do, without doing it. */
export const previewImport = async (raw: string, name = '') => (await plan(raw, name)).plan

/** Import highlights: new books get a note, known ones gain only the highlights they lack. */
export async function runImport(raw: string, name = ''): Promise<ImportPlan & { created: number; changed: string[] }> {
  const { plan: p, books } = await plan(raw, name)
  let created = 0
  let fresh = 0
  // Every note written, so the app can read one that's open again rather than save over it.
  const changed: string[] = []
  const sources: { path: string; title: string; author?: string }[] = await listSources()
  for (const b of books) {
    // New notes join the list, so two spellings of one book in a file land in one note.
    const same = findSame(sources, { title: b.title, author: b.author })
    const highlights = b.highlights.map(({ text, location }) => ({ text, location }))
    if (same) {
      const fm = splitFrontMatter(await readDoc(same.path))
      const merged = mergeHighlights(fm.body, highlights)
      if (merged.added) {
        await writeDoc(same.path, joinDoc({ ...fm, body: merged.body }), { reason: 'import' })
        changed.push(same.path)
      }
      fresh += merged.added
    } else {
      const fields = cleanFields({ type: 'book', title: b.title, author: contractAuthor(b.author) })
      const made = await createNote(fields, highlights)
      sources.push({ path: made, title: fields.title, author: fields.author })
      changed.push(made)
      created++
      fresh += mergeHighlights(newSourceBody(), highlights).added
    }
  }
  return { ...p, fresh, created, changed }
}

// ---- Looking a source up online ---------------------------------------------------------------
// Only when the writer asks (the button says "Looks up details online"), and only http(s).

export interface Candidate extends Partial<SourceFields> {
  type: SourceType
  title: string
}

const TIMEOUT = 5000
const MAX_BYTES = 1_500_000

/** GET a public http(s) URL: 5 s in all, redirects checked one by one, a size cap. */
async function getText(raw: string, accept = 'text/html,application/xhtml+xml'): Promise<{ text: string; url: string }> {
  const signal = AbortSignal.timeout(TIMEOUT)
  let url = new URL(raw)
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only web addresses (http or https) can be looked up')
      // Every hop's address is checked as it connects, so a redirect or a second DNS answer can't lead inside.
      const res = await getPublic(url, { signal, maxBytes: MAX_BYTES, headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; Ekdanta; +https://github.com)', 'accept-language': 'en' } })
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = new URL(res.location, url)
        continue
      }
      if (res.status < 200 || res.status >= 300) throw new HttpError(502, `${url.hostname} answered ${res.status}`)
      return { text: new TextDecoder().decode(res.body), url: url.toString() }
    }
    throw new HttpError(502, 'Too many redirects')
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (e instanceof Refused) throw new HttpError(400, 'That address is on this computer or your local network, so it isn’t looked up')
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw new HttpError(502, `Couldn’t find ${url.hostname}. Are you online?`)
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    throw new HttpError(502, timedOut ? `${url.hostname} took longer than 5 s` : `Couldn’t reach ${url.hostname}. Are you online?`)
  }
}

const getJson = async <T>(url: string) => {
  const { text } = await getText(url, 'application/json')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(502, 'The lookup sent back something unreadable')
  }
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** The <meta> tags of a page (og:, article:, name=), and its <title>. */
export function pageMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  const head = html.slice(0, 400_000)
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    const key = attr('property') ?? attr('name') ?? attr('itemprop')
    const content = attr('content')
    if (!key || !content) continue
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase()
    if (k && !(k in out)) out[k] = decode(content[2] ?? content[3] ?? content[4] ?? '')
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title) out['<title>'] = decode(title[1])
  return out
}

const PODCAST_HOSTS = /(^|\.)(podcasts\.apple\.com|overcast\.fm|pca\.st|pocketcasts\.com|castbox\.fm|podbean\.com|transistor\.fm|buzzsprout\.com|simplecast\.com|anchor\.fm|podcasters\.spotify\.com)$/i

/** A page's details from its tags. */
function fromPage(url: string, m: Record<string, string>): Candidate {
  const host = new URL(url).hostname.replace(/^www\./, '')
  const og = (m['og:type'] ?? '').toLowerCase()
  const isSpotifyShow = host === 'open.spotify.com' && /^\/(episode|show)\//.test(new URL(url).pathname)
  const type: SourceType = og.startsWith('video') ? 'video' : PODCAST_HOSTS.test(host) || isSpotifyShow || /podcast/.test(og) ? 'podcast' : og === 'book' || m['books:isbn'] ? 'book' : 'article'
  const byline = [m['author'], m['article:author'], m['twitter:creator'], m['citation_author']].find((a) => a && !/^https?:/i.test(a))
  const published = m['article:published_time'] ?? m['citation_publication_date'] ?? m['date'] ?? ''
  return {
    type,
    title: m['og:title'] || m['twitter:title'] || m['citation_title'] || m['<title>'] || '',
    // A podcast or video page's site name is the platform, not who made it.
    author: byline || (type === 'article' || type === 'book' ? m['og:site_name'] || host : ''),
    url,
    isbn: cleanIsbn(m['books:isbn']),
    year: published.match(/^(\d{4})/)?.[1] ?? '',
  }
}

interface OpenLibraryDoc {
  title?: string
  subtitle?: string
  author_name?: string[]
  first_publish_year?: number
  isbn?: string[]
}

/** "Daniel Kahneman" → "Kahneman, Daniel" (the source contract's form). */
const lastFirst = (name: string) => {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 && !name.includes(',') ? `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}` : name.trim()
}

/** One plain "First Last" name in the contract's "Last, First" form; anything less certain (several names, an organisation) as it is. */
function contractAuthor(name: string) {
  const n = name.trim()
  if (/[,;&]|\band\b|\bund\b|\bet\b|\by\b/i.test(n)) return n
  const words = n.split(/\s+/)
  return words.length >= 2 && words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w)) ? lastFirst(n) : n
}

function fromOpenLibrary(d: OpenLibraryDoc, isbn = ''): Candidate {
  return {
    type: 'book',
    title: d.title ?? '',
    author: (d.author_name ?? []).slice(0, 3).map(lastFirst).join('; '),
    isbn: isbn || cleanIsbn(d.isbn?.find((i) => i.length === 13) ?? d.isbn?.[0]),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
  }
}

const OPEN_LIBRARY = 'https://openlibrary.org/search.json?fields=title,subtitle,author_name,first_publish_year,isbn&'

/** Look up details for a pasted URL, an ISBN, or a book title. Refuses anything that isn't http(s). */
export async function lookup(input: string): Promise<{ candidates: Candidate[] }> {
  const s = (typeof input === 'string' ? input : '').trim().slice(0, 2000)
  const kind = lookupKind(s)
  if (kind === 'empty') throw new HttpError(400, 'Paste a link, an ISBN or a title')
  if (kind === 'refused') throw new HttpError(400, 'Only web addresses (http or https) can be looked up')
  if (kind === 'isbn') {
    const isbn = cleanIsbn(s)
    const res = await getJson<{ docs?: OpenLibraryDoc[] }>(`${OPEN_LIBRARY}limit=1&isbn=${isbn}`)
    return { candidates: (res.docs ?? []).slice(0, 1).map((d) => fromOpenLibrary(d, isbn)) }
  }
  if (kind === 'title') {
    const res = await getJson<{ docs?: OpenLibraryDoc[] }>(`${OPEN_LIBRARY}limit=5&q=${encodeURIComponent(s)}`)
    return { candidates: (res.docs ?? []).filter((d) => d.title).map((d) => fromOpenLibrary(d)) }
  }
  const url = /^https?:/i.test(s) ? s : `https://${s}`
  const yt = youtubeId(url)
  if (yt) {
    const watch = `https://www.youtube.com/watch?v=${yt}`
    const o = await getJson<{ title?: string; author_name?: string }>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`)
    return { candidates: [{ type: 'video', title: o.title ?? '', author: o.author_name ?? '', url: watch }] }
  }
  const isbnPath = new URL(url).hostname.endsWith('openlibrary.org') ? cleanIsbn(new URL(url).pathname.match(/\/isbn\/([\dXx-]+)/)?.[1]) : ''
  if (isbnPath) return lookup(isbnPath)
  const page = await getText(url)
  const c = fromPage(page.url, pageMeta(page.text))
  return { candidates: c.title ? [c] : [] }
}
