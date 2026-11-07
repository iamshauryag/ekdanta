// "Read as…": the questions a real reader would ask of a draft. Shared by the server (prompt and checks)
// and the app (who the reader is, how long a draft may be, where a quoted phrase sits now).
// No DOM here, so it can be tested on its own.

export type ReaderPreset = 'teacher' | 'manager' | 'investor' | 'newcomer'
export type ReaderId = ReaderPreset | 'other'

export interface Reader {
  id: ReaderId
  /** For 'other': the writer's own description, e.g. "a client I've never met". */
  who?: string
}

export interface ReaderQuestion {
  quote: string
  question: string
}

export const READERS: { id: ReaderPreset; label: string; brief: string }[] = [
  { id: 'teacher', label: 'Teacher', brief: 'a teacher marking this, who looks for the argument, the evidence, and whether the question set is actually answered' },
  { id: 'manager', label: 'Manager', brief: 'a busy manager reading between meetings, who wants to know what is being asked of them and may hear a blunt line as curt' },
  { id: 'investor', label: 'Investor', brief: 'an investor deciding whether to take a meeting, who asks why this, why now, why you, and where the numbers are' },
  { id: 'newcomer', label: 'Newcomer', brief: 'a newcomer with no background in the subject, who gets lost at jargon, acronyms and skipped steps' },
]

export const MIN_WORDS = 8
export const MAX_WORDS = 6000
/** The most of a free-text reader description that reaches the model. */
export const WHO_MAX = 120
export const MIN_ITEMS = 3
export const MAX_ITEMS = 6
/** Questions may run a little longer than a Nudge (20 words), since they quote a passage. */
export const QUESTION_MAX_WORDS = 30
const QUOTE_MAX_CHARS = 200

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/** Why this text can't be read yet, or null if it can. */
export function lengthProblem(text: string, selection = false): string | null {
  const n = countWords(text)
  if (n < MIN_WORDS) return selection ? 'Select a little more to read as someone' : 'Too short to read as someone yet'
  if (n > MAX_WORDS) return `${selection ? 'That selection' : 'This piece'} is ${n.toLocaleString('en-US')} words. Select a section of up to ${MAX_WORDS.toLocaleString('en-US')} words and try again.`
  return null
}

/** A free-text reader as it may reach the prompt: one line, trimmed, capped. */
export const cleanWho = (who: string | undefined) =>
  (who ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["“”«»`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WHO_MAX)

/** A short name for the reader, for buttons and status lines. */
export function readerLabel(r: Reader): string {
  if (r.id === 'other') return cleanWho(r.who) || 'someone else'
  return READERS.find((p) => p.id === r.id)?.label ?? 'a reader'
}

/** Who the model reads as, in a sentence. Null when the reader can't be used (an empty 'Someone else'). */
export function readerBrief(r: Reader): string | null {
  if (r.id === 'other') {
    const who = cleanWho(r.who)
    return who ? who : null
  }
  return READERS.find((p) => p.id === r.id)?.brief ?? null
}

export const isReaderId = (id: unknown): id is ReaderId => id === 'other' || READERS.some((p) => p.id === id)

// ---- Finding a quoted phrase in the text ------------------------------------------------------

/** Typographic quotes and dashes the model may straighten (or curl). Each maps one character to one, so indexes line up. */
const FOLD: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', ' ': ' ' }
export const fold = (s: string) => s.replace(/[‘’‚‛“”„–— ]/g, (c) => FOLD[c])

/**
 * Where `quote` sits in `text` (exactly, or with quotes and dashes folded), as the text's own slice.
 * With `near`, the occurrence at or after that index wins, so a phrase read in a selection is found there.
 */
export function locate(text: string, quote: string, near = 0): { index: number; quote: string } | null {
  if (!quote) return null
  const find = (t: string, q: string) => {
    const after = near > 0 ? t.indexOf(q, near) : -1
    return after >= 0 ? after : t.indexOf(q)
  }
  let i = find(text, quote)
  if (i < 0) i = find(fold(text), fold(quote))
  return i < 0 ? null : { index: i, quote: text.slice(i, i + quote.length) }
}

// ---- Checking what the model sent back ----------------------------------------------------------

/** Fields that mean the model proposed wording. An item carrying one is dropped, not trimmed. */
const REWRITE_FIELDS = /^(rewrite|rewritten|revision|revised|suggestion|suggested|replacement|replace|alternative|fix|edit|improved|better|instead)/i
const QUESTION_END = /[?？؟\u037e]\s*$/ // with the full-width, Arabic and Greek question marks
const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** The questions worth showing: anchored to an exact phrase, phrased as a question, short, and never proposing new wording. */
export function checkQuestions(raw: unknown, text: string): ReaderQuestion[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (Object.values(raw).find(Array.isArray) ?? []) : []
  const out: ReaderQuestion[] = []
  const seen = new Set<string>()
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    if (Object.keys(o).some((k) => REWRITE_FIELDS.test(k))) continue
    if (typeof o.quote !== 'string' || typeof o.question !== 'string') continue
    const q = o.quote.trim().replace(/^["“”'‘’«]+|["“”'‘’»]+$/g, '')
    const question = o.question.replace(/\s+/g, ' ').trim()
    if (q.length < 2 || q.length > QUOTE_MAX_CHARS || /\n/.test(q)) continue
    const hit = locate(text, q)
    if (!hit) continue
    if (!isReaderQuestion(question, text)) continue
    const key = fold(hit.quote).toLowerCase() + '\u0000' + question.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ quote: hit.quote, question })
    if (out.length === MAX_ITEMS) break
  }
  return out
}

/** One question a reader would ask: ends with a question mark, at most 30 words, and doesn't smuggle in new wording. */
export function isReaderQuestion(q: string, text = ''): boolean {
  if (!q || !QUESTION_END.test(q)) return false
  if (words(q) > QUESTION_MAX_WORDS) return false
  // Two sentences at most ("I lost the thread here. Who is 'she'?"); more is commentary.
  if (q.split(/(?<=[.!?？؟\u037e])\s+/).filter(Boolean).length > 2) return false
  if (/^\s*(rewrite|rephrase|change|replace|try|consider|cut|delete|remove|add|use)\b/i.test(q)) return false
  // A quoted phrase that isn't in the draft is wording being proposed ("Why not say 'we grew fast' instead?").
  for (const m of q.matchAll(/["“«]([^"”»]+)["”»]|(?:^|[\s(])['‘]([^'’]+)['’](?=[\s,.?!;:)]|$)/g)) {
    const phrase = (m[1] ?? m[2] ?? '').trim()
    if (words(phrase) >= 3 && !locate(text, phrase)) return false
  }
  return true
}

// ---- Remembering the last reader, per kind -------------------------------------------------------

const storeKey = (kind: string) => `ekdanta.readAs.${kind || 'essay'}`

/** The reader last chosen for this kind of writing, or Teacher. Storage may be missing or blocked. */
export function lastReader(storage: Pick<Storage, 'getItem'> | undefined, kind: string): Reader {
  try {
    const v = JSON.parse(storage?.getItem(storeKey(kind)) ?? 'null') as Reader | null
    if (v && isReaderId(v.id)) return v.id === 'other' ? { id: 'other', who: typeof v.who === 'string' ? v.who.slice(0, WHO_MAX) : '' } : { id: v.id }
  } catch {
    /* no storage, or something else in it */
  }
  return { id: 'teacher' }
}

export function rememberReader(storage: Pick<Storage, 'setItem'> | undefined, kind: string, r: Reader) {
  try {
    storage?.setItem(storeKey(kind), JSON.stringify(r.id === 'other' ? { id: 'other', who: (r.who ?? '').slice(0, WHO_MAX) } : { id: r.id }))
  } catch {
    /* private window or full storage: just don't remember */
  }
}
