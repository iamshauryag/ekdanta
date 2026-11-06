// Splitting prose into sentences, and how a sentence should sound when it is read aloud. Shared by
// read-aloud and anything else that works sentence by sentence, so no DOM here.
//
// A full stop ends a sentence unless it belongs to an abbreviation the writer would never end on
// ("Dr. Rao", "e.g. Paris", "p. 4", "J. K. Rowling"), or the next word starts in lower case
// ("e.g. the", "Wait... what?").

export interface Span {
  /** Offset of the sentence's first character in the text. */
  from: number
  /** Offset just after its last character (closing quotes and brackets included). */
  to: number
}

/** Abbreviations that are followed by a name or a word, never by the end of a sentence. */
const ALWAYS_JOIN = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'rev',
  'hon',
  'gen',
  'col',
  'capt',
  'lt',
  'sgt',
  'fr',
  'st',
  'mt',
  'e.g',
  'i.e',
  'cf',
  'vs',
  'viz',
  'approx',
  'ca',
  'esp',
  'incl',
  'resp',
])
/** Abbreviations that join when a number follows them: "p. 4", "No. 5", "Fig. 2", "Jan. 6". */
const NUMBERED = new Set([
  'p',
  'pp',
  'para',
  'vol',
  'vols',
  'no',
  'nos',
  'fig',
  'figs',
  'ch',
  'chap',
  'sec',
  'eq',
  'art',
  'ed',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
])

const TERMINATOR = /[.!?…]/
const CLOSERS = /["'”’)\]»]/
const LOWER = /\p{Ll}/u

/** The word just before a full stop at `dot`, with any inner dots ("e.g", "U.S"), lower-cased. */
function wordBefore(text: string, dot: number): string {
  let i = dot
  while (i > 0 && /[\p{L}\p{N}.]/u.test(text[i - 1])) i--
  // A leading opener ("(e.g.") isn't part of the word.
  return text.slice(i, dot).replace(/^\.+/, '').toLowerCase()
}

/** Words that start sentences far more often than they follow an initial in a name. */
const STARTERS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'then',
  'there',
  'it',
  'its',
  'i',
  'we',
  'he',
  'she',
  'they',
  'you',
  'my',
  'our',
  'his',
  'her',
  'their',
  'but',
  'and',
  'so',
  'or',
  'if',
  'in',
  'on',
  'at',
  'as',
  'for',
  'to',
  'when',
  'what',
  'why',
  'how',
  'after',
  'now',
  'yet',
  'no',
  'not',
])

const WORD = /[\p{L}'’-]+/uy
const wordAt = (text: string, at: number) => {
  WORD.lastIndex = at
  return WORD.exec(text)?.[0] ?? ''
}
/** The word that ends just before `at` (skipping spaces), as written. */
function wordEndingAt(text: string, at: number): string {
  let e = at
  while (e > 0 && text[e - 1] === ' ') e--
  let b = e
  while (b > 0 && /[\p{L}'’.-]/u.test(text[b - 1])) b--
  return text.slice(b, e)
}

/**
 * Is the capital letter at `letter` (followed by a full stop, then a capitalised word at `next`)
 * an initial in a name? Yes beside another initial ("J. K."), or between a capitalised name and a
 * word that isn't a usual sentence opener ("John F. Kennedy"), unless the same word repeats as in
 * a list ("Item A. Item B.").
 */
function isInitial(text: string, letter: number, next: number): boolean {
  const after = wordAt(text, next)
  // Another initial follows: "J. K."
  if (/^\p{Lu}$/u.test(after) && text[next + 1] === '.') return true
  const before = wordEndingAt(text, letter)
  // Another initial comes before: "K." in "J. K. Rowling".
  if (/^\p{Lu}\.$/u.test(before)) return true
  // A name opening the text ("J. Smith arrived."), or after a capitalised word ("John F. Kennedy").
  const nameLike = !before || /[.!?…]$/u.test(before) || /^\p{Lu}\p{Ll}/u.test(before)
  return nameLike && !STARTERS.has(after.toLowerCase()) && after !== before
}

/** Does the punctuation run that ends at `end` (exclusive) close a sentence, given what comes next? */
function endsSentence(text: string, start: number, end: number, next: number): boolean {
  const punct = text.slice(start, end)
  if (next >= text.length) return true
  const c = text[next]
  // "e.g. the", "Wait... what?": a lower-case word carries the sentence on.
  if (LOWER.test(c)) return false
  // Only a lone full stop can belong to an abbreviation; "?", "!" and "..." always end (unless lower case follows).
  if (punct !== '.') return true
  const word = wordBefore(text, start)
  if (!word) return true
  if (ALWAYS_JOIN.has(word)) return false
  if (NUMBERED.has(word) && /\p{N}/u.test(c)) return false
  // An initial: "J. K. Rowling", "John F. Kennedy". A lone capital letter before the stop is also
  // how "plan A. Then…" and "vitamin C. It…" end, so it joins only when it looks like part of a name.
  if (/^\p{Lu}$/u.test(text[start - 1]) && (start < 2 || !/[\p{L}\p{N}]/u.test(text[start - 2])) && /\p{Lu}/u.test(c) && isInitial(text, start - 1, next)) return false
  // Dotted abbreviations such as "U.S." or "a.m." end a sentence only when a capital follows, which it does here.
  return true
}

/** The sentences in a stretch of prose, as offsets, without the spaces between them. */
export function splitSentences(text: string): Span[] {
  const out: Span[] = []
  let start = 0
  let i = 0
  const push = (to: number) => {
    let from = start
    while (from < to && /\s/.test(text[from])) from++
    let end = to
    while (end > from && /\s/.test(text[end - 1])) end--
    if (end > from) out.push({ from, to: end })
  }
  while (i < text.length) {
    if (text[i] === '\n') {
      // A line break inside a block (a verse, an address) ends what came before it.
      push(i)
      start = i + 1
      i++
      continue
    }
    if (!TERMINATOR.test(text[i])) {
      i++
      continue
    }
    const pStart = i
    while (i < text.length && TERMINATOR.test(text[i])) i++
    const pEnd = i
    while (i < text.length && CLOSERS.test(text[i])) i++
    // "3.50", "example.com": no space after the stop, so not the end of a sentence.
    if (i < text.length && !/\s/.test(text[i])) continue
    let next = i
    while (next < text.length && /\s/.test(text[next])) next++
    // Skip an opening quote or bracket to find the next word's first letter.
    let first = next
    while (first < text.length && /["'“‘(\[«]/.test(text[first])) first++
    if (endsSentence(text, pStart, pEnd, first)) {
      push(i)
      start = i
    }
  }
  push(text.length)
  return out
}

// ---- How it sounds --------------------------------------------------------------------------

/** One "(Smith, 2019, p. 4)" part: an author (or authors) and a year, perhaps with a page. */
const CITE_PART =
  /^\s*(?:see\s+|e\.g\.,?\s+|cf\.\s+)?([\p{Lu}][\p{L}'’.\- ]*?(?:\s+(?:&|and)\s+[\p{Lu}][\p{L}'’.\- ]*?|\s+et al\.)?),?\s+(\d{4}[a-z]?|n\.d\.)(?:,\s*(?:pp?\.|para\.|ch\.)\s*[\d–\-, ]+)?\s*$/u

/**
 * A sentence as it should be spoken: footnote markers dropped, and an in-text citation read as its
 * author and year ("(Smith, 2019, p. 4)" → "Smith 2019"), not as punctuation and page numbers.
 */
export function spokenText(sentence: string): string {
  return (
    sentence
      // Markdown footnote references and superscript note numbers.
      .replace(/\[\^[^\]\s]+\]/g, '')
      .replace(/(?<=[\p{L}.,;:!?)”’"'])[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, '')
      .replace(/\(([^()]{3,200})\)/g, (whole, inner: string) => {
        const parts = inner.split(';')
        const said: string[] = []
        for (const part of parts) {
          const m = part.match(CITE_PART)
          if (!m) return whole
          said.push(`${m[1].replace(/\s+/g, ' ').trim()} ${m[2] === 'n.d.' ? 'no date' : m[2]}`)
        }
        return said.join(', ')
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim()
  )
}

/** Does this sentence have anything to say once markers are gone? ("[^1]" alone, "—", "* * *" don't.) */
export const isSpeakable = (sentence: string) => /[\p{L}\p{N}]/u.test(spokenText(sentence))

/**
 * Break a long sentence into pieces of at most about `max` characters, at a comma or a space, so a
 * speech engine that cuts off long utterances (Chrome's online voices stop after about 15 seconds)
 * still reads all of it.
 */
export function chunkForSpeech(text: string, max = 220): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' – '), window.lastIndexOf(' — '))
    if (cut < max * 0.4) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = max - 1
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out
}

// ---- How long it takes ------------------------------------------------------------------------

/** Typical silent reading (238 words a minute, Brysbaert 2019) and speaking (150) rates. */
export const READ_WPM = 238
export const SAY_WPM = 150

const minutes = (words: number, wpm: number) => {
  const m = words / wpm
  return m < 0.75 ? 'under a minute' : `about ${Math.max(1, Math.round(m))} min`
}

/** "about 6 min to read · 8 min to say", for the word count's hover line. Empty for an empty page. */
export function readingTimes(words: number): string {
  if (words <= 0) return ''
  const read = minutes(words, READ_WPM)
  const say = minutes(words, SAY_WPM).replace(/^about /, read.startsWith('about') ? '' : 'about ')
  return `${read} to read · ${say} to say`
}
