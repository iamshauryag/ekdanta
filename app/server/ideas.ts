// Ideas: one-line ideas the writer captures in a couple of seconds, kept in `ideas.md` at the top of the
// vault as a plain Markdown list ("- idea (6 Nov 2026)"), readable in Obsidian or on a phone. The app only
// ever appends to that file. What the app adds on top (stars, and the parts of ideas the idea partner
// proposed: title, hook, angle, kinds, sources) lives in .ekdanta/ideas.json, keyed by the idea's text;
// which ideas were started is read from the pieces' own `from-idea` front matter.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { joinDoc, patchFrontMatter, splitFrontMatter } from '../src/lib/frontmatter.ts'
import { findKind, kindName, type Kind } from '../src/lib/kinds.ts'
import { IDEAS_FILE, isSpecialFile } from '../src/lib/special.ts'
import { writeBrief } from './brief.ts'
import { HttpError } from './net.ts'
import { seedThinking } from './thinking.ts'
import { META_DIR, atomicWrite, createDoc, listFiles, nameDoc, placeDoc, readDoc, resolveInVault, writeDoc } from './vault.ts'

export { IDEAS_FILE }

// ---- Pure helpers (tested in ideas.test.ts) ---------------------------------------------------

export interface Idea {
  text: string
  /** The date written after it, as written: "6 Nov 2026" (or "2026-11-06" from elsewhere). */
  date?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "6 Nov 2026": short, plain, and the same in every locale. */
export const formatIdeaDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

// A list marker ("-", "*", "+", "1." or "1)"), then perhaps a task box.
const MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:\s+|$)(?:\[[ xX]\](?:\s+|$))?/
// A date in brackets at the end of the line: "(6 Nov 2026)", "(6 November 2026)" or "(2026-11-06)".
const TRAILING_DATE = /\s*\((\d{1,2} [A-Za-z]{3,9}\.? \d{4}|\d{4}-\d{2}-\d{2})\)\s*$/

// A bullet typed into the capture box. Numbers are the writer's words ("3. reasons I quit coffee"), so they stay.
const BULLET = /^[-*+](?:\s+|$)(?:\[[ xX]\](?:\s+|$))?/

/** The idea as one tidy line: whitespace (newlines included) collapsed, and no bullet of its own. */
export function cleanIdea(text: string): string {
  let t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  // "- my idea" typed into the box shouldn't become "- - my idea".
  for (let m = t.match(BULLET); m && m[0]; m = t.match(BULLET)) t = t.slice(m[0].length).trim()
  return t
}

/** The key stars and started pieces are matched by: the idea's text with whitespace collapsed. */
export const ideaKey = (text: string) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** The line Capture idea appends. */
export const ideaLine = (text: string, date: string) => `- ${cleanIdea(text)} (${date})`

/**
 * Every idea in ideas.md, in file order. Lenient, because the file is the writer's too: any list item
 * ("-", "*", "+", "1.", a task box) or any plain line is an idea; an indented line under an idea carries
 * it on. Headings, rules, comments, code fences and front matter are not ideas.
 */
export function parseIdeas(raw: string): Idea[] {
  const out: Idea[] = []
  const lines = splitFrontMatter(String(raw ?? '').replace(/\r\n?/g, '\n')).body.split('\n')
  let fence = false
  let comment = false
  let last: { text: string } | null = null
  for (const line of lines) {
    const t = line.trim()
    if (/^(```|~~~)/.test(t)) {
      fence = !fence
      last = null
      continue
    }
    if (fence) continue
    if (comment || t.startsWith('<!--')) {
      comment = !t.includes('-->')
      last = null
      continue
    }
    if (!t) {
      last = null
      continue
    }
    const unquoted = t.replace(/^(>\s?)+/, '').trim()
    // A rule ("---", "* * *") or a heading isn't an idea.
    if (/^([-*_])(\s*\1){2,}$/.test(unquoted) || /^#{1,6}(\s|$)/.test(unquoted)) {
      last = null
      continue
    }
    const marker = unquoted.match(MARKER)
    if (!marker) {
      // An indented line straight after an idea is that idea wrapped onto a second line.
      if (last && /^\s/.test(line)) {
        last.text += ' ' + unquoted
        continue
      }
    }
    const text = marker ? unquoted.slice(marker[0].length) : unquoted
    if (!text.trim()) {
      last = null
      continue
    }
    last = { text }
    out.push(last as Idea)
  }
  // The date goes once the whole idea is read, so a wrapped one keeps the date on its last line.
  return out
    .map((idea) => {
      const text = ideaKey(idea.text)
      const m = text.match(TRAILING_DATE)
      const rest = m ? text.slice(0, m.index).trim() : text
      return m && rest ? { text: rest, date: m[1] } : { text }
    })
    .filter((idea) => idea.text)
}

/** Newest first: Capture idea appends, so the last line is the newest. One row per idea, at its newest. */
export function newestFirst(ideas: Idea[]): Idea[] {
  const seen = new Set<string>()
  const out: Idea[] = []
  for (let i = ideas.length - 1; i >= 0; i--) {
    const key = ideaKey(ideas[i].text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ideas[i])
  }
  return out
}

/**
 * ideas.md with one more idea at the end, or `added: false` when the same idea was already captured
 * that day. A missing (or empty) file starts with an "Ideas" heading.
 */
export function appendIdea(raw: string | null, text: string, date: string): { content: string; added: boolean } {
  const clean = cleanIdea(text)
  if (!clean) throw new HttpError(400, 'An idea needs some words')
  const current = raw ?? ''
  if (parseIdeas(current).some((i) => i.text === ideaKey(clean) && i.date === date)) return { content: current, added: false }
  const line = ideaLine(clean, date)
  if (!current.trim()) return { content: `# Ideas\n\n${line}\n`, added: true }
  return { content: current.replace(/\n*$/, '\n') + line + '\n', added: true }
}

// ---- Ideas with more to them: the idea partner's (pure) ---------------------------------------

/** Where an idea grew from: a note or past piece, a highlight kept in the Brain, or another captured idea. */
export interface IdeaSource {
  doc: string
  title: string
  /** The passage it drew on, as it was when the idea was kept. */
  text?: string
  type?: 'note' | 'highlight' | 'idea'
}

/** What the app keeps beside an idea the partner proposed: ideas.md holds only its one line. */
export interface IdeaDetail {
  title: string
  hook?: string
  angle: string
  /** Kind ids it would suit, best first. */
  platforms: string[]
  sources: IdeaSource[]
}

/** The [[links]] in a line, by target: "[[a/b|shown]]" is "a/b". */
export function wikiLinks(text: string): string[] {
  const out: string[] = []
  for (const m of String(text ?? '').matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    const t = m[1].trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** The line without its group of links at the end ("… ([[a]], [[b]])"), for showing beside the links as chips. */
export const withoutLinkGroup = (text: string) => text.replace(/\s*\((?:\s*\[\[[^\]\n]+\]\]\s*,?)+\)\s*$/, '').trim()

/** A link's note, as Obsidian finds it: by path, or else by file name; case doesn't matter. */
export function resolveLink<T extends { path: string }>(target: string, files: T[]): T | undefined {
  const t = target.replace(/\.md$/i, '').replace(/^\/+/, '').toLowerCase()
  const bare = (p: string) => p.replace(/\.md$/i, '').toLowerCase()
  return files.find((f) => bare(f.path) === t) ?? files.find((f) => bare(f.path).split('/').pop() === t.split('/').pop())
}

/** How a note is linked: its file name, or its path when two notes share that name. */
export function linkName(doc: string, files: { path: string }[]): string {
  const name = doc.replace(/\.md$/i, '').split('/').pop()!
  const clash = files.filter((f) => f.path.replace(/\.md$/i, '').split('/').pop()!.toLowerCase() === name.toLowerCase()).length > 1
  return clash ? doc.replace(/\.md$/i, '') : name
}

/** The ideas.md line for a kept idea: "Title — angle ([[note]], [[other]])". Captured ideas it drew on aren't linked. */
export function detailLine(d: IdeaDetail, files: { path: string }[]): string {
  const docs = [...new Set(d.sources.filter((s) => !isSpecialFile(s.doc)).map((s) => s.doc))]
  const links = docs.map((doc) => `[[${linkName(doc, files)}]]`).join(', ')
  return cleanIdea(`${d.title} — ${d.angle}${links ? ` (${links})` : ''}`)
}

/**
 * The brief pinned to a piece started from an idea: what it is, its angle and hook, the kinds it
 * suits, and the notes it came from. The writer can edit or unpin it like any brief.
 */
export function ideaBrief(idea: string, detail: IdeaDetail | undefined, sources: { doc: string; title: string }[], kinds: Kind[]): string {
  const lines: string[] = []
  if (detail) {
    lines.push(`Idea: ${detail.title}`)
    if (detail.hook) lines.push(`Hook: ${detail.hook}`)
    lines.push(`Angle: ${detail.angle}`)
    const names = detail.platforms.map((id) => findKind(kinds, id)?.name).filter(Boolean)
    if (names.length) lines.push(`For: ${names.join(', ')}`)
  } else lines.push(`Idea: ${withoutLinkGroup(idea) || idea}`)
  const notes = [...new Map(sources.filter((s) => !isSpecialFile(s.doc)).map((s) => [s.doc, s])).values()]
  if (notes.length) lines.push(`From: ${notes.map((s) => `[[${s.doc.replace(/\.md$/i, '')}|${s.title.replace(/[\]|[]/g, '') || s.doc}]]`).join(', ')}`)
  return lines.join('\n')
}

/** Escape what Markdown would read as formatting, so an idea shows as written inside the prompt's italics. */
export const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>~=|#])/g, '\\$1')

/** The faded line at the top of a piece started from an idea: a template-style `*Prompt: …*` paragraph. */
export const ideaPrompt = (text: string) => `*Prompt: ${escapeMarkdown(ideaKey(text))}*`

/** A template's body for a new piece, without its front matter. Variables we can fill are filled; {{cursor}} goes. */
export function templateBody(raw: string, vars: { date: string; kind: string }): string {
  return splitFrontMatter(raw)
    .body.replace(/\{\{\s*cursor\s*\}\}/gi, '')
    .replace(/\{\{\s*date\s*\}\}/gi, vars.date)
    .replace(/\{\{\s*kind\s*\}\}/gi, vars.kind)
    .replace(/^\s*\n/, '')
}

// ---- The file and the app's notes on it --------------------------------------------------------

const STATE = path.join(META_DIR, 'ideas.json')

interface IdeasState {
  starred: string[]
  /** What the idea partner proposed for ideas the writer kept, by the idea's key. */
  partner: Record<string, IdeaDetail>
  /** Titles of partner ideas the writer discarded, newest last, so they aren't proposed again. */
  dismissed: string[]
}

/** The most kept ideas' details and discarded titles remembered, so the file stays small. */
const MAX_DETAILS = 500
const MAX_DISMISSED = 300

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A stored detail, checked: the file is the writer's to edit, so anything odd in it is left out. */
function checkDetail(v: unknown): IdeaDetail | null {
  const d = v as Partial<IdeaDetail> | null
  if (!d || typeof d.title !== 'string' || typeof d.angle !== 'string') return null
  const sources = (Array.isArray(d.sources) ? d.sources : []).filter((s): s is IdeaSource => !!s && typeof s.doc === 'string' && typeof s.title === 'string')
  return { title: d.title, angle: d.angle, ...(typeof d.hook === 'string' && d.hook ? { hook: d.hook } : {}), platforms: strings(d.platforms), sources }
}

async function readState(): Promise<IdeasState> {
  try {
    const s = JSON.parse(await fs.readFile(STATE, 'utf8')) as Partial<IdeasState>
    const partner: Record<string, IdeaDetail> = {}
    for (const [k, v] of Object.entries(s.partner && typeof s.partner === 'object' ? s.partner : {})) {
      const d = checkDetail(v)
      if (d) partner[k] = d
    }
    return { starred: strings(s.starred), partner, dismissed: strings(s.dismissed) }
  } catch {
    return { starred: [], partner: {}, dismissed: [] }
  }
}

async function writeState(state: IdeasState) {
  const keys = Object.keys(state.partner)
  const partner = keys.length > MAX_DETAILS ? Object.fromEntries(keys.slice(-MAX_DETAILS).map((k) => [k, state.partner[k]])) : state.partner
  await fs.mkdir(META_DIR, { recursive: true })
  await atomicWrite(STATE, JSON.stringify({ ...state, partner, dismissed: state.dismissed.slice(-MAX_DISMISSED) }, null, 2))
}

// One change at a time, so two quick captures (or stars) can't each miss the other's.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

const readIdeasFile = () => readDoc(IDEAS_FILE).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
const mtimeOf = () =>
  fs.stat(resolveInVault(IDEAS_FILE)).then(
    (s) => s.mtimeMs,
    () => null,
  )

/**
 * Add an idea to ideas.md. The file is read afresh just before the write (and read again if it changed
 * in between), so a line added on a phone or in another editor is kept, never overwritten.
 */
export function captureIdea(text: string, date = formatIdeaDate(new Date())) {
  return serial(async () => {
    for (let attempt = 0; ; attempt++) {
      const before = await mtimeOf()
      const raw = await readIdeasFile()
      const { content, added } = appendIdea(raw, text, date)
      if (!added) return { added: false, text: cleanIdea(text), date }
      if ((await mtimeOf()) !== before && attempt < 3) continue
      await writeDoc(IDEAS_FILE, content, { reason: 'idea' })
      return { added: true, text: cleanIdea(text), date }
    }
  })
}

export interface IdeaRow extends Idea {
  starred: boolean
  /** The newest piece started from this idea, while it still exists. */
  started?: { path: string; title: string }
  /** The line as shown: without its group of [[links]], which come as `sources` instead. */
  shown?: string
  /** For an idea the partner proposed: its parts, as kept. */
  title?: string
  hook?: string
  angle?: string
  platforms?: string[]
  /** The notes it links to or came from; `path` is missing when the note is no longer in the vault. */
  sources?: { name: string; path?: string }[]
}

/** The list for the Ideas page: newest first, with stars, started pieces and the notes each came from. */
export async function listIdeas(): Promise<{ exists: boolean; ideas: IdeaRow[] }> {
  const raw = await readIdeasFile()
  const { starred, partner } = await readState()
  const stars = new Set(starred)
  const files = await listFiles()
  const started = new Map<string, { path: string; title: string; mtime: number }>()
  for (const f of files) {
    if (!f.fromIdea) continue
    const key = ideaKey(f.fromIdea)
    const prev = started.get(key)
    if (!prev || f.mtime > prev.mtime) started.set(key, { path: f.path, title: f.title, mtime: f.mtime })
  }
  const ideas = newestFirst(parseIdeas(raw ?? '')).map((idea): IdeaRow => {
    const key = ideaKey(idea.text)
    const s = started.get(key)
    const d = partner[key]
    const links = wikiLinks(idea.text)
    const shown = links.length ? withoutLinkGroup(idea.text) : undefined
    const sources = links.map((name) => {
      const hit = resolveLink(name, files)
      return hit ? { name, path: hit.path } : { name }
    })
    return {
      ...idea,
      starred: stars.has(key),
      ...(s ? { started: { path: s.path, title: s.title } } : {}),
      ...(shown && shown !== idea.text ? { shown } : {}),
      ...(d ? { title: d.title, angle: d.angle, platforms: d.platforms, ...(d.hook ? { hook: d.hook } : {}) } : {}),
      ...(sources.length ? { sources } : {}),
    }
  })
  return { exists: raw !== null, ideas }
}

/** Star an idea, or un-star it. ideas.md is not touched. */
export function starIdea(text: string, on: boolean) {
  return serial(async () => {
    const key = ideaKey(text)
    if (!key) throw new HttpError(400, 'No idea to star')
    const state = await readState()
    const starred = state.starred.filter((s) => s !== key)
    if (on) starred.push(key)
    await writeState({ ...state, starred })
    return { starred: on }
  })
}

/** Every captured idea's text, and the titles of partner ideas kept or discarded: what a new batch mustn't repeat. */
export async function knownIdeas(): Promise<{ texts: string[]; dismissed: string[] }> {
  const raw = await readIdeasFile()
  const state = await readState()
  const texts = parseIdeas(raw ?? '').map((i) => withoutLinkGroup(i.text) || i.text)
  return { texts: [...texts, ...Object.values(state.partner).map((d) => d.title)], dismissed: state.dismissed }
}

/** Keep an idea the partner proposed: its line appended to ideas.md, its parts kept beside it. */
export async function keepDetail(detail: IdeaDetail) {
  const text = detailLine(detail, await listFiles())
  const captured = await captureIdea(text)
  const key = ideaKey(captured.text)
  await serial(async () => {
    const state = await readState()
    delete state.partner[key] // re-kept: it goes to the end, so the newest are the ones remembered
    state.partner[key] = detail
    state.dismissed = state.dismissed.filter((t) => t !== detail.title)
    await writeState(state)
  })
  return { ...captured, key }
}

/** Remember a partner idea the writer discarded, by its title. */
export function dismissIdeaTitle(title: string) {
  return serial(async () => {
    const t = cleanIdea(title).slice(0, 300)
    if (!t) throw new HttpError(400, 'No idea to discard')
    const state = await readState()
    state.dismissed = [...state.dismissed.filter((x) => x !== t), t]
    await writeState(state)
  })
}

/** A note's first paragraph worth quoting: for a source known only by a [[link]]. */
function firstParagraph(raw: string) {
  const paras = splitFrontMatter(raw)
    .body.split(/\n\s*\n/)
    .map((p) => p.trim())
  return paras.find((p) => p.length >= 60 && !/^(#|```|[-*+] |>)/.test(p)) ?? paras.find((p) => p && !p.startsWith('#')) ?? ''
}

/** The most source passages a new piece's Thinking Space is seeded with. */
const MAX_SEED = 8

/**
 * The sources an idea came from, as they are now: a note that moved is found by its file name, as a
 * link would be; one that's gone is counted, not quoted. A source known only by a link brings its
 * first paragraph. A captured idea it drew on comes as a fragment of its own.
 */
export async function liveSources(sources: IdeaSource[]) {
  const files = await listFiles()
  const found: { doc: string; title: string; folder: string; text: string; idea?: boolean }[] = []
  let missing = 0
  for (const s of sources.slice(0, MAX_SEED)) {
    if (isSpecialFile(s.doc)) {
      if (s.text) found.push({ doc: IDEAS_FILE, title: 'Ideas', folder: '', text: s.text, idea: true })
      continue
    }
    const f = files.find((x) => x.path === s.doc) ?? resolveLink(s.doc, files)
    if (!f) {
      missing++
      continue
    }
    const text = s.text?.trim() || firstParagraph(await readDoc(f.path).catch(() => ''))
    if (text) found.push({ doc: f.path, title: f.title || s.title, folder: f.folder, text: text.slice(0, 2000) })
  }
  return { found, missing }
}

/**
 * Start a piece of the given kind from an idea: a new draft filed with that kind, its template's body
 * if the kind has one, and a pinned brief from the idea. A plain captured idea also sits at the top as
 * a faded prompt; one the partner proposed names the piece instead. Whatever the idea came from (its
 * sources, or the notes it links to) waits in the piece's Thinking Space, quoted with chips that open
 * them. `from-idea` in its front matter is how the Ideas page knows it was started.
 */
export async function startIdeaPiece(kinds: Kind[], text: string, kindId: string): Promise<{ path: string; seeded: boolean; missing: number }> {
  // The idea exactly as the list keys it, so its row shows Started (a cleaned copy could differ).
  const idea = ideaKey(text)
  if (!idea) throw new HttpError(400, 'No idea to start from')
  const kind = findKind(kinds, kindId)
  if (!kind) throw new HttpError(400, 'Unknown kind of writing')
  const detail = (await readState()).partner[idea]
  const sources = detail ? detail.sources : wikiLinks(idea).map((name) => ({ doc: name, title: name }))
  const { found, missing } = await liveSources(sources)

  const rel = await createDoc(kinds, '', kind.id)
  const fm = splitFrontMatter(await readDoc(rel))
  const { meta, body } = fm
  let template = ''
  if (kind.template) {
    const tpl = await readDoc(kind.template).catch(() => null)
    if (tpl !== null) template = templateBody(tpl, { date: meta.created ?? '', kind: kindName(kinds, kind.id) })
  }
  const next = [detail ? '' : ideaPrompt(idea), template.trim(), body.trim()].filter(Boolean).join('\n\n') + '\n'
  const patch: Record<string, string> = { 'from-idea': idea, ...(detail ? { title: detail.title } : {}) }
  await writeDoc(rel, joinDoc({ ...patchFrontMatter(fm, patch), body: next }), { reason: 'create' })
  const named = detail ? await nameDoc(rel, detail.title) : rel
  const placed = await placeDoc(kinds, named)

  await writeBrief(placed, ideaBrief(idea, detail, found, kinds))
  const heads = [
    ...(detail ? [{ text: detail.angle, mark: 'Idea' }] : []),
    ...(detail?.hook ? [{ text: detail.hook, mark: 'Hook' }] : []),
    ...found.filter((s) => s.idea).map((s) => ({ text: s.text, mark: 'Your idea' })),
  ]
  const quotes = found.filter((s) => !s.idea).map((s) => ({ text: s.text, from: { doc: s.doc, title: s.title, folder: s.folder } }))
  const seeded = quotes.length > 0 || (detail !== undefined && heads.length > 0)
  if (seeded) await seedThinking(placed, [...heads, ...quotes])
  return { path: placed, seeded, missing }
}

/** Start a piece from an idea, and say only where it is (see startIdeaPiece). */
export const startIdea = async (kinds: Kind[], text: string, kindId: string): Promise<string> => (await startIdeaPiece(kinds, text, kindId)).path
