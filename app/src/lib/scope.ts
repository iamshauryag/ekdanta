// What a writer's ask covers, and whether a change stays inside it.
//
// "Remove the emojis" should remove the emojis and touch nothing else. The model is told so, and code
// checks it: for asks whose effect can be told from the text (emojis, hashtags, dashes, punctuation,
// capitals, spelling, one word swapped for another), each change is split into the words it changes and
// every one of those is checked against the ask. A change that does more than was asked is not dropped
// and not silently applied: it is flagged, with what it does beyond the ask, and with the version that
// keeps only the asked-for part when there is one. Asks whose effect can't be checked ("tighten it",
// "rewrite the whole post") are left to the model and the writer's review, but the limits they state
// ("no emojis", "no hashtags") are still checked.
import { diffWordsWithSpace } from 'diff'

export type Intent =
  | { kind: 'emoji' }
  | { kind: 'hashtags' }
  | { kind: 'dashes' }
  | { kind: 'punctuation' }
  | { kind: 'case' }
  | { kind: 'spelling' }
  | { kind: 'remove'; term: string }
  | { kind: 'replace'; term: string; with: string }

export interface Ask {
  /** Checkable things the writer asked for. */
  intents: Intent[]
  /** The ask also wants something open-ended (a rewrite, a tighter version): its changes can't be checked word by word. */
  open: boolean
  /** Limits the writer stated, which every change must keep to. */
  noEmoji: boolean
  noHashtags: boolean
  noDashes: boolean
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined
/** A word diff that also splits scripts written without spaces (Chinese, Japanese, Thai) into words. */
export const wordDiff = (a: string, b: string) => diffWordsWithSpace(a, b, segmenter ? { intlSegmenter: segmenter } : undefined)

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu
const HASHTAGS = /(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu
const HASHTAG = /(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/u
export const hasEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s)
export const stripEmoji = (s: string) => s.replace(EMOJI, '')
const sp = (s: string) => s.replace(/\s+/g, ' ').trim()

const REMOVE = /\b(remove|delete|strip|drop|cut|take out|get rid|lose|kill|clear|no|without|ditch)\b/i
const OPEN =
  /\b(re-?write|redo|re-?draft|rework|restructure|reorder|tighten|shorten|lengthen|expand|trim|condense|improve|polish|edit|punch\w*|warmer|friendlier|formal|casual|tone|clarify|clearer|simplif\w*|simpler|shorter|longer|grammar|flow|smooth\w*|better|stronger|reword|rephrase|paraphrase|summari[sz]e|add|translate|hooks?|cta|ending|opening|intro|conclusion)\b/i
const QUOTED = `["“'‘]([^"”'’\\n]{1,40})["”'’]`

/** Read an ask for what it covers. Pure, and on the safe side: when unsure, the ask is open and only stated limits are checked. */
export function readAsk(message: string): Ask {
  const m = message.normalize('NFC')
  const intents: Intent[] = []
  const removes = REMOVE.test(m)
  const emoji = /\b(emoj\w*|emoticons?|smileys?)\b/i.test(m)
  const hashtags = /\bhash ?tags?\b/i.test(m)
  const dashes = /\b(em[- ]?dash\w*|en[- ]?dash\w*|dashes)\b|—/i.test(m)
  if (emoji && removes) intents.push({ kind: 'emoji' })
  if (hashtags && removes) intents.push({ kind: 'hashtags' })
  if (dashes && (removes || /\b(replace|swap|change|fix|use)\b/i.test(m))) intents.push({ kind: 'dashes' })
  if (/\b(punctuation|commas?|apostrophes?|quotation marks|semicolons?|oxford comma|full stops?)\b/i.test(m)) intents.push({ kind: 'punctuation' })
  if (/\b(sentence case|title case|lower ?case|upper ?case|capitali[sz]\w*|capital letters|caps)\b/i.test(m)) intents.push({ kind: 'case' })
  if (/\b(british|uk|australian|american|us|canadian|indian)\s+(english|spellings?)\b|\b(typos?|spelling|misspell\w*)\b|\bin british\b/i.test(m)) intents.push({ kind: 'spelling' })
  // No lookbehind anywhere here: it blanks the page on older Safari.
  const WORD = `([\\p{L}\\p{N}'’-]+)`
  const replace = m.match(
    new RegExp(`\\b(?:replace|change|swap|switch|turn)\\s+(?:(?:every|all|each)\\s+${QUOTED}|${QUOTED}|(?:every|all|each)\\s+${WORD})\\s+(?:with|to|for|into)\\s+(?:${QUOTED}|${WORD})`, 'iu'),
  )
  if (replace) {
    const term = replace[1] ?? replace[2] ?? replace[3]
    const by = replace[4] ?? replace[5]
    if (term && by) intents.push({ kind: 'replace', term, with: by })
  }
  const remove = m.match(new RegExp(`\\b(?:remove|delete|cut|drop|strip|take out|get rid of)\\s+(?:every |all |each |the )?(?:word |words |instances? of |uses? of |mentions? of )?${QUOTED}`, 'iu'))
  if (remove && !replace) intents.push({ kind: 'remove', term: remove[1] })
  // "Fix typos" can be checked; "fix the post" can't. Anything that asks for new wording makes the ask open.
  let open = OPEN.test(m) || /\bfix\b(?!\s+(?:the\s+|my\s+|any\s+|all\s+)?(typos?|spelling|punctuation|capitals?|dashes|commas|apostrophes))/i.test(m)
  if (!intents.length) open = true
  return { intents, open, noEmoji: emoji && removes, noHashtags: hashtags && removes, noDashes: dashes && removes }
}

/** Levenshtein distance, for short words. */
function distance(a: string, b: string) {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean)
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The term as a whole word; group 1 is the character before it, kept by every replacement. */
const termRe = (term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu')

/** Does turning `del` into `ins` do this, and only this? */
function fits(intent: Intent, del: string, ins: string): boolean {
  switch (intent.kind) {
    case 'emoji':
      return sp(stripEmoji(del)) === sp(stripEmoji(ins)) && !hasEmoji(ins)
    case 'hashtags':
      return sp(del.replace(HASHTAGS, '$1')) === sp(ins) || sp(del.replace(/#(?=[\p{L}\p{N}_])/gu, '')) === sp(ins)
    case 'dashes':
    case 'punctuation': {
      const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '')
      return letters(del) === letters(ins)
    }
    case 'case':
      return del.toLocaleLowerCase() === ins.toLocaleLowerCase()
    case 'spelling': {
      const a = tokens(del)
      const b = tokens(ins)
      if (a.length !== b.length || !a.length) return false
      return a.every((w, i) => distance(w.toLowerCase(), b[i].toLowerCase()) <= Math.max(1, Math.floor(Math.max(w.length, b[i].length) / 3)))
    }
    case 'remove':
      return termRe(intent.term).test(del) && sp(del.replace(termRe(intent.term), '$1')) === sp(ins)
    case 'replace':
      return termRe(intent.term).test(del) && sp(del.replace(termRe(intent.term), '$1' + intent.with.replace(/\$/g, '$$$$'))).toLocaleLowerCase() === sp(ins).toLocaleLowerCase()
  }
}

/** What an ask would do to this text by itself, for asks code can carry out (emojis, hashtags, a word removed). */
function carryOut(ask: Ask, del: string): string {
  let out = del
  for (const i of ask.intents) {
    if (i.kind === 'emoji') out = stripEmoji(out)
    else if (i.kind === 'hashtags') out = out.replace(HASHTAGS, '$1')
    else if (i.kind === 'remove') out = out.replace(termRe(i.term), '$1')
  }
  // Taking a word out leaves its space behind: keep a single one, and none at the end.
  return out === del ? del : out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, del.match(/[ \t]+$/) && /\S/.test(out) ? ' ' : '')
}

/** A change as its changed places: the unchanged text before each, what it takes out and what it puts in. */
export function hunksOf(find: string, replace: string): { eq: string; del: string; ins: string }[] {
  const out: { eq: string; del: string; ins: string }[] = []
  let cur = { eq: '', del: '', ins: '' }
  for (const p of wordDiff(find, replace)) {
    if (!p.added && !p.removed) {
      if (cur.del || cur.ins) {
        out.push(cur)
        cur = { eq: '', del: '', ins: '' }
      }
      cur.eq += p.value
    } else if (p.removed) cur.del += p.value
    else cur.ins += p.value
  }
  out.push(cur)
  return out
}

const short = (s: string, n = 30) => {
  const t = sp(s)
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t
}

export interface ScopeFlag {
  /** What the change does beyond the ask, in plain words. */
  note: string
  /** The change with only the asked-for part, when that still changes something. */
  narrow?: string
}

/** Does a change keep to the ask? Null when it does, or when that can't be told. `find` is the draft's own text. */
export function checkScope(ask: Ask, find: string, replace: string): ScopeFlag | null {
  const hunks = hunksOf(find, replace)
  const changed = hunks.filter((h) => h.del || h.ins)
  if (!changed.length) return null
  const added = changed.map((h) => h.ins).join(' ')
  const limits: string[] = []
  if (ask.noEmoji && hasEmoji(added)) limits.push('adds an emoji')
  if (ask.noHashtags && HASHTAG.test(' ' + added)) limits.push('adds a hashtag')
  if (ask.noDashes && /[—–]/.test(added)) limits.push('adds a dash')
  const broke = `This ${limits.join(' and ')}, which you asked not to.`
  if (ask.open) return limits.length ? { note: broke } : null

  const inScope = (h: { del: string; ins: string }) => ask.intents.some((i) => fits(i, h.del, h.ins))
  const beyond = changed.filter((h) => !inScope(h))
  if (!beyond.length && !limits.length) return null
  const narrow = hunks.map((h) => h.eq + (h.del || h.ins ? (inScope(h) ? h.ins : carryOut(ask, h.del)) : '')).join('')
  const shown = beyond
    .slice(0, 3)
    .map((h) => (h.del.trim() && h.ins.trim() ? `“${short(h.del)}” → “${short(h.ins)}”` : h.del.trim() ? `cuts “${short(h.del)}”` : h.ins.trim() ? `adds “${short(h.ins)}”` : 'changes spacing'))
    .join(', ')
  const more = beyond.length > 3 ? ` and ${beyond.length - 3} more` : ''
  const note = beyond.length ? `Goes beyond what you asked: ${shown}${more}.` : broke
  return { note, ...(narrow !== find && narrow !== replace ? { narrow } : {}) }
}

const INTENT_WORDS: Record<Intent['kind'], (i: Intent) => string> = {
  emoji: () => 'remove the emojis',
  hashtags: () => 'remove the hashtags',
  dashes: () => 'change the dashes',
  punctuation: () => 'fix the punctuation',
  case: () => 'change capital letters',
  spelling: () => 'change spellings',
  remove: (i) => `remove “${(i as { term: string }).term}”`,
  replace: (i) => `change “${(i as { term: string }).term}” to “${(i as { with: string }).with}”`,
}

/** Plain words for what a mechanical ask covers, for the prompt. Empty when the ask is open-ended. */
export function askRule(ask: Ask): string {
  if (ask.open || !ask.intents.length) return ''
  const what = ask.intents.map((i) => INTENT_WORDS[i.kind](i)).join(' and ')
  return `This ask is mechanical: ${what}, everywhere it applies, and nothing else. Each change must do only that: not one other word, space, line break or punctuation mark may change.`
}
