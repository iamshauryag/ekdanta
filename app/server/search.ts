// Search across the vault (⌘⇧F). Each document is read once and kept as plain lines; a search
// re-reads only files that changed since (the same cache the vault listing uses). Ekdanta's own
// folder and the trash are dot-folders, which the cache never walks; special and excluded folders
// are left out as Recall leaves them out. The query language lives in src/lib/searchQuery.ts.
import path from 'node:path'
import { findKind, kindId } from '../src/lib/kinds.ts'
import { compile, occurrence, parseQuery, plainLines, snippet, tagsOf, type Range, type SearchDoc } from '../src/lib/searchQuery.ts'
import { fold } from '../src/lib/fuzzy.ts'
import { isSpecialPath } from '../src/lib/special.ts'
import { createFileCache } from './cache.ts'
import { VAULT, splitFrontMatter } from './vault.ts'
import { loadSettings } from './settings.ts'

const cache = createFileCache<SearchDoc & { mtime: number }>(VAULT, (rel, raw, stat) => {
  const { meta, body } = splitFrontMatter(raw)
  return {
    path: rel,
    title: meta.title || body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(rel, '.md'),
    meta,
    lines: plainLines(body),
    tags: tagsOf(raw, body),
    mtime: stat.mtime,
  }
})

export interface SearchHit {
  /** The line in the document's text (front matter left out). */
  line: number
  text: string
  ranges: Range[]
  /** What to select when the document opens: the matched text and which occurrence of it this is. */
  select: { text: string; nth: number }
}

export interface SearchFile {
  path: string
  title: string
  folder: string
  platform?: string
  titleRanges: Range[]
  hits: SearchHit[]
}

export interface SearchResult {
  files: SearchFile[]
  /** Every result row found (a line with a match, or one row for a document matched only by its title or filters), though only `limit` are returned. */
  total: number
  /** Every match found: each occurrence in a line or a title, not each line. */
  matches: number
  /** Every document that matched, though not all of them may be returned. */
  documents: number
  more: boolean
  error?: string
}

export const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5000

export async function searchVault(q: string, opts: { matchCase?: boolean; limit?: number } = {}): Promise<SearchResult> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT))
  const query = parseQuery(q)
  if (query.error) return { ...NONE, error: query.error }
  if (q.trim().length < 2) return NONE
  const settings = await loadSettings()
  // kind: takes a kind's id, its name or its plural ("kind:email", "kind:Emails", "kind:linkedin-post").
  const kindIds = (value: string) => {
    const v = fold(value)
    const k = findKind(settings.kinds, value) ?? settings.kinds.find((k) => fold(k.name) === v || fold(k.name) + 's' === v || k.id === kindId(value))
    return k ? [k.id] : [value]
  }
  const matcher = compile(query, { matchCase: opts.matchCase, kindIds })
  const docs = (await cache.list()).filter((d) => !isSpecialPath(d.path, settings.excludedFolders))

  const files: (SearchFile & { mtime: number })[] = []
  let total = 0
  let matches = 0
  for (const doc of docs) {
    if (!matcher.matches(doc)) continue
    const hits: SearchHit[] = []
    doc.lines.forEach((line, i) => {
      const ranges = matcher.ranges(line)
      if (!ranges.length) return
      matches += ranges.length
      const [a, b] = ranges[0]
      const matched = line.slice(a, b)
      hits.push({ line: i, ...snippet(line, ranges), select: { text: matched, nth: occurrence(doc.lines, i, a, matched) } })
    })
    const folder = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : ''
    const titleRanges = matcher.ranges(doc.title)
    matches += titleRanges.length
    files.push({ path: doc.path, title: doc.title, folder, platform: doc.meta.platform, titleRanges, hits, mtime: doc.mtime })
    total += Math.max(1, hits.length)
  }
  // A match in the title first, then the most matches, then the most recently changed.
  files.sort((a, b) => Number(b.titleRanges.length > 0) - Number(a.titleRanges.length > 0) || b.hits.length - a.hits.length || b.mtime - a.mtime)

  // At most `limit` rows: a file with no hit in its text (matched by title or filters) is one row.
  const out: SearchFile[] = []
  let left = limit
  for (const { mtime: _, ...f } of files) {
    if (left <= 0) break
    const hits = f.hits.slice(0, left)
    out.push({ ...f, hits })
    left -= Math.max(1, hits.length)
  }
  return { files: out, total, matches, documents: files.length, more: total > limit }
}

const NONE: SearchResult = { files: [], total: 0, matches: 0, documents: 0, more: false }

/** How many files the search cache has read so far (for tests: a repeat search re-reads nothing). */
export const searchReads = () => cache.reads
