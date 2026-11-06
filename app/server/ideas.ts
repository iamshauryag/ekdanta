// Ideas: one-line ideas the writer captures in a couple of seconds, kept in `ideas.md` at the top of the
// vault as a plain Markdown list ("- idea (6 Nov 2026)"), readable in Obsidian or on a phone. The app only
// ever appends to that file. What the app adds on top (stars) lives in .ekdanta/ideas.json, keyed by the
// idea's text; which ideas were started is read from the pieces' own `from-idea` front matter.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyPatch, joinFrontMatter, splitFrontMatter } from '../src/lib/frontmatter.ts'
import { findKind, kindName, type Kind } from '../src/lib/kinds.ts'
import { IDEAS_FILE } from '../src/lib/special.ts'
import { HttpError } from './net.ts'
import { META_DIR, atomicWrite, createDoc, listFiles, placeDoc, readDoc, resolveInVault, writeDoc } from './vault.ts'

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
}

async function readState(): Promise<IdeasState> {
  try {
    const s = JSON.parse(await fs.readFile(STATE, 'utf8')) as Partial<IdeasState>
    return { starred: Array.isArray(s.starred) ? s.starred.filter((x): x is string => typeof x === 'string') : [] }
  } catch {
    return { starred: [] }
  }
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
}

/** The list for the Ideas page: newest first, with stars and started pieces. */
export async function listIdeas(): Promise<{ exists: boolean; ideas: IdeaRow[] }> {
  const raw = await readIdeasFile()
  const { starred } = await readState()
  const stars = new Set(starred)
  const started = new Map<string, { path: string; title: string; mtime: number }>()
  for (const f of await listFiles()) {
    if (!f.fromIdea) continue
    const key = ideaKey(f.fromIdea)
    const prev = started.get(key)
    if (!prev || f.mtime > prev.mtime) started.set(key, { path: f.path, title: f.title, mtime: f.mtime })
  }
  const ideas = newestFirst(parseIdeas(raw ?? '')).map((idea) => {
    const key = ideaKey(idea.text)
    const s = started.get(key)
    return { ...idea, starred: stars.has(key), ...(s ? { started: { path: s.path, title: s.title } } : {}) }
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
    await fs.mkdir(META_DIR, { recursive: true })
    await atomicWrite(STATE, JSON.stringify({ ...state, starred }, null, 2))
    return { starred: on }
  })
}

/**
 * Start a piece of the given kind from an idea: a new draft filed with that kind, its template's body
 * if the kind has one, and the idea as a faded prompt at the top. `from-idea` in its front matter is
 * how the Ideas page knows it was started.
 */
export async function startIdea(kinds: Kind[], text: string, kindId: string): Promise<string> {
  // The idea exactly as the list keys it, so its row shows Started (a cleaned copy could differ).
  const idea = ideaKey(text)
  if (!idea) throw new HttpError(400, 'No idea to start from')
  const kind = findKind(kinds, kindId)
  if (!kind) throw new HttpError(400, 'Unknown kind of writing')
  const rel = await createDoc(kinds, '', kind.id)
  const { meta, body, raw } = splitFrontMatter(await readDoc(rel))
  let template = ''
  if (kind.template) {
    const tpl = await readDoc(kind.template).catch(() => null)
    if (tpl !== null) template = templateBody(tpl, { date: meta.created ?? '', kind: kindName(kinds, kind.id) })
  }
  const next = [ideaPrompt(idea), template.trim(), body.trim()].filter(Boolean).join('\n\n') + '\n'
  await writeDoc(rel, joinFrontMatter(raw, applyPatch(meta, { 'from-idea': idea }), next), { reason: 'create' })
  return placeDoc(kinds, rel)
}
