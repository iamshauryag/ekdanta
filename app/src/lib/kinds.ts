// Kinds of writing: Essay, LinkedIn post, Email, YouTube script and any the writer adds (a letter).
// A kind and a top-level folder are one thing. Every top-level folder of the vault is a kind (except
// the set-apart ones: templates, journal, the Brain, attachments…), and a note's kind is the folder
// it sits in, at any depth: Essays/2024/ is still Essays. A note at the top of the vault is Unfiled.
// Front matter `platform:` only mirrors the folder, for Obsidian; where they disagree the folder wins.
// Each kind's settings (a voice profile, a typical length, a line on how it should read) live in the
// vault's settings, keyed by the kind's id, so renaming its folder in the app keeps them.
// This module is shared by the app and the server.
import { slug } from './slug.ts'
import { isSpecialPath } from './special.ts'
import { isBrainPath } from './brain.ts'

/** How a kind's documents are laid out and counted, as defaults a document's own front matter overrides. */
export interface KindDoc {
  layout?: 'page'
  style?: 'mla' | 'apa' | 'chicago' | 'none'
  paper?: 'letter' | 'a4'
  /** A length target: '1500', '1500-2000', '<=750', '5 pages'. */
  target?: string
}

export interface Kind {
  /** What front matter mirrors, and what its settings are kept by. Fixed once made, so renaming the kind or its folder keeps them. */
  id: string
  /** Singular, as in "New LinkedIn post". */
  name: string
  /** The top-level folder that is this kind, as it's spelled on disk ("Book chapters"). */
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
  { id: 'youtube-script', name: 'YouTube script', folder: 'scripts', guidance: 'written to be spoken: short sentences, says early what the viewer gets, no throat-clearing', words: 900 },
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
  const folders = new Set(taken.map((k) => fold(k.folder)))
  const first = base ? kindFolderOf(base) : id
  let folder = first
  for (let n = 2; folders.has(fold(folder)); n++) folder = `${first}-${n}`
  return { id, name: kindDisplayName(name), folder, guidance: '', words: 800 }
}

/**
 * The folder a new kind files into. Set-apart folders (templates, journal, sources, attachments…) are
 * never kinds, so a new kind named "Template" or "Source" files into my-templates/ or my-sources/
 * instead: its pieces are the writer's own and should count like any other.
 */
const kindFolder = (folder: string) => (isSetApartFolder(folder) ? `my-${folder}` : folder)

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
    // A saved folder is the writer's, spelled as on disk ("Book chapters"): never rewritten here.
    const folder = cleanFolderName(k.folder) || kindFolderOf(id)
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

/** A top-level folder's name as the writer spelled it ("Book chapters"), or '' when it can't be one. */
export function cleanFolderName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const f = value.normalize('NFC').trim()
  if (!f || f.length > 100 || /[\\/\u0000-\u001f]/.test(f) || f.startsWith('.')) return ''
  return f
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

export const findKind = (kinds: readonly Kind[], id: string) => {
  const want = id.normalize('NFC').toLowerCase()
  return kinds.find((k) => k.id === want)
}

/** A note's kind when it sits in no kind's folder: at the top of the vault, or just imported. */
export const UNFILED = ''
export const UNFILED_NAME = 'Unfiled'

/**
 * Top-level folders that hold the app's own files or material rather than a kind of writing, besides
 * the special folders (templates, journal, sources…): pictures, the kept sparks, a trash of the writer's.
 */
export const SET_APART_FOLDERS = ['attachments', 'assets', 'ideas', 'trash']

/** What else keeps a folder from being a kind: the writer's excluded folders and the Brain's (settings). */
export interface KindScope {
  excluded?: readonly string[]
  brain?: string
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const normFolder = (f: string) => fold(f.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))

/**
 * Is this top-level folder kept out of the kinds? Hidden folders (.ekdanta, .obsidian), the special
 * folders, attachments and the like, a folder the writer excluded, and the Brain's.
 */
export function isSetApartFolder(name: string, scope: KindScope = {}): boolean {
  const f = cleanFolderName(name)
  if (!f) return true
  const low = fold(f)
  if (SET_APART_FOLDERS.includes(low) || isSpecialPath(low)) return true
  if ((scope.excluded ?? []).some((e) => typeof e === 'string' && normFolder(e) === low)) return true
  return !!scope.brain && normFolder(scope.brain) === low
}

/** The top-level folder of a vault path, or '' for a note at the top of the vault. */
export const topFolder = (path: string) => {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '')
  return p.includes('/') ? p.slice(0, p.indexOf('/')) : ''
}

/**
 * The kind a folder is: its top-level folder's, so essays/2024 is Essays. Matched by the folder's
 * name as it is on disk (ignoring case); undefined for the top of the vault or a set-apart folder.
 */
export const kindOfFolder = (kinds: readonly Kind[], folder: string) => {
  const top = fold(folder.replace(/\\/g, '/').replace(/^\/+/, '').split('/')[0] ?? '')
  return top ? kinds.find((k) => fold(k.folder) === top) : undefined
}

/**
 * The kind of the note at `path`, from where it is: the id of its top-level folder's kind, so
 * essays/2024/x.md is an essay. A note at the top of the vault is UNFILED (''). Front matter is
 * never the authority: a note whose `platform:` says otherwise still follows its folder.
 *
 * Set-apart folders (templates, journal, the Brain, excluded ones) aren't kinds. A note in one keeps
 * the kind its front matter names (`mirror`, when that's one of the kinds), since a template says
 * which kind it is for and a journal entry can be drafted as one; otherwise it is Unfiled too.
 */
export function kindOfPath(kinds: readonly Kind[], path: string, scope: KindScope = {}, mirror?: string): string {
  const top = topFolder(path)
  if (!top) return UNFILED
  const inBrain = !!scope.brain && isBrainPath(path, scope.brain)
  const own = !inBrain && kindOfFolder(kinds, top)
  if (own) return own.id
  return (mirror && findKind(kinds, mirror.trim())?.id) || UNFILED
}

/** "Book chapters" → "Book chapter", "yt-scripts" → "Yt script": a kind's name from its folder's. */
export function nameFromFolder(folder: string): string {
  const words = folder.normalize('NFC').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return folder
  return kindDisplayName(words[0].toUpperCase() + words.slice(1))
}

/**
 * The folder a kind renamed to `name` goes in, keeping the style of the one it had: a folder written
 * like an id (yt-scripts) stays one (yt-shorts), and one the writer named in words ("Book chapters")
 * takes the plural of the new name in words ("Short stories").
 */
export function folderForName(name: string, was: string): string {
  const n = Array.from(name.trim().normalize('NFC')).slice(0, 40).join('').trim()
  const plain = !was || was === kindId(was)
  return plain ? kindFolderOf(kindId(n) || 'kind') : cleanFolderName(plural(n)) || kindFolderOf(kindId(n) || 'kind')
}

/**
 * The writer's kinds: one for each of the vault's top-level folders (`folders`, already without the
 * set-apart ones), with the settings saved for it. A saved kind is matched to a folder first by its
 * own folder (ignoring case), then by the same name spelled another way ("Essays" for essays/, or
 * a folder named by its id: "Email" for the email kind). A folder no saved kind matches is a new kind,
 * named from the folder ("Book chapters" → Book chapter) with an id no saved kind uses. Saved kinds
 * whose folder isn't there are left out, but their settings are kept, ready for when it comes back.
 * Matched kinds keep the order they were saved in; the new ones follow, by folder name.
 */
export function kindsFromFolders(saved: readonly Kind[], folders: readonly string[]): Kind[] {
  // Spelled as on disk (macOS may hand back a decomposed name): paths are built from it.
  const list = [...new Map(folders.map((f) => [fold(f), f])).values()]
  const owner = new Map<string, Kind>()
  const used = new Set<string>()
  const claim = (f: string, k: Kind | undefined) => {
    if (!k) return
    owner.set(f, k)
    used.add(k.id)
  }
  for (const f of list)
    claim(
      f,
      saved.find((k) => !used.has(k.id) && fold(k.folder) === fold(f)),
    )
  for (const f of list) {
    if (owner.has(f)) continue
    const s = kindId(f)
    const one = kindId(singular(f))
    claim(
      f,
      saved.find((k) => !used.has(k.id) && !!s && (kindId(k.folder) === s || k.id === s || k.id === one)),
    )
  }
  const ids = new Set(saved.map((k) => k.id))
  const made: Kind[] = []
  for (const f of list.filter((f) => !owner.has(f)).sort((a, b) => a.localeCompare(b))) {
    const base = kindId(singular(f)) || 'kind'
    let id = base
    for (let n = 2; ids.has(id) || !KIND_ID.test(id); n++) id = `${Array.from(base).slice(0, 36).join('').replace(/-+$/, '')}-${n}`
    ids.add(id)
    made.push({ id, name: nameFromFolder(f), folder: f, guidance: '', words: 800 })
  }
  const matched = saved.filter((k) => used.has(k.id)).map((k) => ({ ...k, folder: [...owner].find(([, o]) => o === k)![0] }))
  return [...matched, ...made]
}

/** A kind's name, "Unfiled" for a note in no kind's folder, or a readable one for a kind the list doesn't have. */
export const kindName = (kinds: readonly Kind[], id: string) => (id ? (findKind(kinds, id)?.name ?? id[0].toUpperCase() + id.slice(1)) : UNFILED_NAME)

/** "3 YT scripts", for counts. */
export const pieceName = (kinds: readonly Kind[], id: string, n: number) => {
  // Singular first, so a name saved before the word rules ("YT Scripts") still reads "a YT script", "3 YT scripts".
  const one = kindDisplayName(findKind(kinds, id)?.name ?? 'piece')
  // "Essay" reads "essay" mid-sentence; "LinkedIn post" and "YT script" keep their capitals.
  const noun = /^[A-Z][a-z]*(\s|$)/.test(one) ? one[0].toLowerCase() + one.slice(1) : one
  return n === 1 ? noun : plural(noun)
}

/**
 * How a help prompt describes the piece: "a LinkedIn post: short paragraphs, …". An Unfiled note,
 * or one of a kind the list doesn't have, is just "a piece of writing": never a pretend essay.
 */
export function describeKind(kinds: readonly Kind[], id?: string) {
  const k = id ? findKind(kinds, id) : undefined
  if (!k) return 'a piece of writing'
  const noun = pieceName(kinds, k.id, 1)
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a'
  return `${article} ${noun}${k.guidance ? `: ${k.guidance}` : ''}`
}

/**
 * The built-in kinds the writer doesn't have yet (Essay, LinkedIn post, Email…). They're only
 * offered: choosing one makes its folder, and so the kind.
 */
export const suggestedKinds = (kinds: readonly Kind[]) => DEFAULT_KINDS.filter((d) => !kinds.some((k) => k.id === d.id) && !kindTaken([...kinds], d.name))

/** "24 notes move with it.", for a rename that moves a folder (asked before it's done). */
export const notesMove = (n: number | undefined) => (n === undefined ? '' : n === 0 ? 'It has no notes yet.' : n === 1 ? '1 note moves with it.' : `${n} notes move with it.`)

// The app's copy of the list (the vault's kinds, from the server), set when it loads or changes.
// Empty in a vault with no folders yet: the built-in kinds are only suggestions then.
let current: Kind[] = []
export const setKinds = (kinds: Kind[] | undefined) => {
  current = kinds ?? []
}
export const kinds = () => current
/** The kinds a piece can be started as: the writer's, or with none yet, the suggestions (picking one makes its folder). */
export const offeredKinds = () => (current.length ? current : DEFAULT_KINDS)
