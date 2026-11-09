// The assistant's proposals, checked the same way on both sides: the server checks what the model sent
// before the writer sees it, and the page finds each proposal again in the text as it is now before
// showing it as a diff. A proposal only ever replaces text that is really in the draft.
import { diffChars, diffWordsWithSpace } from 'diff'
import { fold } from './reader.ts'
import { checkScope, hunksOf, type Ask } from './scope.ts'
import { BLOCK_KINDS, INLINE_KINDS, formats, kindsOf, plainOf, safeMarkdown } from './rich.ts'

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
  /**
   * `replace` is Markdown that formats the text (bold, a heading, a list): the page applies it as formatting,
   * never as stars. Such a change covers whole paragraphs. `narrow`, when there is one, is plain text.
   */
  format?: boolean
}

/** A change the model sent that the writer doesn't see, and why. */
export interface Dropped {
  find: string
  /** 'the whole piece' is no longer given; older chat files may still hold it. */
  reason: 'not in the draft' | 'not unique' | 'overlaps another change' | 'no change' | 'over the help ceiling' | 'the whole piece' | 'too many' | 'too long' | 'formatting it can’t add'
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

/** Parts of a piece: asking to write one of these is asking for a part, never the whole. */
const PART =
  /\b(subject(\s+line)?|title|headline|heading|ending|end|conclusion|hook|opener|opening|intro(duction)?|outro|closing|paragraph|sentence|line|caption|cta|call to action|summary|tl;?dr|bio|excerpt|tagline|section|bullet|reply|response|comment|bit|part)s?\b/i
const WHOLE = /\b(whole|full|entire|complete|from scratch|first draft|new draft|all of it)\b/i

/**
 * Did the writer ask for the whole piece to be written for them? "Draft it for me", "write the post for
 * me", "write a first draft of this". Strict on purpose: the piece's noun must end the ask (or be followed
 * only by "for me", "about…", "on…", "from my notes", "in my voice"), and a part ("write the post title",
 * "a draft of the closing paragraph") is never it. On a page that already has text, the ask must also say
 * whole, full or first draft; the "Draft it for me" button needs no words.
 */
export function asksForDraft(message: string, opts: { pageEmpty?: boolean } = {}): boolean {
  const m = message.normalize('NFC').trim()
  if (/\b(don['’]?t|do not|never|not)\b/i.test(m)) return false
  const nouns = '(post|piece|draft|essay|article|newsletter|script|email|thread|story|blog(?:\\s+post)?|thing|version|tweet)'
  const end = String.raw`(?=\s*$|\s*[.!?,;:]|\s+(?:for\s+me|about|on|around|from\s+(?:my|these|the)\s+notes|in\s+my\s+(?:own\s+)?voice|based\s+on|using\s+my|of\s+(?:this|it|the\s+piece|my\s+notes))\b)`
  const strict = new RegExp(String.raw`\b(?:write|draft|ghostwrite)\s+(?:me\s+)?(?:the|a|an|this|my|it\s+as\s+an?)\s+(?:[\p{L}\p{N}'’-]+\s+){0,2}${nouns}${end}`, 'iu')
  const forMe = /\b(write|draft)\s+(it|this|one)(\s+out)?\s+for\s+me\b|^(please\s+)?draft\s+(it|this)(\s+for\s+me)?\s*[.!]?$|\bwrite\s+(it|this)\s+(all\s+)?(out|up)(\s+for\s+me)?\s*[.!]?$/i
  const hit = strict.exec(m)
  const asked = Boolean(hit) || forMe.test(m)
  if (!asked) return false
  // A part named after the piece's noun ("the post title", "the story ending") is a part.
  const after = hit ? m.slice(hit.index + hit[0].length) : m
  if (PART.test(after.split(/\b(?:about|on|around|based on)\b/i)[0])) return false
  // Up to two words may describe the piece ("a short LinkedIn post", "an X thread"), but never a part.
  if (hit && PART.test(hit[0])) return false
  return opts.pageEmpty !== false || WHOLE.test(m)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where `find` is in `text`, at or after `from`: exactly, or with quotes and dashes folded, or with
 * any run of spaces and line breaks standing for any other. Returns the text's own span, never the model's.
 */
export function locateFind(text: string, find: string, from = 0): { start: number; end: number } | null {
  return scan(text, find, from, mode(text, find))
}

type Mode = 'exact' | 'folded' | 'spacing' | null

/** Which way `find` is in `text` at all: as written, with quotes and dashes folded, or with spacing loosened too. */
function mode(text: string, find: string): Mode {
  if (!find) return null
  if (text.includes(find)) return 'exact'
  if (fold(text).includes(fold(find))) return 'folded'
  return scan(text, find, 0, 'spacing') ? 'spacing' : null
}

/** A text with every run of spaces and line breaks made one space, and where each character came from. No regex, so a long change can't overflow it. */
function collapse(s: string) {
  let out = ''
  const at: number[] = []
  let space = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ' || /\s/.test(c)) {
      if (!space) {
        out += ' '
        at.push(i)
      }
      space = true
    } else {
      out += c
      at.push(i)
      space = false
    }
  }
  return { out, at }
}

function scan(text: string, find: string, from: number, how: Mode): { start: number; end: number } | null {
  if (!find || !how) return null
  if (how === 'exact') {
    const i = text.indexOf(find, from)
    return i >= 0 ? { start: i, end: i + find.length } : null
  }
  const folded = fold(text)
  if (how === 'folded') {
    const i = folded.indexOf(fold(find), from)
    return i >= 0 ? { start: i, end: i + find.length } : null
  }
  const needle = collapse(fold(find).trim()).out
  if (!needle) return null
  const hay = collapse(folded)
  let k = 0
  while (k < hay.at.length && hay.at[k] < from) k++
  const i = hay.out.indexOf(needle, k)
  return i >= 0 ? { start: hay.at[i], end: hay.at[i + needle.length - 1] + 1 } : null
}

/** Every place `find` occurs, not overlapping, all found the same way: once it is there as written, only those places count. */
export function locateAll(text: string, find: string): { start: number; end: number }[] {
  const how = mode(text, find)
  const out: { start: number; end: number }[] = []
  for (let at = scan(text, find, 0, how); at; at = scan(text, find, Math.max(at.end, at.start + 1), how)) out.push(at)
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

interface Piece {
  start: number
  end: number
  replace: string
  why?: string
  format?: boolean
}

/** The paragraph, heading or list item (or run of them) that holds [start, end) of the page's text, where blocks are separated by a blank line. */
function blocksAround(text: string, start: number, end: number) {
  const before = start >= 2 ? text.lastIndexOf('\n\n', start - 2) : -1
  const after = text.indexOf('\n\n', end)
  return { start: before < 0 ? 0 : before + 2, end: after < 0 ? text.length : after }
}

/**
 * Changes that format the text, kept whole. The model writes formatting in Markdown, and cutting a change down
 * to what it changes would split "**a phrase**" into two changes of "**" each, which mean nothing alone. So
 * the changes in each paragraph (heading, list item) are put back together, and where together they format
 * it, they become one change of the whole paragraph, marked `format`. Other changes are left as they are.
 */
export function formatting(text: string, pieces: Piece[]): Piece[] {
  const sorted = [...pieces].sort((a, b) => a.start - b.start)
  const groups: { start: number; end: number; pieces: Piece[] }[] = []
  for (const p of sorted) {
    const b = blocksAround(text, p.start, p.end)
    const last = groups[groups.length - 1]
    if (last && b.start < last.end) {
      last.end = Math.max(last.end, b.end)
      last.pieces.push(p)
    } else groups.push({ ...b, pieces: [p] })
  }
  const out: Piece[] = []
  for (const g of groups) {
    let replace = ''
    let pos = g.start
    for (const p of g.pieces) {
      replace += text.slice(pos, p.start) + p.replace
      pos = p.end
    }
    replace += text.slice(pos, g.end)
    const find = text.slice(g.start, g.end)
    if (formats(find, replace)) out.push({ start: g.start, end: g.end, replace, why: g.pieces.find((p) => p.why)?.why, format: true })
    else out.push(...g.pieces)
  }
  return out
}

/**
 * Why a formatting change can't be offered, or null when it can. It may carry inline marks (bold, italics,
 * links, code, strikethrough), and headings or lists only when the writer asked for them; never images, raw
 * HTML, rules, tables, quotes or code blocks. What it does to the words is held to the help level paragraph
 * by paragraph, and adding, removing, splitting or joining paragraphs needs level 5.
 */
export function formatProblem(find: string, replace: string, level: number, ask?: Pick<Ask, 'formatting'>): Dropped['reason'] | null {
  if (level < 3) return 'over the help ceiling'
  const safe = safeMarkdown(find, replace)
  for (const kind of kindsOf(safe)) {
    if (INLINE_KINDS.has(kind)) continue
    if (BLOCK_KINDS.has(kind) && ask?.formatting === 'all') continue
    return 'formatting it can’t add'
  }
  const was = find.split('\n\n')
  const now = plainOf(safe).split('\n\n')
  if (was.length !== now.length) return level >= 5 ? null : 'over the help ceiling'
  return was.every((w, i) => w === now[i] || levelAllows(level, w, now[i])) ? null : 'over the help ceiling'
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
  /** Each change cut down to what it changes, found in the draft, before the level and the ask are checked. */
  const pieces: Piece[] = []
  // The piece's own words, for telling a typo from a word the writer meant (built once, when needed).
  let vocab: Set<string> | undefined
  const vocabulary = () => (vocab ??= new Set(text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? []))
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.find !== 'string' || typeof o.replace !== 'string') continue
    // One change that can't be checked (too big to diff, say) is left out; it never sinks the others.
    try {
      checkOne(o as { find: string; replace: string; why?: unknown })
    } catch {
      dropped.push({ find: o.find.slice(0, 80), reason: 'too long' })
    }
  }
  function checkOne(o: { find: string; replace: string; why?: unknown }) {
    const find = o.find
    const replace = o.replace.replace(/\r\n?/g, '\n')
    const drop = (reason: Dropped['reason'], what = find) => dropped.push({ find: what.slice(0, 80), reason })
    if (!find.trim()) return
    if (find.length > CHANGE_MAX || replace.length > CHANGE_MAX) {
      drop('too long')
      return
    }
    if (opts.level < 3) {
      drop('over the help ceiling')
      return
    }
    const all = locateAll(text, find)
    if (!all.length) {
      drop('not in the draft')
      return
    }
    // A phrase that occurs more than once is only taken where the writer pointed: in the selection.
    const inSel = sel ? all.filter((a) => a.start >= sel[0] && a.end <= sel[1]) : []
    const at = all.length === 1 ? all[0] : inSel.length === 1 ? inSel[0] : null
    if (!at) {
      drop('not unique')
      return
    }
    const own = text.slice(at.start, at.end)
    if (own.trim() === replace.trim()) {
      drop('no change')
      return
    }
    const why = typeof o.why === 'string' && o.why.trim() ? o.why.trim().slice(0, 300) : undefined
    for (const piece of minimalChanges(own, replace, find)) {
      const start = at.start + piece.start
      const end = at.start + piece.end
      if (pieces.some((p) => start < p.end && end > p.start)) {
        drop('overlaps another change', text.slice(start, end) || own)
        continue
      }
      pieces.push({ start, end, replace: piece.replace, why })
    }
  }
  // Formatting written in Markdown is reviewed and applied whole, a paragraph at a time: "**" on each side of a phrase is one change.
  for (const c of formatting(text, pieces)) {
    const part = text.slice(c.start, c.end)
    // What the change does to the words, as the page will show them: formatting alone changes none.
    const shown = c.format ? plainOf(safeMarkdown(part, c.replace)) : c.replace
    const problem = c.format ? formatProblem(part, c.replace, opts.level, opts.ask) : levelAllows(opts.level, part, shown) ? null : 'over the help ceiling'
    if (problem) {
      dropped.push({ find: (part || c.replace).slice(0, 80), reason: problem })
      continue
    }
    if (proposals.length >= MAX_PROPOSALS) {
      dropped.push({ find: (part || c.replace).slice(0, 80), reason: 'too many' })
      continue
    }
    const flag = opts.ask ? checkScope({ ...opts.ask, vocabulary: vocabulary() }, part, shown) : null
    // Formatting the writer didn't ask for ("tighten the intro", "remove the emojis") goes beyond the ask, and
    // taking only what was asked leaves the formatting out.
    const fmtBeyond = c.format && !opts.ask?.formatting
    const narrow = flag?.narrow ?? (fmtBeyond && shown !== part ? shown : undefined)
    const outside = !!sel && (c.start < sel[0] || c.end > sel[1])
    // Both notes when both hold. "Only what you asked" is never offered outside the selection.
    const beyond = [flag?.note, fmtBeyond ? 'Changes the formatting too, which you didn’t ask for.' : '', outside ? 'Outside the part you selected.' : ''].filter(Boolean).join(' ')
    proposals.push({
      id: '',
      start: c.start,
      end: c.end,
      find: part,
      replace: c.replace,
      before: text.slice(Math.max(0, c.start - CONTEXT_CHARS), c.start),
      after: text.slice(c.end, c.end + CONTEXT_CHARS),
      ...(c.why ? { why: c.why } : {}),
      ...(c.format ? { format: true } : {}),
      ...(beyond ? { beyond } : {}),
      ...(narrow !== undefined && !outside ? { narrow } : {}),
    })
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
  // Text put in where there was none is found by what was around it: the place both sides of it still meet.
  if (!p.find) {
    for (const n of [CONTEXT_CHARS, 8]) {
      const b = (p.before ?? '').slice(-n)
      const a = (p.after ?? '').slice(0, n)
      if (!b && !a) return null
      const at: number[] = []
      for (let i = text.indexOf(b + a); i >= 0 && at.length < 2; i = text.indexOf(b + a, i + 1)) at.push(i + b.length)
      if (at.length === 1) return { start: at[0], end: at[0] }
      if (at.length > 1) return null
    }
    return null
  }
  const all = locateAll(text, p.find)
  if (p.before === undefined && p.after === undefined) return all.length === 1 ? all[0] : null
  for (const n of [CONTEXT_CHARS, 8]) {
    const same = all.filter((at) => fits(at, n))
    if (same.length === 1) return same[0]
    if (same.length > 1) return null
  }
  // The writer edited right next to it, on one side: text that is only here, still met on the other side by
  // what was there, is the same spot.
  if (all.length === 1) {
    const at = all[0]
    const b = (p.before ?? '').slice(-8)
    const a = (p.after ?? '').slice(0, 8)
    // An empty side (it was at the page's start or end) counts only where it still is at the start or end.
    const before = b ? text.slice(Math.max(0, at.start - b.length), at.start) === b : p.before === '' && at.start === 0
    const after = a ? text.slice(at.end, at.end + a.length) === a : p.after === '' && at.end === text.length
    if (before || after) return at
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

/**
 * Proposals still waiting, moved to where their text is now after the page changed from `old` to `now` (the
 * writer accepted one of their neighbours, say). Positions are carried through the change, and the text
 * around each is read again, so a proposal right next to one just accepted, or one that only puts text in,
 * is still found at its place. One whose own text changed is left as it was: it no longer fits, and the page
 * says so when it is tried.
 */
export function rebase<T extends Pick<Proposal, 'start' | 'end' | 'find' | 'before' | 'after'>>(old: string, now: string, list: T[]): T[] {
  if (old === now || !list.length) return list
  let pre = 0
  while (pre < old.length && pre < now.length && old[pre] === now[pre]) pre++
  let suf = 0
  while (suf < old.length - pre && suf < now.length - pre && old[old.length - 1 - suf] === now[now.length - 1 - suf]) suf++
  const parts = diffChars(old.slice(pre, old.length - suf), now.slice(pre, now.length - suf))
  /** Where an offset in `old` is in `now`; after text put in right there (`after`), or before it. Null inside text taken out. */
  const map = (pos: number, after: boolean): number | null => {
    if (pos < pre || (pos === pre && !after)) return pos
    if (pos > old.length - suf || (pos === old.length - suf && after)) return pos + now.length - old.length
    let o = pre
    let n = pre
    for (const part of parts) {
      const len = part.value.length
      if (part.added) {
        if (o === pos && !after) return n
        n += len
      } else if (part.removed) {
        if (pos > o && pos < o + len) return null
        if (pos === o) return n
        o += len
      } else {
        if (pos < o + len || (pos === o + len && !after)) return n + (pos - o)
        o += len
        n += len
      }
    }
    return n
  }
  return list.map((p) => {
    const start = map(p.start, true)
    const end = p.end === p.start ? start : map(p.end, false)
    if (start === null || end === null || end < start || now.slice(start, end) !== p.find) return p
    return { ...p, start, end, before: now.slice(Math.max(0, start - CONTEXT_CHARS), start), after: now.slice(end, end + CONTEXT_CHARS) }
  })
}
