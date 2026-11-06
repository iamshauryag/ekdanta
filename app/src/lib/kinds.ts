// Kinds of writing: Essay, LinkedIn post, Email and any the writer adds (a YouTube script, a letter).
// A piece's kind is its `platform` in front-matter. Each kind has a folder its pieces are filed in,
// a voice profile, a typical length, and a line on how it should read that the help levels follow.
// The list lives in the vault's settings; this module is shared by the app and the server.

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
  return { id, name, folder: plural(id), guidance: '', words: 800 }
}

/** Keep only well-formed kinds (settings come from a file the writer can edit). */
export function cleanKinds(value: unknown): Kind[] | null {
  if (!Array.isArray(value)) return null
  const out: Kind[] = []
  for (const k of value as Partial<Kind>[]) {
    if (!k || typeof k.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(k.id) || out.some((o) => o.id === k.id)) continue
    const name = typeof k.name === 'string' && k.name.trim() ? k.name.trim().slice(0, 40) : k.id
    const folder = kindId(typeof k.folder === 'string' ? k.folder : '') || plural(k.id)
    const guidance = typeof k.guidance === 'string' ? k.guidance.trim().slice(0, 400) : ''
    const words = Math.max(1, Math.min(50000, Math.round(Number(k.words) || 800)))
    out.push({ id: k.id, name, folder, guidance, words })
  }
  return out.length ? out : null
}

export const findKind = (kinds: Kind[], id: string) => kinds.find((k) => k.id === id.toLowerCase())

/** The kind a top-level folder holds: `emails` for email, say. Nested folders are the writer's own. */
export const kindOfFolder = (kinds: Kind[], folder: string) => {
  if (!folder || folder.includes('/')) return undefined
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
