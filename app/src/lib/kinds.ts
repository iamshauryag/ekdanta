// Kinds of writing: Essay, LinkedIn post, Email and any the writer adds (a YouTube script, a letter).
// A piece's kind is its `platform` in front-matter. Each kind has a folder its pieces are filed in,
// a voice profile, a typical length, and a line on how it should read that the help levels follow.
// The list lives in the vault's settings; this module is shared by the app and the server.
import { slug } from './slug.ts'
import { isSpecialPath } from './special.ts'

/** How a kind's documents are laid out and counted, as defaults a document's own front matter overrides. */
export interface KindDoc {
  layout?: 'page'
  style?: 'mla' | 'apa' | 'chicago' | 'none'
  paper?: 'letter' | 'a4'
  /** A length target: '1500', '1500-2000', '<=750', '5 pages'. */
  target?: string
}

export interface Kind {
  /** What front-matter stores. Fixed once made, so renaming a kind never orphans its pieces. */
  id: string
  /** Singular, as in "New LinkedIn post". */
  name: string
  /** Top-level folder its pieces are filed in. */
  folder: string
  /** How the piece should read, for the help levels. */
  guidance: string
  /** A typical length in words. */
  words: number
  /** The template a new piece of this kind starts from: a vault path such as `templates/essay.md`. */
  template?: string
  doc?: KindDoc
}

export const DEFAULT_KINDS: Kind[] = [
  { id: 'essay', name: 'Essay', folder: 'essays', guidance: 'personal, considered, concrete, unhurried', words: 1200 },
  { id: 'linkedin', name: 'LinkedIn post', folder: 'linkedin', guidance: 'short paragraphs, a strong first line, plain words, no hashtags or emoji unless the writer uses them', words: 200 },
  { id: 'email', name: 'Email', folder: 'emails', guidance: 'clear, courteous, gets to the point', words: 150 },
  { id: 'text', name: 'Text message', folder: 'texts', guidance: 'brief and natural', words: 40 },
  { id: 'blog', name: 'Blog post', folder: 'blog', guidance: 'conversational but substantial', words: 900 },
]

/** A kind's id from its name as typed: "YT Scripts" → `yt-scripts`, "ब्लॉग" → `ब्लॉग`. Empty if nothing nameable. */
export const kindId = (name: string) => slug(name, 40)

// ---- Word rules -------------------------------------------------------------------------------
// A kind's name is stored singular ("YT script"); lists and folders use the plural ("YT scripts",
// yt-scripts/). Only the last word of a name changes, and only a Latin-script word: "ब्लॉग" and
// "日記" have no English plural and stay as typed.

/** Words that are the same in the singular and the plural. */
const INVARIANT = new Set([
  'news',
  'series',
  'species',
  'physics',
  'mathematics',
  'maths',
  'economics',
  'politics',
  'ethics',
  'logistics',
  'statistics',
  'athletics',
  'chaos',
  'kudos',
  'ethos',
  'pathos',
  'cosmos',
])
/**
 * Singular words that end in s. Nothing about the spelling tells "canvas" from "ideas", so the only
 * honest rule is a list: these keep their s, and their plural adds -es (canvas → canvases).
 */
const SINGULAR_S = new Set(['canvas', 'lens', 'atlas', 'bias', 'gas', 'iris', 'alias', 'plus', 'minus', 'christmas', 'summons'])
/** -ie words, whose plural is -ies but whose singular isn't -y. */
const IE_WORDS = new Set(['movie', 'cookie', 'selfie', 'zombie', 'rookie', 'pie', 'tie', 'lie', 'calorie', 'prairie', 'smoothie', 'hoodie', 'brownie', 'freebie', 'goalie', 'boogie'])

/** The last word and everything before it: "YT Scripts" → ["YT ", "Scripts"], `yt-scripts` → ["yt-", "scripts"]. */
const splitLast = (name: string): [string, string] => {
  const m = name.match(/^(.*[\s-])?([^\s-]*)$/s)
  return [m?.[1] ?? '', m?.[2] ?? name]
}
const inflectable = (word: string) => /^\p{Script=Latin}/u.test(word)

/** Does this word read as a plural? Scripts, stories, theses: yes. Class, bus, thesis, news: no. */
export function isPluralWord(word: string) {
  const w = word.toLowerCase()
  if (!inflectable(w) || INVARIANT.has(w) || SINGULAR_S.has(w)) return false
  return w.endsWith('ies') || (w.endsWith('s') && !/(ss|us|is)$/.test(w))
}

/** The -is/-es stems: thesis/theses, analysis/analyses, crisis/crises, diagnosis, synopsis, genesis. */
const GREEK_IS = /(the|ly|cri|gno|nop|ne)sis$/
const GREEK_ES = /(the|ly|cri|gno|nop|ne)ses$/

function pluralWord(w: string) {
  const l = w.toLowerCase()
  if (!inflectable(w) || INVARIANT.has(l) || isPluralWord(w)) return w
  // -is → -es only for the stems the singular rule knows (theses, analyses, crises); iris → irises.
  if (GREEK_IS.test(l)) return w.slice(0, -2) + (w.slice(-2) === 'IS' ? 'ES' : 'es')
  if (/(s|x|z|ch|sh)$/.test(l)) return w + 'es'
  if (/[^aeiou]y$/.test(l)) return w.slice(0, -1) + (w.slice(-1) === 'Y' ? 'IES' : 'ies')
  return w + 's'
}

function singularWord(w: string) {
  const l = w.toLowerCase()
  if (!isPluralWord(w)) return w
  if (l === 'buses') return w.slice(0, -2)
  // canvases → canvas, lenses → lens: only for the singulars that end in s, since courses → course.
  if (l.endsWith('es') && SINGULAR_S.has(l.slice(0, -2))) return w.slice(0, -2)
  if (GREEK_ES.test(l)) return w.slice(0, -2) + (w.slice(-2) === 'ES' ? 'IS' : 'is') // theses, analyses, crises
  if (l.endsWith('ies')) return IE_WORDS.has(l.slice(0, -1)) ? w.slice(0, -1) : w.slice(0, -3) + (w.slice(-3) === 'IES' ? 'Y' : 'y')
  if (/(ss|x|ch|sh|zz)es$/.test(l)) return w.slice(0, -2)
  return w.slice(0, -1) // courses → course, cases → case, scripts → script
}

/** The plural of a name or id: "YT script" → "YT scripts", "Thesis" → "Theses". An already plural name is returned as is. */
export const plural = (name: string) => {
  const [head, last] = splitLast(name)
  return head + pluralWord(last)
}

/** The singular of a name or id: "YT Scripts" → "YT Script", `yt-scripts` → `yt-script`. A singular name is returned as is. */
export const singular = (name: string) => {
  const [head, last] = splitLast(name)
  return head + singularWord(last)
}

/**
 * How a kind's name is stored: singular, the last word in lower case when it was capitalised only
 * because the writer typed a plural heading ("YT Scripts" → "YT script"). The other words keep their
 * casing; a one-word name keeps its capital ("Letters" → "Letter"), and so does an acronym ("FAQs" → "FAQ").
 */
export function kindDisplayName(name: string) {
  const [head, last] = splitLast(name)
  if (!isPluralWord(last) || pluralWord(singularWord(last)) !== last) return name
  const one = singularWord(last)
  return head.trim() && /^\p{Lu}\p{Ll}*$/u.test(one) ? head + one.toLowerCase() : head + one
}

/** The folder a kind's pieces go in, from its id: `yt-scripts` → yt-scripts/, `speech` → speeches/. */
export const kindFolderOf = (id: string) => kindFolder(plural(singular(id)))

/**
 * A saved folder that doubled the plural (`yt-scriptses/` for "YT Scripts", from before the word rules),
 * and the folder it should be. Folders such as courses/ (for "Course") or responses/ are never flagged.
 */
export function doubledFolder(kind: Pick<Kind, 'id' | 'folder'>): string | null {
  if (kind.folder !== kind.id + 'es' || !isPluralWord(splitLast(kind.id)[1])) return null
  return kindFolderOf(kind.id)
}

/** Is this name (singular or plural) already one of the kinds? "Script" is taken when "Scripts" exists. */
export const kindTaken = (kinds: Kind[], name: string) => {
  const key = (n: string) => singular(n.trim().normalize('NFC')).toLowerCase()
  const want = key(name)
  return !!want && kinds.some((k) => key(k.name) === want)
}

/**
 * The other kind that already answers to this name, when renaming the kind with `id` to it would
 * collide. Two kinds with one name read the same everywhere and make the taken checks lie.
 */
export const nameTakenBy = (kinds: Kind[], id: string, name: string) => kinds.find((k) => k.id !== id && kindTaken([k], name))

/** A new kind from just its name: "YT Scripts" is a "YT script", and files its pieces in yt-scripts/. */
export function newKind(name: string, taken: Kind[]): Kind | null {
  name = Array.from(name.trim().normalize('NFC')).slice(0, 40).join('').trim()
  if (!name || kindTaken(taken, name)) return null
  const base = kindId(name)
  const ids = new Set(taken.map((k) => k.id))
  // A name with nothing nameable in it (only emoji, say) still gets an id: kind-1, kind-2…
  let id = base || 'kind-1'
  const stem = base || 'kind'
  for (let n = 2; ids.has(id); n++) {
    const tail = `-${n}`
    id =
      Array.from(stem)
        .slice(0, 40 - tail.length)
        .join('')
        .replace(/-+$/, '') + tail
  }
  // Two kinds never share a folder: the second "Text" files into texts-2/.
  const folders = new Set(taken.map((k) => k.folder))
  const first = base ? kindFolderOf(base) : id
  let folder = first
  for (let n = 2; folders.has(folder); n++) folder = `${first}-${n}`
  return { id, name: kindDisplayName(name), folder, guidance: '', words: 800 }
}

/**
 * The folder a new kind files into. Special folders (templates, journal, sources…) are left out of
 * Recall and voice, so a new kind named "Template" or "Source" files into my-templates/ or my-sources/
 * instead: its pieces are the writer's own and should count like any other. Only new kinds get this;
 * a kind the writer already saved keeps its folder (see cleanKinds).
 */
const kindFolder = (folder: string) => (isSpecialPath(folder) ? `my-${folder}` : folder)

/** A kind id: letters (any script), marks, digits and hyphens, at most 40 characters. */
export const KIND_ID = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,39}$/u

/** Keep only well-formed kinds (settings come from a file the writer can edit). */
export function cleanKinds(value: unknown): Kind[] | null {
  if (!Array.isArray(value)) return null
  const out: Kind[] = []
  for (const k of value as Partial<Kind>[]) {
    if (!k || typeof k.id !== 'string') continue
    const id = k.id.normalize('NFC')
    if (!KIND_ID.test(id) || out.some((o) => o.id === id)) continue
    // Names read singular ("YT Scriptses" came from a plural name); this only changes what's shown.
    const name = typeof k.name === 'string' && k.name.trim() ? kindDisplayName(Array.from(k.name.trim().normalize('NFC')).slice(0, 40).join('').trim()) : id
    // A saved folder is the writer's: never rewritten here, even a special one (its pieces already live there).
    // A doubled plural (yt-scriptses/) is put right by the server, which can see whether it holds anything.
    const folder = kindId(typeof k.folder === 'string' ? k.folder : '') || kindFolderOf(id)
    const guidance = typeof k.guidance === 'string' ? k.guidance.trim().slice(0, 400) : ''
    const words = Math.max(1, Math.min(50000, Math.round(Number(k.words) || 800)))
    const kind: Kind = { id, name, folder, guidance, words }
    const template = cleanTemplate(k.template)
    if (template) kind.template = template
    const doc = cleanKindDoc(k.doc)
    if (doc) kind.doc = doc
    out.push(kind)
  }
  return out.length ? out : null
}

/** A vault-relative Markdown path that stays inside the vault, or undefined. */
function cleanTemplate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const p = value.trim().replace(/\\/g, '/')
  if (!p || p.length > 200 || !p.endsWith('.md') || p.startsWith('/') || /^[a-z]:/i.test(p)) return undefined
  if (p.split('/').some((part) => !part || part === '.' || part === '..')) return undefined
  return p
}

const STYLES = ['mla', 'apa', 'chicago', 'none'] as const
const PAPERS = ['letter', 'a4'] as const

/** Only the fields that are well formed; a bad one is dropped without losing the rest (or the kind). */
function cleanKindDoc(value: unknown): KindDoc | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const d = value as Record<string, unknown>
  const out: KindDoc = {}
  if (d.layout === 'page') out.layout = 'page'
  if (STYLES.includes(d.style as (typeof STYLES)[number])) out.style = d.style as KindDoc['style']
  if (PAPERS.includes(d.paper as (typeof PAPERS)[number])) out.paper = d.paper as KindDoc['paper']
  if (typeof d.target === 'string' && d.target.trim() && d.target.trim().length <= 40) out.target = d.target.trim()
  return Object.keys(out).length ? out : undefined
}

export const findKind = (kinds: Kind[], id: string) => {
  const want = id.normalize('NFC').toLowerCase()
  return kinds.find((k) => k.id === want)
}

/**
 * The kind a top-level folder holds: its own folder (`emails` for email), or a folder named exactly
 * as its id. Nothing is guessed from a name's start, so textbooks/ is not the "text" kind's. Nested
 * folders are the writer's own. A special folder (templates, journal…) holds a kind only when a kind
 * names it as its folder, so templates/ never makes a "Template" kind's pieces.
 */
export const kindOfFolder = (kinds: Kind[], folder: string) => {
  if (!folder || folder.includes('/')) return undefined
  const f = folder.normalize('NFC').toLowerCase()
  const exact = kinds.find((k) => f === k.folder)
  if (exact || isSpecialPath(f)) return exact
  return kinds.find((k) => f === k.id)
}

/** A kind's name, or a readable one for a kind the list doesn't have (a piece from elsewhere). */
export const kindName = (kinds: Kind[], id: string) => findKind(kinds, id)?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : 'Piece')

/** "3 YT scripts", for counts. */
export const pieceName = (kinds: Kind[], id: string, n: number) => {
  // Singular first, so a name saved before the word rules ("YT Scripts") still reads "a YT script", "3 YT scripts".
  const one = kindDisplayName(findKind(kinds, id)?.name ?? 'piece')
  // "Essay" reads "essay" mid-sentence; "LinkedIn post" and "YT script" keep their capitals.
  const noun = /^[A-Z][a-z]*(\s|$)/.test(one) ? one[0].toLowerCase() + one.slice(1) : one
  return n === 1 ? noun : plural(noun)
}

/** How a help prompt describes the piece: "a LinkedIn post: short paragraphs, …". */
export function describeKind(kinds: Kind[], id?: string) {
  const k = findKind(kinds, id ?? 'essay') ?? findKind(kinds, 'essay') ?? kinds[0]
  if (!k) return 'a piece of writing'
  const noun = pieceName(kinds, k.id, 1)
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a'
  return `${article} ${noun}${k.guidance ? `: ${k.guidance}` : ''}`
}

// The app's copy of the list, set from settings when they load or change.
let current: Kind[] = DEFAULT_KINDS
export const setKinds = (kinds: Kind[] | undefined) => {
  current = kinds?.length ? kinds : DEFAULT_KINDS
}
export const kinds = () => current
