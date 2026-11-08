// The assistant's proposals, checked the same way on both sides: the server checks what the model sent
// before the writer sees it, and the page finds each proposal again in the text as it is now before
// showing it as a diff. A proposal only ever replaces text that is really in the draft.
import { diffWordsWithSpace } from 'diff'
import { fold } from './reader.ts'
import { checkScope, hunksOf, type Ask } from './scope.ts'

/** What one ask may carry. The server refuses more (413), the page stops the writer typing more. */
export const MESSAGE_MAX = 4000
export const DOC_MAX = 200_000
export const SELECTION_MAX = 20_000
/** A whole request body, in bytes: the draft at its longest, in any script, and the rest. */
export const BODY_MAX = 1_000_000
/**
 * How many proposals one answer may carry. A whole-piece ask ("remove the emojis") comes back as many
 * small changes rather than one big one, so this is generous; the rest wait for the next ask.
 */
export const MAX_PROPOSALS = 40
/** How many of the model's changes are looked at, at most. */
export const MAX_RAW_CHANGES = 80
/** The longest reply, and the longest text one proposal may replace or put in, kept in the chat file. */
export const REPLY_MAX = 8000
export const CHANGE_MAX = 20_000
/** How much of the draft on each side of a proposal is kept, so it is only ever found again at the same spot. */
export const CONTEXT_CHARS = 24

/** The help levels, as the assistant uses them. 0 is off; 6 lets it write whole drafts when asked (opt-in, never the default). */
export const LEVEL_NAMES: Record<number, string> = { 0: 'Off', 1: 'Recall', 2: 'Nudge', 3: 'Word', 4: 'Sentence', 5: 'Passage', 6: 'Whole drafts' }
export const DRAFT_LEVEL = 6

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
  /** The draft's text just before and after it, when it was proposed. */
  before?: string
  after?: string
  /** What the writer did with it, once they did. */
  state?: 'accepted' | 'rejected' | 'partly accepted'
  /** It does more than the writer asked: what, in plain words. Left out of "Accept all". */
  beyond?: string
  /** The same change with only the asked-for part, when there is one. */
  narrow?: string
}

/** A change the model sent that the writer doesn't see, and why. */
export interface Dropped {
  find: string
  /** 'the whole piece' is no longer given; older chat files may still hold it. */
  reason: 'not in the draft' | 'not unique' | 'overlaps another change' | 'no change' | 'over the help ceiling' | 'the whole piece' | 'too many' | 'too long'
}

export interface Turn {
  id: string
  role: 'writer' | 'assistant'
  text: string
  at: string
  /** Writer: the selected text sent with the ask, if any, and where it started in the draft. */
  selection?: string
  selectionStart?: number
  /** Assistant: the help level it answered at. */
  level?: number
  /** Assistant: the writer's notes it drew on, and how many it looked at. */
  notes?: NoteRef[]
  looked?: number
  proposals?: Proposal[]
  dropped?: Dropped[]
  provider?: string
  /** Assistant: this answer is a one-time re-ask at level 5 of the turn with this id. */
  allowOnceFor?: string
  /** Assistant: its Allow once has been used. */
  allowSpent?: boolean
  /** Assistant: the help level the ask needed, when that is above the level it was answered at. */
  needs?: number
  /** Assistant: its proposal is a whole draft written by AI (level 6). */
  drafted?: boolean
  /** Assistant: plain notes from the app (not the model) about this answer: what was held back and why. */
  notices?: string[]
  /** Assistant: a draft written without a voice profile for the platform (the tab offers to build one). */
  noVoice?: boolean
  /** Assistant: it asked what a draft should be about; the writer's next message answers that. */
  awaitingTopic?: boolean
}

// Word and sentence counts that work for every script, including those written without spaces
// (Chinese, Japanese, Thai): a whole paragraph of those is one "word" to a split on spaces.
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

export function words(s: string): number {
  if (!segmenter) return s.split(/\s+/).filter(Boolean).length
  let n = 0
  for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++
  return n
}

/** Sentences, ended by Western or CJK stops, with or without a space after. */
export function sentences(s: string): number {
  return s
    .trim()
    .split(/[.!?…。！？]+["'”’)」』]*\s*/u)
    .filter((x) => /[\p{L}\p{N}]/u.test(x)).length
}

/**
 * Did the writer ask, in so many words, for the whole piece to be rewritten? A rewriting verb and a
 * whole-piece word, both, and nothing that limits or negates it ("don't…", "keep everything else",
 * "except…"). When unsure the answer is no, so the whole-piece guard stays on.
 */
export function asksForWhole(message: string): boolean {
  const verb = /\b(re-?write|redo|re-?draft|rework|restructure|start over|from scratch)\b/i
  const whole = /\b(whole|entire|everything|all of it|full (piece|post|draft|essay|article|text|email|newsletter|script|story)|from scratch|top to bottom)\b/i
  const limits = /\b(don['’]?t|do not|doesn['’]?t|not|never|no|without|keep|leave|except|apart from|other than|rest of|the rest)\b|\b(everything|all) else\b|n['’]t\b/i
  return verb.test(message) && whole.test(message) && !limits.test(message)
}

/**
 * Did the writer ask for the whole piece to be written for them? "Draft it for me", "write the post",
 * "write a first draft of this". Strict on purpose: "write a better opening" is not it.
 */
export function asksForDraft(message: string): boolean {
  const m = message.normalize('NFC')
  const nouns = '(post|piece|draft|essay|article|newsletter|script|email|thread|story|blog(?: post)?|thing|version|tweet)'
  const strict = new RegExp(`\\b(write|draft|ghostwrite)\\s+(me\\s+)?(the|a|this|my|it\\s+as\\s+a)\\s+(whole\\s+|full\\s+|first\\s+|complete\\s+|new\\s+)?${nouns}\\b`, 'i')
  const forMe = /\b(write|draft)\s+(it|this|one)(\s+out)?\s+for\s+me\b|^\s*(please\s+)?draft\s+(it|this)(\s+for\s+me)?\s*[.!]?\s*$|\bwrite\s+(it|this)\s+(all\s+)?(out|up)\b/i
  const limits = /\b(don['’]?t|do not|never|not)\b/i
  return (strict.test(m) || forMe.test(m)) && !limits.test(m)
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

/** Every place `find` occurs, not overlapping. */
export function locateAll(text: string, find: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (let at = locateFind(text, find, 0); at; at = locateFind(text, find, Math.max(at.end, at.start + 1))) out.push(at)
  return out
}

/** The words a change adds and the words it takes out, from a word diff of what it replaces and what it becomes. */
function changed(find: string, replace: string) {
  const parts = diffWordsWithSpace(find, replace)
  const join = (keep: (p: (typeof parts)[number]) => boolean | undefined) =>
    parts
      .filter(keep)
      .map((p) => p.value)
      .join(' ')
  return { added: join((p) => p.added), removed: join((p) => p.removed) }
}

/** At most one sentence, of a bounded length. */
const oneSentence = (t: string) => sentences(t) <= 1 && words(t) <= 60 && t.length <= 400

/**
 * Does the help level allow this change? `find` is the draft's own text. Level 3 swaps a word or short
 * phrase; level 4 rewrites, adds or removes at most one sentence, inside one line; level 5 any passage. Below 3
 * nothing is written at all. Characters are capped beside words, for scripts whose words are long.
 */
export function levelAllows(level: number, find: string, replace: string): boolean {
  if (level < 3) return false
  if (level >= 5) return true
  if (level === 3) return words(find) <= 4 && words(replace) <= 4 && find.length <= 40 && replace.length <= 40 && !/\n/.test(find + replace)
  // Level 4 bounds both sides: what goes in, and what comes out (rewriting or deleting ten sentences is not "a sentence").
  const { added, removed } = changed(find, replace)
  return !/\n/.test(find) && !/\n\s*\n/.test(replace) && oneSentence(added) && oneSentence(removed)
}

export interface CheckOptions {
  level: number
  /** The selection the ask was about, as offsets into the text: an ambiguous phrase is taken there. */
  selection?: [number, number] | null
  /** What the writer asked for (scope.ts readAsk): changes that go beyond it are flagged. */
  ask?: Ask
}

/** Unchanged text this long (with a letter or digit in it) between two changed places makes them separate changes. */
const SPLIT_GAP = 12

/**
 * One change from the model, cut down to the places it really changes. "find" may be a whole paragraph
 * where one emoji goes; what comes back is that emoji alone, so the writer reviews exactly what changes and
 * everything else stays as written. Changed places close together stay one change; a change that rewrites
 * most of its text stays whole (a rewrite reads better as one).
 */
export function minimalChanges(own: string, replace: string, quoted = own): { start: number; end: number; replace: string }[] {
  const hunks = hunksOf(own, replace)
  const spots: { start: number; end: number; replace: string; gap: string }[] = []
  // Where the model quoted the draft with its spacing, quotes or dashes tidied, a difference only in those
  // is the model's copying, not a change it meant: the writer's own characters stay.
  const sameish = (a: string, b: string) => fold(a).replace(/\s+/g, ' ') === fold(b).replace(/\s+/g, ' ')
  // Only when the model's own quote-to-replacement diff has no such difference: then it meant none.
  const copying = quoted !== own && !hunksOf(quoted, replace).some((h) => (h.del || h.ins) && sameish(h.del, h.ins))
  let pos = 0
  let gap = ''
  for (const h of hunks) {
    pos += h.eq.length
    gap += h.eq
    if (h.del || h.ins) {
      if (copying && sameish(h.del, h.ins)) gap += h.del
      else {
        // A space both sides end or start with isn't part of the change.
        let del = h.del
        let ins = h.ins
        let lead = 0
        while (lead < del.length && lead < ins.length && del[lead] === ins[lead] && /\s/.test(del[lead])) lead++
        del = del.slice(lead)
        ins = ins.slice(lead)
        let tail = 0
        while (tail < del.length && tail < ins.length && del[del.length - 1 - tail] === ins[ins.length - 1 - tail] && /\s/.test(del[del.length - 1 - tail])) tail++
        spots.push({ start: pos + lead, end: pos + h.del.length - tail, replace: ins.slice(0, ins.length - tail), gap: gap + h.del.slice(0, lead) })
        gap = h.del.slice(h.del.length - tail)
      }
    }
    pos += h.del.length
  }
  if (!spots.length) return []
  const changedChars = spots.reduce((n, x) => n + Math.max(x.end - x.start, x.replace.length), 0)
  // Merged spots keep the writer's own text between them.
  const merge = (list: typeof spots) => {
    let start = list[0].start
    let end = list[list.length - 1].end
    let rep = list.map((x, i) => (i ? own.slice(list[i - 1].end, x.start) : '') + x.replace).join('')
    // Spaces both sides start or end with aren't part of the change.
    while (start < end && rep && own[start] === rep[0] && /\s/.test(rep[0])) (start++, (rep = rep.slice(1)))
    while (start < end && rep && own[end - 1] === rep[rep.length - 1] && /\s/.test(rep[rep.length - 1])) (end--, (rep = rep.slice(0, -1)))
    return { start, end, replace: rep }
  }
  if (changedChars > own.length * 0.5) return [merge(spots)]
  const groups: (typeof spots)[] = []
  for (const x of spots) {
    const last = groups[groups.length - 1]
    if (last && (x.gap.length < SPLIT_GAP || !/[\p{L}\p{N}]/u.test(x.gap))) last.push(x)
    else groups.push([x])
  }
  return groups.map(merge)
}

/**
 * The model's changes, as the writer may see them: each one found in the draft at exactly one place
 * (or one place inside the selection), cut down to what it really changes, each piece within the help
 * level, not overlapping another and really a change. Pieces that go beyond the ask are kept and flagged.
 */
export function checkProposals(raw: unknown, text: string, opts: CheckOptions): { proposals: Proposal[]; dropped: Dropped[] } {
  // A model that sends a flood of changes gets the first ones looked at, not all of them.
  const list = Array.isArray(raw) ? raw.slice(0, MAX_RAW_CHANGES) : []
  const proposals: Proposal[] = []
  const dropped: Dropped[] = []
  const sel = opts.selection ?? null
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.find !== 'string' || typeof o.replace !== 'string') continue
    const find = o.find
    const replace = o.replace.replace(/\r\n?/g, '\n')
    const drop = (reason: Dropped['reason'], what = find) => dropped.push({ find: what.slice(0, 80), reason })
    if (!find.trim()) continue
    if (find.length > CHANGE_MAX || replace.length > CHANGE_MAX) {
      drop('too long')
      continue
    }
    if (opts.level < 3) {
      drop('over the help ceiling')
      continue
    }
    const all = locateAll(text, find)
    if (!all.length) {
      drop('not in the draft')
      continue
    }
    // A phrase that occurs more than once is only taken where the writer pointed: in the selection.
    const inSel = sel ? all.filter((a) => a.start >= sel[0] && a.end <= sel[1]) : []
    const at = all.length === 1 ? all[0] : inSel.length === 1 ? inSel[0] : null
    if (!at) {
      drop('not unique')
      continue
    }
    const own = text.slice(at.start, at.end)
    if (own.trim() === replace.trim()) {
      drop('no change')
      continue
    }
    const why = typeof o.why === 'string' && o.why.trim() ? o.why.trim().slice(0, 300) : undefined
    for (const piece of minimalChanges(own, replace, find)) {
      const start = at.start + piece.start
      const end = at.start + piece.end
      const part = text.slice(start, end)
      if (proposals.some((p) => start < p.end && end > p.start)) {
        drop('overlaps another change', part || own)
        continue
      }
      // The level is checked on each piece of the draft's own text, which may differ from what the model quoted.
      if (!levelAllows(opts.level, part, piece.replace)) {
        drop('over the help ceiling', part || own)
        continue
      }
      if (proposals.length >= MAX_PROPOSALS) {
        drop('too many', part || own)
        continue
      }
      const flag = opts.ask ? checkScope(opts.ask, part, piece.replace) : null
      const outside = sel && (start < sel[0] || end > sel[1]) && !flag ? 'Outside the part you selected.' : undefined
      proposals.push({
        id: '',
        start,
        end,
        find: part,
        replace: piece.replace,
        before: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
        after: text.slice(end, end + CONTEXT_CHARS),
        ...(why ? { why } : {}),
        ...(flag ? { beyond: flag.note, ...(flag.narrow !== undefined ? { narrow: flag.narrow } : {}) } : outside ? { beyond: outside } : {}),
      })
    }
  }
  proposals.sort((a, b) => a.start - b.start)
  proposals.forEach((p, i) => (p.id = `p${i + 1}`))
  return { proposals, dropped }
}

/**
 * Find a proposal again in the text as it is now, only at the same spot: where it was, or where the
 * text around it still matches what was around it then. Null when that can't be told (the phrase is
 * gone, or it now reads the same in more than one place): the page then says it has changed.
 */
export function relocate(text: string, p: Pick<Proposal, 'start' | 'end' | 'find' | 'before' | 'after'>): { start: number; end: number } | null {
  const fits = (at: { start: number; end: number }, n: number) => {
    const b = (p.before ?? '').slice(-n)
    const a = (p.after ?? '').slice(0, n)
    return text.slice(Math.max(0, at.start - b.length), at.start) === b && text.slice(at.end, at.end + a.length) === a
  }
  const here = { start: p.start, end: p.end }
  if (text.slice(p.start, p.end) === p.find && fits(here, 8)) return here
  const all = locateAll(text, p.find)
  if (p.before === undefined && p.after === undefined) return all.length === 1 ? all[0] : null
  for (const n of [CONTEXT_CHARS, 8]) {
    const same = all.filter((at) => fits(at, n))
    if (same.length === 1) return same[0]
    if (same.length > 1) return null
  }
  return null
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
