// Front matter: the one parser for client and server. It reads the small subset of YAML that notes
// use (scalars, quoted strings, [a, b] and `- a` lists) and keeps everything else as the writer
// wrote it. Only keys Ekdanta changes are rewritten; a block it can't model is never rewritten.
export type Meta = Record<string, string>
export type Lists = Record<string, string[]>

/** A change to front matter: a string or a list sets the key, null removes it. */
export type MetaPatch = Record<string, string | string[] | null>

export interface FrontMatter {
  /** Every key's value as text. A list's items are joined with ', '. */
  meta: Meta
  /** The keys whose value is a list, with their items. */
  lists: Lists
  /** The document after the front matter, with LF line endings. */
  body: string
  /** The lines between the fences, LF line endings, exactly as written otherwise. '' when there is none. */
  raw: string
  /** The file's line ending, restored on write. */
  eol: '\n' | '\r\n'
  /** The file started with a byte-order mark, restored on write. */
  bom: boolean
  /** A blank line followed the closing fence. */
  gap: boolean
  /** Something here can't be modelled (nested maps, block text, tabs, broken YAML): never rewrite it. */
  readonly: boolean
  /** Why it's read-only, for the writer. */
  problem?: string
  /** The front matter exactly as it was on disk (BOM, fences, line endings, blank line). */
  head: string
}

const FENCE = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/
// A key: letters (any script), digits, _ . - and single spaces, as Obsidian vaults write them.
const KEY = /^([\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]*(?: [\p{L}\p{N}\p{M}_.-]+)*)[ ]*:(?:[ ]+(.*?))?[ ]*$/u

/** Split a document into its front matter and body. */
export function splitFrontMatter(content: string): FrontMatter {
  const bom = content.startsWith('\uFEFF')
  const text = bom ? content.slice(1) : content
  // The file's line ending is its first line's: one pasted CRLF line further down doesn't make an LF file CRLF.
  const nl = text.indexOf('\n')
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'
  const lf = text.replace(/\r\n/g, '\n')
  // An LF file keeps any stray CRLF lines in its body as they are; a CRLF file is read as LF and written back as CRLF.
  const asIs = (lfFrom: number) => (eol === '\n' ? text.slice(offsetOf(text, lf, lfFrom)) : lf.slice(lfFrom))
  const none = (): FrontMatter => ({ meta: {}, lists: {}, body: asIs(0), raw: '', eol, bom, gap: true, readonly: false, head: bom ? '\uFEFF' : '' })
  const m = lf.match(FENCE)
  if (!m) return none()
  const raw = m[1] ?? ''
  const parsed = parseBlock(raw)
  // A page that opens with a horizontal rule: nothing between the rules reads as a property, so it's text.
  if (parsed.problem && !parsed.keys) return none()
  let end = m[0].length
  // Drop the blank line that conventionally follows the closing fence; joinFrontMatter restores it.
  const gap = lf[end] === '\n'
  if (gap) end++
  const headLf = lf.slice(0, end)
  const head = (bom ? '\uFEFF' : '') + (eol === '\r\n' ? headLf.replace(/\n/g, '\r\n') : text.slice(0, offsetOf(text, lf, end)))
  return { meta: parsed.meta, lists: parsed.lists, body: asIs(end), raw, eol, bom, gap, readonly: !!parsed.problem, problem: parsed.problem, head }
}

/** Where position `at` of the CRLF-normalised `lf` falls in the original `text`. */
function offsetOf(text: string, lf: string, at: number) {
  if (text.length === lf.length) return at
  let i = 0
  let j = 0
  while (j < at) {
    if (text[i] === '\r' && text[i + 1] === '\n') i++
    i++
    j++
  }
  return i
}

// ---- Parsing ----------------------------------------------------------------------------------

interface Entry {
  key: string | null // null: a comment, a blank line, or a line we keep as is
  lines: string[]
  /** How the value is written. */
  style: 'scalar' | 'flow' | 'block'
  value: string
  items: string[]
  /** The text before '- ' on a block list's items. */
  indent: string
}

/**
 * Group the block's lines into entries: a key with its value, and a block list's items with it.
 * The first thing it can't read is the problem; reading carries on past it, so the keys it can
 * read (a title, say) are still known, though the block is never rewritten.
 */
function entries(raw: string): { entries: Entry[]; problem?: string; keyed: number } {
  const out: Entry[] = []
  let problem: string | undefined
  let keyed = 0 // lines that name a key, whether or not their value can be read
  if (!raw) return { entries: out, keyed }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      out.push({ key: null, lines: [line], style: 'scalar', value: '', items: [], indent: '' })
      continue
    }
    // The lines that belong to this one: indented ones, and unindented `- ` items.
    let j = i + 1
    while (j < lines.length && (/^\s+\S/.test(lines[j]) || /^-(\s|$)/.test(lines[j]))) j++
    const children = lines.slice(i + 1, j)
    i = j - 1
    if (KEY.test(line)) keyed++
    const why = read(line, children, out)
    problem ??= why
  }
  return { entries: out, problem, keyed }
}

/** Read one key and its child lines into `out`. Returns what's wrong with them, if anything. */
function read(line: string, children: string[], out: Entry[]): string | undefined {
  if (/^\s*\t/.test(line) || children.some((c) => /^\s*\t/.test(c))) return 'It is indented with tabs.'
  const kv = line.match(KEY)
  if (!kv) return /^\s/.test(line) ? 'It has nested values.' : `This line isn't a property: “${line.trim().slice(0, 40)}”.`
  const key = kv[1]
  const value = kv[2] ?? ''
  const entry: Entry = { key, lines: [line, ...children], style: 'scalar', value: '', items: [], indent: '' }
  if (children.length) {
    if (value !== '') return `“${key}” continues over several lines.`
    for (const child of children) {
      if (/^\s*#/.test(child)) continue // a comment among the items; kept until the list changes
      const item = child.match(/^(\s*-)(?:[ ]+(.*?))?[ ]*$/)
      if (!item) return `“${key}” has nested values.`
      const v = scalar(item[2] ?? '')
      if (v === null || /^[[{]/.test(item[2] ?? '')) return `“${key}” has a list item Ekdanta can't read.`
      entry.items.push(v)
      entry.indent ||= item[1].slice(0, -1)
    }
    entry.style = 'block'
    entry.value = entry.items.join(', ')
  } else if (value.startsWith('[')) {
    const items = flow(value)
    if (!items) return `“${key}” has a list Ekdanta can't read.`
    entry.style = 'flow'
    entry.items = items
    entry.value = items.join(', ')
  } else {
    const v = scalar(value)
    if (v === null) return `“${key}” has a value Ekdanta can't read.`
    entry.value = v
  }
  out.push(entry)
}

function parseBlock(raw: string): { meta: Meta; lists: Lists; problem?: string; keys: number } {
  const meta: Meta = {}
  const lists: Lists = {}
  const { entries: list, problem: first, keyed } = entries(raw)
  let problem = first
  for (const e of list) {
    if (e.key === null) continue
    // Which of two values counts is YAML-reader dependent; rewriting either would change what the file says.
    if (e.key in meta) problem ??= `“${e.key}” is written twice.`
    meta[e.key] = e.value
    if (e.style === 'scalar') delete lists[e.key]
    else lists[e.key] = e.items
  }
  return { meta, lists, problem, keys: keyed }
}

/** A plain or quoted YAML scalar, or null for one we don't read (block text, anchors, maps). */
function scalar(v: string): string | null {
  v = v.trim()
  if (v === '' || v === '~' || v === 'null') return v === '' ? '' : v
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/)
    if (!m) return null
    try {
      return JSON.parse(`"${m[1].replace(/\\'/g, "'")}"`) as string
    } catch {
      return m[1]
    }
  }
  if (v.startsWith("'")) {
    const m = v.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)
    return m ? m[1].replace(/''/g, "'") : null
  }
  if (/^[|>&*{!%@`]/.test(v)) return null
  // A comment ends a plain value.
  return v.replace(/\s+#.*$/, '')
}

/** An inline list: [a, "b, c", 'd']. Null when it nests or never closes. */
function flow(v: string): string[] | null {
  const m = v.trim().match(/^\[(.*)\]\s*(?:#.*)?$/)
  if (!m) return null
  const items: string[] = []
  let rest = m[1].trim()
  while (rest) {
    let item: string | null
    let len: number
    const q = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/)
    if (q) {
      item = scalar(q[1])
      len = q[1].length
    } else {
      const end = rest.indexOf(',')
      const token = end < 0 ? rest : rest.slice(0, end)
      if (/[[\]{}]/.test(token)) return null
      item = scalar(token)
      len = token.length
    }
    if (item === null) return null
    if (item !== '') items.push(item)
    rest = rest.slice(len).trim()
    if (rest && !rest.startsWith(',')) return null
    rest = rest.slice(1).trim()
  }
  return items
}

// ---- Changing -------------------------------------------------------------------------------

/** Apply a patch to a flat set of keys (lists are set as their ', ' text). */
export function applyPatch(meta: Meta, patch: MetaPatch): Meta {
  const next = { ...meta }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || (Array.isArray(v) && !v.length)) delete next[k]
    else next[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return next
}

/** Apply a patch to a document's front matter. A list that ends up empty removes its key. */
export function patchFrontMatter(fm: FrontMatter, patch: MetaPatch): FrontMatter {
  if (fm.readonly) return fm
  const meta = { ...fm.meta }
  const lists = { ...fm.lists }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || (Array.isArray(v) && !v.length)) {
      delete meta[k]
      delete lists[k]
    } else if (Array.isArray(v)) {
      const items = v.map((s) => s.trim()).filter(Boolean)
      // `tags: craft` stays a string while it still says the same thing.
      if (!(k in lists) && k in meta && (same(splitList(meta[k]), items) || same(splitWords(meta[k]), items))) continue
      meta[k] = items.join(', ')
      lists[k] = items
    } else {
      meta[k] = v
      delete lists[k]
    }
  }
  return { ...fm, meta, lists }
}

/** A key's value as a list: its items, or a plain value split at commas. */
export function listOf(fm: Pick<FrontMatter, 'meta' | 'lists'>, key: string): string[] {
  return fm.lists[key] ?? (fm.meta[key] ? splitList(fm.meta[key]) : [])
}

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
/** A plain value split at commas and spaces, as `tags: craft essays` is read. */
export const splitWords = (s: string) => s.split(/[\s,]+/).filter(Boolean)
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export interface JoinOptions {
  lists?: Lists
  eol?: '\n' | '\r\n'
  bom?: boolean
  gap?: boolean
  readonly?: boolean
  head?: string
}

/** Put a document back together. Lines for keys that didn't change keep their exact bytes. */
export function joinFrontMatter(raw: string, meta: Meta, body: string, opts: JoinOptions = {}): string {
  const eol = opts.eol ?? '\n'
  const out = (s: string) => (opts.bom ? '\uFEFF' : '') + (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s)
  if (opts.readonly && opts.head !== undefined) {
    // Never rewritten: the front matter goes back byte for byte.
    return opts.head + (eol === '\r\n' ? body.replace(/\r?\n/g, '\r\n') : body)
  }
  const lists = opts.lists
  const { entries: list } = entries(raw)
  if (parseBlock(raw).problem) return out(`---\n${raw}\n---\n${opts.gap === false ? '' : '\n'}${body}`) // a block we can't read stays as it is
  const indent = list.find((e) => e.style === 'block')?.indent ?? '  '
  const done = new Set<string>()
  const lines: string[] = []
  for (const e of list) {
    if (e.key === null) {
      lines.push(...e.lines)
      continue
    }
    const key = e.key
    if (!(key in meta)) continue // removed
    done.add(key)
    const items = lists?.[key]
    if (items) {
      if (e.style !== 'scalar' && same(e.items, items)) lines.push(...e.lines)
      else if (e.style === 'flow') lines.push(`${key}: ${flowValue(items)}`)
      else lines.push(...blockList(key, items, e.style === 'block' ? e.indent : indent))
    } else if (e.style === 'scalar' && e.value === meta[key]) lines.push(...e.lines)
    else if (e.style !== 'scalar' && e.value === meta[key])
      lines.push(...e.lines) // an older caller that only knows the text
    else lines.push(`${key}: ${yamlValue(meta[key])}`)
  }
  for (const [key, value] of Object.entries(meta)) {
    if (done.has(key)) continue
    const items = lists?.[key]
    if (items) lines.push(...blockList(key, items, indent))
    else lines.push(`${key}: ${yamlValue(value)}`)
  }
  if (!lines.some((l) => l.trim())) return out(body)
  return out(`---\n${lines.join('\n')}\n---\n${opts.gap === false ? '' : '\n'}${body}`)
}

/** Put a document back together from what splitFrontMatter gave (and patchFrontMatter changed). */
export const joinDoc = (fm: FrontMatter) => joinFrontMatter(fm.raw, fm.meta, fm.body, fm)

/** Change a document's front matter, leaving its body alone. */
export const patchContent = (content: string, patch: MetaPatch) => joinDoc(patchFrontMatter(splitFrontMatter(content), patch))

const blockList = (key: string, items: string[], indent: string) => [`${key}:`, ...items.map((i) => `${indent}- ${yamlValue(i)}`)]

const flowValue = (items: string[]) => `[${items.map((i) => (/[,[\]{}#"']|^\s|\s$/.test(i) || i === '' ? JSON.stringify(i) : yamlValue(i))).join(', ')}]`

/**
 * Quote a value only when plain YAML would misread it (a colon, a comment, a leading quote or symbol),
 * or when reading it back would change it (a value ending in a quote mark, or spanning lines).
 */
function yamlValue(value: string) {
  if (value === '' || !/(: |:$|\s#|^[\s"'`!&*?|>%@{}[\],#-]|["'\s]$|[\r\n])/.test(value)) return value
  return JSON.stringify(value)
}
