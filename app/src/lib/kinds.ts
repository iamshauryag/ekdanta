// Kinds of writing: Essay, LinkedIn post, Email and any the writer adds (a YouTube script, a letter).
// A piece's kind is its `platform` in front-matter. Each kind has a folder its pieces are filed in,
// a voice profile, a typical length, and a line on how it should read that the help levels follow.
// The list lives in the vault's settings; this module is shared by the app and the server.
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

export const kindId = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

export const plural = (noun: string) => (/(s|x|z|ch|sh)$/i.test(noun) ? noun + 'es' : /[^aeiou]y$/i.test(noun) ? noun.slice(0, -1) + 'ies' : noun + 's')

/** A new kind from just its name: "YT script" files its pieces in yt-scripts/. */
export function newKind(name: string, taken: Kind[]): Kind | null {
  name = name.trim().slice(0, 40)
  const base = kindId(name)
  if (!base) return null
  let id = base
  for (let n = 2; taken.some((k) => k.id === id); n++) id = `${base}-${n}`
  return { id, name, folder: kindFolder(plural(id)), guidance: '', words: 800 }
}

/**
 * A folder a kind can file into. Special folders (templates, journal, sources…) are left out of
 * Recall and voice, so a kind named "Template" or "Journal" files into my-templates/ or my-journal/
 * instead: its pieces are the writer's own and should count like any other.
 */
const kindFolder = (folder: string) => (isSpecialPath(folder) ? `my-${folder}` : folder)

/** Keep only well-formed kinds (settings come from a file the writer can edit). */
export function cleanKinds(value: unknown): Kind[] | null {
  if (!Array.isArray(value)) return null
  const out: Kind[] = []
  for (const k of value as Partial<Kind>[]) {
    if (!k || typeof k.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(k.id) || out.some((o) => o.id === k.id)) continue
    const name = typeof k.name === 'string' && k.name.trim() ? k.name.trim().slice(0, 40) : k.id
    const folder = kindFolder(kindId(typeof k.folder === 'string' ? k.folder : '') || plural(k.id))
    const guidance = typeof k.guidance === 'string' ? k.guidance.trim().slice(0, 400) : ''
    const words = Math.max(1, Math.min(50000, Math.round(Number(k.words) || 800)))
    const kind: Kind = { id: k.id, name, folder, guidance, words }
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

export const findKind = (kinds: Kind[], id: string) => kinds.find((k) => k.id === id.toLowerCase())

/** The kind a top-level folder holds: `emails` for email, say. Nested folders are the writer's own, and special folders (templates, journal…) hold no kind. */
export const kindOfFolder = (kinds: Kind[], folder: string) => {
  if (!folder || folder.includes('/') || isSpecialPath(folder)) return undefined
  const f = folder.toLowerCase()
  return kinds.find((k) => f === k.folder) ?? kinds.find((k) => f.startsWith(k.id))
}

/** A kind's name, or a readable one for a kind the list doesn't have (a piece from elsewhere). */
export const kindName = (kinds: Kind[], id: string) => findKind(kinds, id)?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : 'Piece')

/** "3 YT scripts", for counts. */
export const pieceName = (kinds: Kind[], id: string, n: number) => {
  const one = findKind(kinds, id)?.name ?? 'piece'
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
