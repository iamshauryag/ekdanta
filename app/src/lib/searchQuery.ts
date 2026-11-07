// Search across the vault: reading what the writer typed, and matching it against a document.
//
//   slow writing        both words, anywhere in the document (title or text)
//   "unfinished room"   the phrase
//   -priya              not in documents that mention priya (works on any term or operator)
//   /wr[io]te/          a regular expression
//   path:essays         the file's path contains this
//   kind:essay          the piece's kind (front-matter `platform`; a kind's name works too)
//   tag:craft           a tag, in front matter or inline (#craft); tag:craft also finds craft/notes
//   status:draft        front-matter `status` (a document without one is a draft)
//
// Case and accents don't matter unless matchCase is on. Shared by the app (which checks the query
// before asking) and the server (which runs it); DOM-free, tested in searchQuery.test.ts.
import { fold } from './fuzzy.ts'

export { fold }

export type FilterKey = 'path' | 'kind' | 'tag' | 'status'
const FILTERS: FilterKey[] = ['path', 'kind', 'tag', 'status']

export type Term = { type: 'text'; value: string; phrase: boolean; negate: boolean } | { type: 'regex'; source: string; negate: boolean }

export interface Filter {
  key: FilterKey
  value: string
  negate: boolean
}

export interface Query {
  terms: Term[]
  filters: Filter[]
  /** Why the query can't run (a broken regex), shown beside the box. */
  error?: string
}

/** Read a query. It never throws: a broken regex comes back as `error`. */
export function parseQuery(input: string): Query {
  const terms: Term[] = []
  const filters: Filter[] = []
  let error: string | undefined
  const s = input
  let i = 0
  /** A quoted string from s[i] === '"' to the closing quote (or the end). */
  const quoted = () => {
    const close = s.indexOf('"', i + 1)
    const value = close < 0 ? s.slice(i + 1) : s.slice(i + 1, close)
    i = close < 0 ? s.length : close + 1
    return value
  }
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++
      continue
    }
    let negate = false
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      negate = true
      i++
    }
    if (s[i] === '"') {
      const value = quoted()
      if (value.trim()) terms.push({ type: 'text', value: value.trim().replace(/\s+/g, ' '), phrase: true, negate })
      continue
    }
    if (s[i] === '/') {
      const start = i + 1
      let j = start
      let inClass = false
      for (; j < s.length; j++) {
        const c = s[j]
        if (c === '\\') j++
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
      }
      const closed = j < s.length
      const source = s.slice(start, Math.min(j, s.length))
      i = closed ? j + 1 : s.length
      if (!source) {
        // A lone "/" is just text.
        if (!closed) terms.push({ type: 'text', value: '/', phrase: false, negate })
        continue
      }
      try {
        new RegExp(source, 'u')
        if (!closed && !error) error = 'A regular expression ends with /'
      } catch (e) {
        if (!error) error = regexError(e as Error)
      }
      terms.push({ type: 'regex', source, negate })
      continue
    }
    // A word, or key:value (the value may be quoted).
    const op = s.slice(i).match(/^([a-z]+):/i)
    const key = op?.[1].toLowerCase() as FilterKey | undefined
    if (op && key && FILTERS.includes(key) && i + op[0].length < s.length && !/\s/.test(s[i + op[0].length])) {
      i += op[0].length
      let value: string
      if (s[i] === '"') value = quoted()
      else {
        const end = s.slice(i).search(/\s/)
        value = end < 0 ? s.slice(i) : s.slice(i, i + end)
        i = end < 0 ? s.length : i + end
      }
      value = value.trim()
      if (key === 'tag') value = value.replace(/^#+/, '')
      if (value) filters.push({ key, value, negate })
      continue
    }
    const end = s.slice(i).search(/\s/)
    const word = end < 0 ? s.slice(i) : s.slice(i, i + end)
    i = end < 0 ? s.length : i + end
    terms.push({ type: 'text', value: word, phrase: false, negate })
  }
  return { terms, filters, error }
}

/** "Invalid regular expression: /[/u: Unterminated character class" → "Unterminated character class". */
function regexError(e: Error) {
  return 'Regex: ' + (e.message.split(': ').pop() || e.message).replace(/^./, (c) => c.toLowerCase())
}

/** Is there anything to search for? (Only negative terms would match everything.) */
export const hasPositive = (q: Query) => q.terms.some((t) => !t.negate) || q.filters.some((f) => !f.negate)

/** Long enough to ask the server: at least two characters, and no error. */
export function ready(input: string): { query: Query; ok: boolean } {
  const query = parseQuery(input)
  return { query, ok: input.trim().length >= 2 && !query.error && hasPositive(query) }
}

// ---- A document, as search sees it ----------------------------------------------------------

export interface SearchDoc {
  path: string
  title: string
  meta: Record<string, string>
  /** The text as lines without Markdown syntax: what the page shows. */
  lines: string[]
  /** Tags from front matter and inline #tags, lower case, without the #. */
  tags: string[]
}

/** Markdown's syntax taken out of one line, so a match and its snippet read as the page does. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '') // heading
    .replace(/^(\s*>)+\s?/, '') // quote
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '') // list item, to-do
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[page|label]]
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[page]]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2') // strong, strike, highlight
    .replace(/(^|[^\w*])[*_](?=\S)([^*_]*?\S)[*_](?![\w*])/g, '$1$2') // emphasis
    .replace(/`([^`]*)`/g, '$1') // code
}

/** A document's lines as search reads them: fences dropped, everything else made plain. */
export function plainLines(body: string): string[] {
  return body.split('\n').map((l) => (/^\s*(```|~~~)/.test(l) ? '' : plainLine(l)))
}

/** A list in front matter: `key: [a, b]`, `key: a, b`, or a YAML block of `- a` lines. */
export function frontMatterList(content: string, key: string): string[] {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return []
  const lines = fm[1].split('\n')
  const i = lines.findIndex((l) => new RegExp(`^${key}:`, 'i').test(l))
  if (i < 0) return []
  const inline = lines[i].slice(key.length + 1).trim()
  const items: string[] = []
  if (inline) items.push(...inline.replace(/^\[|\]$/g, '').split(','))
  else for (let j = i + 1; j < lines.length && /^\s+-\s*/.test(lines[j]); j++) items.push(lines[j].replace(/^\s+-\s*/, ''))
  return items.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** Tags in a document: front-matter `tags` (space- or comma-separated, # optional) and #tags in the text, outside code. */
export function tagsOf(content: string, body: string): string[] {
  const out = new Set<string>()
  for (const item of frontMatterList(content, 'tags'))
    for (const t of item.split(/\s+/)) {
      const tag = t.replace(/^#+/, '').toLowerCase()
      if (tag) out.add(tag)
    }
  let fence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
      const tag = m[1].replace(/[/-]+$/, '').toLowerCase()
      if (!/^\d+$/.test(tag)) out.add(tag) // #1 isn't a tag
    }
  }
  return [...out]
}

// ---- Matching -------------------------------------------------------------------------------

export type Range = [number, number]

export interface MatchOptions {
  matchCase?: boolean
  /** The kind ids a kind: value stands for (a kind's name, say); the value itself if omitted. */
  kindIds?: (value: string) => string[]
}

export interface Matcher {
  /** Does the document pass the filters, contain every positive term and none of the negative ones? */
  matches(doc: SearchDoc): boolean
  /** Where the positive terms are in a line (or the title), sorted and merged. */
  ranges(line: string): Range[]
}

/** A query ready to run. Throws on a broken regex (check `parseQuery(...).error` first). */
export function compile(q: Query, opts: MatchOptions = {}): Matcher {
  const exact = !!opts.matchCase
  const norm = (s: string) => (exact ? s : fold(s))
  type Find = (line: string) => Range[]
  const finder = (t: Term): Find => {
    if (t.type === 'regex') {
      const re = new RegExp(exact ? t.source : stripAccents(t.source), exact ? 'gu' : 'giu')
      return (line) => {
        const out: Range[] = []
        const text = exact ? line : stripAccents(line)
        re.lastIndex = 0
        for (let m = re.exec(text); m; m = re.exec(text)) {
          if (m[0].length === 0) {
            re.lastIndex++
            continue
          }
          out.push([m.index, m.index + m[0].length])
        }
        return out
      }
    }
    const needle = norm(t.value)
    return (line) => {
      const out: Range[] = []
      const text = norm(line)
      for (let i = text.indexOf(needle); i >= 0 && needle; i = text.indexOf(needle, i + needle.length)) out.push([i, i + needle.length])
      return out
    }
  }
  const positive = q.terms.filter((t) => !t.negate).map(finder)
  const negative = q.terms.filter((t) => t.negate).map(finder)
  const kindIds = opts.kindIds ?? ((v: string) => [v])

  const filterHit = (f: Filter, doc: SearchDoc): boolean => {
    const v = fold(f.value)
    switch (f.key) {
      case 'path':
        return fold(doc.path).includes(v)
      case 'kind': {
        const kind = fold(doc.meta.platform || 'essay')
        return kindIds(f.value).some((id) => fold(id) === kind)
      }
      case 'tag':
        return doc.tags.some((t) => fold(t) === v || fold(t).startsWith(v + '/'))
      case 'status':
        return fold(doc.meta.status || 'draft') === v
    }
  }

  return {
    matches(doc) {
      // Filters of one key are alternatives (kind:essay kind:email); different keys must all hold.
      for (const key of FILTERS) {
        const pos = q.filters.filter((f) => f.key === key && !f.negate)
        if (pos.length && !pos.some((f) => filterHit(f, doc))) return false
        if (q.filters.some((f) => f.key === key && f.negate && filterHit(f, doc))) return false
      }
      const texts = [doc.title, ...doc.lines]
      const found = (find: Find) => texts.some((l) => find(l).length > 0)
      return positive.every(found) && !negative.some(found)
    },
    ranges(line) {
      return merge(positive.flatMap((find) => find(line)))
    },
  }
}

/** Accents off, case kept, one character for one (so regex positions still line up). */
function stripAccents(s: string) {
  let out = ''
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/\p{M}+/gu, '')
    out += f.length === ch.length ? f : ch
  }
  return out
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

// ---- Snippets -------------------------------------------------------------------------------

export interface Snippet {
  text: string
  ranges: Range[]
}

/** About `width` characters of a line around its first match, cut at word edges, with the matches' ranges moved to fit. */
export function snippet(line: string, ranges: Range[], width = 80): Snippet {
  const text = line.trim()
  const lead = line.length - line.trimStart().length
  const rs = ranges.map(([a, b]): Range => [Math.max(0, a - lead), Math.min(text.length, b - lead)]).filter(([a, b]) => b > a)
  if (text.length <= width) return { text, ranges: rs }
  const first = rs[0] ?? [0, 0]
  let start = Math.max(0, Math.min(first[0] - Math.floor((width - (first[1] - first[0])) / 3), text.length - width))
  let end = Math.min(text.length, start + width)
  // Whole words at the edges.
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space >= 0 && space < first[0]) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > Math.max(start, first[1])) end = space
  }
  const pre = start > 0 ? '…' : ''
  const post = end < text.length ? '…' : ''
  const shift = pre.length - start
  return {
    text: pre + text.slice(start, end) + post,
    ranges: rs.filter(([a, b]) => a >= start && b <= end).map(([a, b]): Range => [a + shift, b + shift]),
  }
}

/**
 * Which occurrence of `text` a match at `line`/`at` is, counting exact occurrences in the lines
 * before it and earlier in its own line. The page's find counts the same way, so opening the
 * document can select this very match.
 */
export function occurrence(lines: readonly string[], line: number, at: number, text: string): number {
  if (!text) return 0
  let n = 0
  const count = (s: string) => {
    for (let i = s.indexOf(text); i >= 0; i = s.indexOf(text, i + text.length)) n++
  }
  for (let i = 0; i < line; i++) count(lines[i])
  count(lines[line].slice(0, at))
  return n
}
