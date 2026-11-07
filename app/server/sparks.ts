// Sparks' logic, apart from the vault and the models so it can be tested on its own: pairing
// passages in a similarity band, keeping the pairs varied, and checking what the model cites.
// The run itself (reading the index, asking the model, keeping and starting) is in sparks-run.ts.
import { createHash } from 'node:crypto'

export interface Passage {
  /** Stable across runs: a hash of the note and the passage's text, so a dismissal outlives a re-index. */
  id: string
  doc: string
  title: string
  folder: string
  platform?: string
  text: string
  vec: number[]
}

/** Two or three passages from different notes that seem to belong together. */
export interface Group {
  ids: string[]
  score: number
}

/**
 * A passage's id: its note and its text. The note is part of it so the same paragraph pasted into
 * two notes stays two passages, each citing the note it is really in.
 */
export const passageId = (doc: string, text: string) =>
  createHash('sha1')
    .update(`${doc}\n${text.replace(/\s+/g, ' ').trim()}`)
    .digest('hex')
    .slice(0, 12)
/** The most passages one spark may cite: enough for a real connection, few enough to read. */
export const MAX_SOURCES = 6
/** A spark's key as the API accepts it: two to MAX_SOURCES passage ids. */
export const SPARK_KEY = new RegExp(`^[0-9a-f]{12}(\\|[0-9a-f]{12}){1,${MAX_SOURCES - 1}}$`)
/** What a spark is remembered by: its passages, in a fixed order. */
export const keyOf = (ids: string[]) => [...new Set(ids)].sort().join('|')

export function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * For each seed passage, partners from other notes whose similarity sits in the band: close enough
 * to be about the same thing, not so close that they say it twice. Partners from another folder or
 * kind are preferred, since those are the connections the writer is least likely to have made.
 * The two best partners from two further notes make a triad when they also relate to each other.
 */
export function candidateGroups(seeds: Passage[], pool: Passage[], band: { lo: number; hi: number }, perSeed = 3): Group[] {
  const out = new Map<string, Group>()
  const add = (ids: string[], score: number) => {
    const key = keyOf(ids)
    if ((out.get(key)?.score ?? -Infinity) < score) out.set(key, { ids: key.split('|'), score })
  }
  for (const seed of seeds) {
    const best = new Map<string, { p: Passage; sim: number; score: number }>() // one partner per note
    for (const p of pool) {
      if (p.doc === seed.doc || p.id === seed.id) continue
      const sim = cosine(seed.vec, p.vec)
      if (sim < band.lo || sim > band.hi) continue
      const score = sim + (p.folder !== seed.folder ? 0.04 : 0) + ((p.platform ?? '') !== (seed.platform ?? '') ? 0.02 : 0)
      if ((best.get(p.doc)?.score ?? -Infinity) < score) best.set(p.doc, { p, sim, score })
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, perSeed)
    for (const r of ranked) add([seed.id, r.p.id], r.score)
    if (ranked.length >= 2) {
      const [a, b] = ranked
      const ab = cosine(a.p.vec, b.p.vec)
      if (ab >= band.lo && ab <= band.hi) add([seed.id, a.p.id, b.p.id], (a.score + b.score + ab) / 3)
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score)
}

function centroid(ids: string[], vec: (id: string) => number[]) {
  const vs = ids.map(vec)
  return vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
}

/**
 * Maximal marginal relevance: take the best group, then keep taking the group that is good and
 * least like the ones already taken, so the result covers several ideas, not one idea six times.
 * Groups sharing a passage, or the same pair of notes, are repeats and are left out.
 */
export function mmr(groups: Group[], vec: (id: string) => number[], docOf: (id: string) => string, k: number, lambda = 0.7): Group[] {
  const left = groups.map((g) => ({ g, c: centroid(g.ids, vec), docs: new Set(g.ids.map(docOf)) }))
  const picked: typeof left = []
  while (picked.length < k && left.length) {
    let bestI = -1
    let bestV = -Infinity
    left.forEach((cand, i) => {
      const redundancy = picked.reduce((m, p) => {
        const shares = cand.g.ids.some((id) => p.g.ids.includes(id))
        const sameDocs = [...cand.docs].filter((d) => p.docs.has(d)).length >= 2
        return Math.max(m, shares || sameDocs ? 1 : cosine(cand.c, p.c))
      }, 0)
      if (redundancy >= 1) return // a repeat of one already taken: never shown twice
      const v = lambda * cand.g.score - (1 - lambda) * redundancy
      if (v > bestV) [bestV, bestI] = [v, i]
    })
    if (bestI < 0) break
    picked.push(left.splice(bestI, 1)[0])
  }
  return picked.map((p) => p.g)
}

/** A set of passages the writer has already kept or dismissed, or one that contains or is contained by it. */
export function seenBefore(ids: string[], seen: string[][]) {
  const mine = new Set(ids)
  return seen.some((s) => s.length > 0 && (s.every((id) => mine.has(id)) || ids.every((id) => s.includes(id))))
}

export interface Spark {
  key: string
  title: string
  angle: string
  why: string
  suits?: string
  ids: string[]
}

/** The longest title kept whole: the model is asked for ten words and sometimes needs a few more. */
const TITLE_WORDS = 14
// Words a cut title must not end on: it would stop mid-phrase ("…the day, or the").
const DANGLING = new Set(
  'a an the and or but nor of to in on at by for from with into onto as than that which who whose whom is are was were be its their his her my our your this these those'.split(' '),
)

/**
 * A title short enough for a list line and a file name, cut only where a phrase ends. Up to
 * TITLE_WORDS words it is kept as written. Longer, it ends at the last clause break (a colon, dash,
 * comma or question mark) that leaves at least three words; failing that, at TITLE_WORDS words with
 * any dangling small words taken off the end, so it never stops on "the" or "or".
 */
export function shortTitle(title: string) {
  const all = title.split(/\s+/).filter(Boolean)
  if (all.length <= TITLE_WORDS) return all.join(' ')
  const head = all.slice(0, TITLE_WORDS)
  for (let i = head.length - 1; i >= 2; i--) {
    if (/[:;,?!—–]$/.test(head[i]) || head[i + 1] === '—' || head[i + 1] === '–' || head[i + 1] === '-')
      return head
        .slice(0, i + 1)
        .join(' ')
        .replace(/[:;,—–]$/, '')
  }
  while (head.length > 3 && DANGLING.has(head[head.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ''))) head.pop()
  return head.join(' ').replace(/[:;,—–-]$/, '')
}
export const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/**
 * The model's reply, checked: citations it made up are dropped, and so is any spark that leans on
 * one note only (that's a summary, not a connection). At most five sparks, each citing at most
 * MAX_SOURCES passages; titles cut only where a phrase ends (shortTitle).
 */
export function validateSparks(raw: unknown, labels: Map<string, Passage>, kindIds: string[]): Spark[] {
  const list = (raw as { sparks?: unknown })?.sparks
  if (!Array.isArray(list)) return []
  const out: Spark[] = []
  const keys = new Set<string>()
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    const title = shortTitle(clean(r.title).replace(/^["“]|["”]$/g, ''))
    const angle = clean(r.angle)
    if (!title || !angle) continue
    const cited = (Array.isArray(r.sources) ? r.sources : []).map((x) => labels.get(String(x).trim())).filter((p): p is Passage => !!p)
    // The first MAX_SOURCES distinct passages it cites; past that it isn't one connection any more.
    const picked = [...new Map(cited.map((p) => [p.id, p])).values()].slice(0, MAX_SOURCES)
    const ids = picked.map((p) => p.id)
    if (new Set(picked.map((p) => p.doc)).size < 2) continue
    const key = keyOf(ids)
    if (keys.has(key)) continue
    keys.add(key)
    const suits = clean(r.suits)
    out.push({ key, title, angle, why: clean(r.why), suits: kindIds.includes(suits) ? suits : undefined, ids: key.split('|') })
    if (out.length === 5) break
  }
  return out
}

/** A new line for the kept list, after whatever the writer has there: nothing already written is changed. */
export function appendBullet(existing: string, bullet: string) {
  if (!existing.trim()) return `# Sparks\n\n${bullet}\n`
  let text = existing.endsWith('\n') ? existing : existing + '\n'
  const last = text.trimEnd().split('\n').pop() ?? ''
  // Straight after a list it continues the list; after anything else it starts one.
  if (!/^\s*([-*+]|\d+[.)])\s/.test(last) && !text.endsWith('\n\n')) text += '\n'
  return text + bullet + '\n'
}

/** A random sample, with the ones that must be in it kept. */
export function sample<T>(items: T[], n: number, keep: (t: T) => boolean = () => false, rand = Math.random): T[] {
  if (items.length <= n) return items
  const must = items.filter(keep)
  const rest = items.filter((t) => !keep(t))
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return [...must, ...rest].slice(0, Math.max(n, must.length))
}
