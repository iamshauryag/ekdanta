// The assistant's proposals, checked the same way on both sides: the server checks what the model sent
// before the writer sees it, and the page finds each proposal again in the text as it is now before
// showing it as a diff. A proposal only ever replaces text that is really in the draft.
import { diffWordsWithSpace } from 'diff'
import { fold } from './reader.ts'
import { sentenceCount } from './versions.ts'

/** What one ask may carry. The server refuses more (413), the page stops the writer typing more. */
export const MESSAGE_MAX = 4000
export const DOC_MAX = 200_000
export const SELECTION_MAX = 20_000
/** A whole request body, in bytes: the draft at its longest, in any script, and the rest. */
export const BODY_MAX = 1_000_000
export const MAX_PROPOSALS = 8

/** The help levels, as the assistant uses them. 0 is off. */
export const LEVEL_NAMES: Record<number, string> = { 0: 'Off', 1: 'Recall', 2: 'Nudge', 3: 'Word', 4: 'Sentence', 5: 'Passage' }

export interface NoteRef {
  doc: string
  title: string
  folder: string
}

/** A change to the draft: `find` is the draft's own text at [start, end), `replace` what it becomes. */
export interface Proposal {
  id: string
  start: number
  end: number
  find: string
  replace: string
  why?: string
  /** What the writer did with it, once they did. */
  state?: 'accepted' | 'rejected' | 'partly accepted'
}

/** A change the model sent that the writer doesn't see, and why. */
export interface Dropped {
  find: string
  reason: 'not in the draft' | 'overlaps another change' | 'no change' | 'over the help ceiling' | 'the whole piece' | 'too many'
}

export interface Turn {
  id: string
  role: 'writer' | 'assistant'
  text: string
  at: string
  /** Writer: the selected text sent with the ask, if any. */
  selection?: string
  /** Assistant: the help level it answered at. */
  level?: number
  /** Assistant: the writer's notes it drew on, and how many it looked at. */
  notes?: NoteRef[]
  looked?: number
  proposals?: Proposal[]
  dropped?: Dropped[]
  provider?: string
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Did the writer ask, in so many words, for the whole piece to be rewritten? */
export function asksForWhole(message: string): boolean {
  return /\b(whole|entire|full|complete)\s+(piece|post|draft|thing|essay|article|text|email|newsletter|script|story)\b|\ball of it\b|\bfrom scratch\b|\b(rewrite|redo|redraft)\s+(it|this|everything)\b|\beverything\b/i.test(
    message,
  )
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where `find` is in `text`, at or after `from`: exactly, or with quotes and dashes folded, or with
 * any run of spaces and line breaks standing for any other. Returns the text's own span, never the model's.
 */
export function locateFind(text: string, find: string, from = 0): { start: number; end: number } | null {
  if (!find) return null
  let i = text.indexOf(find, from)
  if (i >= 0) return { start: i, end: i + find.length }
  const folded = fold(text)
  i = folded.indexOf(fold(find), from)
  if (i >= 0) return { start: i, end: i + find.length }
  const parts = fold(find).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const re = new RegExp(parts.map(escape).join('\\s+'), 'g')
  re.lastIndex = from
  const m = re.exec(folded)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/** The words a change adds, from a word diff of what it replaces and what it becomes. */
function added(find: string, replace: string) {
  return diffWordsWithSpace(find, replace)
    .filter((p) => p.added)
    .map((p) => p.value)
    .join(' ')
}

/**
 * Does the help level allow this change? Level 3 swaps a word or short phrase; level 4 rewrites or adds
 * at most one sentence, inside one paragraph; level 5 any passage. Below 3 nothing is written at all.
 */
export function levelAllows(level: number, find: string, replace: string): boolean {
  if (level < 3) return false
  if (level >= 5) return true
  if (level === 3) return words(find) <= 4 && words(replace) <= 4 && !/\n/.test(find + replace)
  const more = added(find, replace)
  return !/\n\s*\n/.test(find + replace) && sentenceCount(more) <= 1 && words(more) <= 60
}

export interface CheckOptions {
  level: number
  /** The writer asked for the whole piece (asksForWhole). */
  whole?: boolean
  /** The selection the ask was about, as offsets into the text: a change found inside it wins. */
  selection?: [number, number] | null
}

/**
 * The model's changes, as the writer may see them: each one found in the draft (a phrase that occurs
 * twice is taken at its next unclaimed place, in the selection first), not overlapping another,
 * really a change, within the help level, and not most of the piece unless the writer asked.
 */
export function checkProposals(raw: unknown, text: string, opts: CheckOptions): { proposals: Proposal[]; dropped: Dropped[] } {
  const list = Array.isArray(raw) ? raw : []
  const proposals: Proposal[] = []
  const dropped: Dropped[] = []
  const total = words(text)
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.find !== 'string' || typeof o.replace !== 'string') continue
    const find = o.find
    const replace = o.replace.replace(/\r\n?/g, '\n')
    const label = find.slice(0, 80)
    if (!find.trim()) continue
    if (opts.level < 3 || !levelAllows(opts.level, find, replace)) {
      dropped.push({ find: label, reason: 'over the help ceiling' })
      continue
    }
    const at = place(text, find, proposals, opts.selection ?? null)
    if (!at) {
      dropped.push({ find: label, reason: locateFind(text, find) ? 'overlaps another change' : 'not in the draft' })
      continue
    }
    const own = text.slice(at.start, at.end)
    if (own.trim() === replace.trim()) {
      dropped.push({ find: label, reason: 'no change' })
      continue
    }
    // Most of a piece of any length, replaced at once: only when the writer asked for that.
    if (!opts.whole && total >= 60 && words(own) / total > 0.6) {
      dropped.push({ find: label, reason: 'the whole piece' })
      continue
    }
    if (proposals.length >= MAX_PROPOSALS) {
      dropped.push({ find: label, reason: 'too many' })
      continue
    }
    const why = typeof o.why === 'string' && o.why.trim() ? o.why.trim().slice(0, 300) : undefined
    proposals.push({ id: `p${proposals.length + 1}`, start: at.start, end: at.end, find: own, replace, ...(why ? { why } : {}) })
  }
  proposals.sort((a, b) => a.start - b.start)
  return { proposals, dropped }
}

/** The next place `find` occurs that no earlier change has claimed: inside the selection first, then anywhere. */
function place(text: string, find: string, taken: Proposal[], selection: [number, number] | null) {
  const clashes = (s: number, e: number) => taken.some((p) => s < p.end && e > p.start)
  const scan = (from: number, within?: [number, number]) => {
    for (let at = locateFind(text, find, from); at; at = locateFind(text, find, at.start + 1)) {
      if (within && at.end > within[1]) return null
      if (!clashes(at.start, at.end)) return at
    }
    return null
  }
  return (selection ? scan(selection[0], selection) : null) ?? scan(0)
}

/**
 * Find a proposal again in the text as it is now. Unchanged text keeps its place; otherwise the
 * occurrence nearest where it was. Null when the text it would replace is gone.
 */
export function relocate(text: string, p: Pick<Proposal, 'start' | 'end' | 'find'>): { start: number; end: number } | null {
  if (text.slice(p.start, p.end) === p.find) return { start: p.start, end: p.end }
  let best: { start: number; end: number } | null = null
  for (let at = locateFind(text, p.find, 0); at; at = locateFind(text, p.find, at.start + 1)) {
    if (!best || Math.abs(at.start - p.start) < Math.abs(best.start - p.start)) best = at
  }
  return best
}

/** The span [start, end) of the text with every change applied, for reviewing several at once. Null if two overlap. */
export function applyAll(text: string, changes: { start: number; end: number; replace: string }[]): { start: number; end: number; original: string; result: string } | null {
  const sorted = [...changes].sort((a, b) => a.start - b.start)
  if (!sorted.length) return null
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return null
  const start = sorted[0].start
  const end = Math.max(...sorted.map((c) => c.end))
  let result = ''
  let pos = start
  for (const c of sorted) {
    result += text.slice(pos, c.start) + c.replace
    pos = c.end
  }
  result += text.slice(pos, end)
  return { start, end, original: text.slice(start, end), result }
}
