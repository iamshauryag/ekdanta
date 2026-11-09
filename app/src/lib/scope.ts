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
  | { kind: 'spelling'; variety: 'regional' | 'typos' }
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
  /**
   * The ask asks for formatting: 'inline' for bold, italics or links, 'all' when it also asks for headings or
   * lists (or to format the piece). A change that formats is only within an ask like that.
   */
  formatting?: 'inline' | 'all'
  /** The words of the piece, lowercased: a typo fix may turn a short word into one of these. */
  vocabulary?: Set<string>
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : undefined
/** A word diff that also splits scripts written without spaces (Chinese, Japanese, Thai) into words. */
export const wordDiff = (a: string, b: string) => diffWordsWithSpace(a, b, segmenter ? { intlSegmenter: segmenter } : undefined)

// An emoji is a pictograph shown as one: emoji by default, or a text symbol (©, ®, ™, ‼, ℹ…) only when
// followed by U+FE0F. Skin tones, keycaps, tags and joiners belong to it only inside its sequence, so a
// zero-width joiner in Malayalam or Sinhala text is never taken for part of an emoji.
const EMOJI_SEQ = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:[\u{1F3FB}-\u{1F3FF}️⃣\u{E0020}-\u{E007F}]|‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})️?)*|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]️?⃣`
const EMOJI = new RegExp(EMOJI_SEQ, 'gu')
const HASHTAGS = /(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu
const HASHTAG = /(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/u
export const hasEmoji = (s: string) => new RegExp(EMOJI_SEQ, 'u').test(s)
export const stripEmoji = (s: string) => s.replace(EMOJI, '')
/** Spacing compared loosely, line breaks exactly: runs of spaces are one, spaces at line ends don't count, but a paragraph break is never the same as a space. */
const sp = (s: string) =>
  s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/^ | $/g, '')
const newlines = (s: string) => (s.match(/\n/g) ?? []).length

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
  if (/\b(british|uk|australian|american|us|canadian|indian)\s+(english|spellings?)\b|\bin (british|american)\b/i.test(m)) intents.push({ kind: 'spelling', variety: 'regional' })
  else if (/\b(typos?|spelling|misspell\w*)\b/i.test(m)) intents.push({ kind: 'spelling', variety: 'typos' })
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
  const formatting = formattingAsked(m)
  return { intents, open, noEmoji: emoji && removes, noHashtags: hashtags && removes, noDashes: dashes && removes, ...(formatting ? { formatting } : {}) }
}

// Formatting asks, read from verbs and phrases: "make it bold", "italicise the title", "add links", "turn this
// into a list", "add headings", "format this". The nouns alone ask for nothing: "shorten this list of hooks",
// "the link in the second line", "the heading is weak", "the highlights of the year" are not formatting asks.
const INLINE_ASK = new RegExp(
  [
    // Verbs that only ever mean formatting.
    String.raw`\b(embolden\w*|italici[sz]\w*|hyperlink\w*|strike ?through)\b`,
    // Bold, underline, highlight, emphasise, as the verb opening a clause ("bold the key phrases", "and underline it"); never "the bold claim".
    String.raw`(^|[.;:,!?]\s*|\b(and|then|also|please|just|now)\s+)(bold|underline|highlight|emphasi[sz]e|italics?)\b`,
    // Made bold, put in italics, set in bold: "make the key phrases bold", "put the title in italics".
    String.raw`\b(make|makes|set|put|turn|mark|format|have)\b[^.?!\n]{0,50}?\b(bold|italics?|italicised|italicized|underlined|in bold|in italics|bolded)\b`,
    String.raw`\b(add|insert|include|put( in)?)\s+(an?\s+|some\s+|the\s+)?links?\b|\blink\s+(it|this|that|them|these|those|to)\b`,
  ].join('|'),
  'i',
)
const BLOCK_ASK = new RegExp(
  [
    String.raw`\b(format\w*|bullet(s|ed| ?points?)?|numbered list|scannable|skimmable|easier to (scan|skim)|(sub-?)?headings?\s+(for|to)\s+(each|every|the)\b)\b`,
    // Headings or a list added, used or given: "add headings", "use subheadings", "outline it with headings", "give it some headers".
    String.raw`\b(add|use|insert|put( in)?|give( it)?|with|break( it)? up with|outline( it)? with)\s+(an?\s+|some\s+|the\s+|more\s+|section\s+)?(sub-?)?(headings?|headers?|section titles|lists?|bullets?)\b`,
    // Something made into one: "make the title a heading", "turn this into a list", "put it as numbered points".
    String.raw`\b(make|turn|put|convert|format|break|split|change|rewrite|organi[sz]e|lay( it)? out)\b[^.?!\n]{0,40}?\b(into|as|in|a|an)\s+(an?\s+|the\s+)?(bulleted\s+|numbered\s+|bullet\s+|ordered\s+)?(lists?|points|steps|headings?|subheadings?|headers?|sections)\b`,
    // Numbered steps and structure: "number these steps", "add some structure", "structure this better".
    String.raw`\bnumber\s+(these|the|them|each|my|those|this)\b`,
    String.raw`\b(add|give( it)?|more|needs?|some|better|clearer)\s+(some\s+|more\s+|a\s+|clearer\s+|better\s+)?structure\b|\b(re)?structure\s+(this|it|the|my)\b`,
  ].join('|'),
  'i',
)

function formattingAsked(m: string): 'inline' | 'all' | undefined {
  if (BLOCK_ASK.test(m)) return 'all'
  if (INLINE_ASK.test(m)) return 'inline'
  return undefined
}

/** Edit distance with a swap of two neighbouring letters counted as one edit, over graphemes. */
function distance(a: string[], b: string[]) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}

const graphemer = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined
const graphemes = (s: string) => (graphemer ? [...graphemer.segment(s)].map((g) => g.segment) : [...s])

/** A word in a common spelling: British and American variants of the same word come out the same. */
function canonical(word: string) {
  const w = word.toLowerCase().replace(/[’']/g, "'")
  const fixed: Record<string, string> = {
    grey: 'gray',
    programme: 'program',
    cheque: 'check',
    tyre: 'tire',
    kerb: 'curb',
    plough: 'plow',
    aluminium: 'aluminum',
    mould: 'mold',
    manoeuvre: 'maneuver',
    jewellery: 'jewelry',
    storey: 'story',
    pyjamas: 'pajamas',
    draught: 'draft',
    sceptical: 'skeptical',
  }
  if (fixed[w]) return fixed[w]
  return w
    .replace(/our(s|ed|ing|ite|ites|able|ful|less)?$/, 'or$1')
    .replace(/is(e|es|ed|ing|ation|ations|er|ers)$/, 'iz$1')
    .replace(/ys(e|es|ed|ing)$/, 'yz$1')
    .replace(/([^aeiou])re(s|d)?$/, '$1er$2')
    .replace(/ogue(s)?$/, 'og$1')
    .replace(/ence(s)?$/, 'ense$1')
    .replace(/ll(ed|ing|er|ers|ation)$/, 'l$1')
    .replace(/ae|oe/g, 'e')
}

/** Very common English words: a short "word" that is none of these, nor in the piece, is likely a typo. */
const COMMON = new Set(
  (
    'the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use ' +
    'that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them ' +
    'well were what then also back into year most even made after where think which their there these would about other could first those people because through ' +
    'being thing things every never always little still write wrote work works team week said says same each why may own off yes yet got via per'
  ).split(' '),
)

/**
 * The same word, spelled right: a typo fixed, never a different word. Longer words may differ by one
 * edit (two from 8 letters). A word of 3 or 4 letters only when it isn't itself a word ("teh" → "the"),
 * and becomes a common word or one the piece uses; "He" → "We" and "then" → "than" are new words.
 */
function typo(a: string, b: string, vocabulary?: Set<string>) {
  const x = graphemes(a.toLowerCase())
  const y = graphemes(b.toLowerCase())
  const n = Math.min(x.length, y.length)
  const d = distance(x, y)
  if (d === 0 || (n >= 5 && d === 1) || (n >= 8 && d === 2)) return true
  const known = (w: string) => COMMON.has(w) || (vocabulary?.has(w) ?? false)
  // The piece holds the typo itself, so only the common list says whether the original is a word.
  return n >= 3 && d === 1 && !COMMON.has(a.toLowerCase()) && known(b.toLowerCase())
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean)
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The term as a whole word; group 1 is the character before it, kept by every replacement. */
const termRe = (term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu')

/** Does turning `del` into `ins` do this, and only this? */
function fits(intent: Intent, del: string, ins: string, vocabulary?: Set<string>): boolean {
  switch (intent.kind) {
    case 'emoji':
      return sp(stripEmoji(del)) === sp(stripEmoji(ins)) && !hasEmoji(ins)
    case 'hashtags':
      // The tag taken out whole, or only its "#" ("Great #post" → "Great post", "Issue #5" → "Issue 5").
      return sp(del.replace(HASHTAGS, '$1')) === sp(ins) || sp(del.replace(/#(?=[\p{L}\p{N}_]|$)/gu, '')) === sp(ins)
    case 'dashes':
    case 'punctuation': {
      // Only punctuation may change: the words, the emoji and every line break stay.
      const bare = (s: string) => s.replace(/[\p{P}\s]/gu, '')
      return bare(del) === bare(ins) && newlines(del) === newlines(ins)
    }
    case 'case':
      return del.toLocaleLowerCase() === ins.toLocaleLowerCase()
    case 'spelling': {
      const a = tokens(del)
      const b = tokens(ins)
      if (a.length !== b.length || !a.length || newlines(del) !== newlines(ins)) return false
      const word = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      const edge = (w: string) => w.slice(0, w.length - w.replace(/^[^\p{L}\p{N}]+/u, '').length) + '|' + (w.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '')
      return a.every((w, i) => edge(w) === edge(b[i]) && (intent.variety === 'regional' ? canonical(word(w)) === canonical(word(b[i])) : typo(word(w), word(b[i]), vocabulary)))
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

/** Spacing a narrowed change left behind ("Nice  great day", "day ."), where the writer's own text had none. */
function tidy(text: string, own: string) {
  let out = text
  if (!/[ \t]{2}/.test(own)) out = out.replace(/([^ \t\n])[ \t]{2,}(?=[^ \t\n])/g, '$1 ')
  if (!/[ \t][.,!?;:)]/.test(own)) out = out.replace(/[ \t]+([.,!?;:)])/g, '$1')
  if (!/[ \t]\n/.test(own)) out = out.replace(/[ \t]+\n/g, '\n')
  return out
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
  const t = s.replace(/\s+/g, ' ').trim()
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

  const inScope = (h: { del: string; ins: string }) => ask.intents.some((i) => fits(i, h.del, h.ins, ask.vocabulary))
  const beyond = changed.filter((h) => !inScope(h))
  if (!beyond.length && !limits.length) return null
  const narrow = tidy(hunks.map((h) => h.eq + (h.del || h.ins ? (inScope(h) ? h.ins : carryOut(ask, h.del)) : '')).join(''), find)
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
