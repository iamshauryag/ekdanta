// Sparks: ideas that span the writer's notes. Only on request, never in the background.
// Passages from different notes that sit near each other (but aren't the same thought restated)
// are paired from the Recall index; a model, when there is one, proposes a few angles that join
// them, citing the passages. Every citation is checked in code, and anything the writer kept or
// dismissed is never shown again (.ekdanta/sparks.json).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { generate, parseJson, status } from './ai.ts'
import { embedder } from './embed.ts'
import { HttpError } from './net.ts'
import { refresh, type Chunk } from './recall.ts'
import { kindFor, offeredKinds, vaultKinds } from './kinds.ts'
import { seedThinking } from './thinking.ts'
import { writeBrief } from './brief.ts'
import { META_DIR, createDoc, listFiles, nameDoc, readDoc, writeDoc } from './vault.ts'
import { joinDoc, patchFrontMatter, splitFrontMatter } from '../src/lib/frontmatter.ts'
import { MAX_SOURCES, SPARK_KEY, candidateGroups, clean, cosine, keyOf, mmr, passageId, sample, seenBefore, shortTitle, validateSparks, appendBullet, type Passage, type Spark } from './sparks.ts'

/** Where kept sparks are written, as a plain list the writer can edit. */
export const IDEAS_PATH = 'ideas/sparks.md'
const STORE_PATH = path.join(META_DIR, 'sparks.json')
const MAX_POOL = 2000 // passages compared per run, so a large vault stays quick
const MAX_SEEDS = 24
const MAX_GROUPS = 8 // pairs or triads offered to the model (or shown without one)

// ---- What the writer kept and dismissed -------------------------------------------------------

interface Remembered {
  key: string
  title?: string
  at: string
}
interface Store {
  kept: Remembered[]
  dismissed: Remembered[]
}

async function readStore(): Promise<Store> {
  try {
    const s = JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) as Partial<Store>
    return { kept: Array.isArray(s.kept) ? s.kept : [], dismissed: Array.isArray(s.dismissed) ? s.dismissed : [] }
  } catch {
    return { kept: [], dismissed: [] }
  }
}

// Writes to the store wait their turn, so two quick clicks (Keep, then Dismiss) can't each read the
// old list and the second write drop the first's entry.
let storeQueue: Promise<unknown> = Promise.resolve()

function remember(which: keyof Store, key: string, title?: string) {
  const next = storeQueue.then(async () => {
    const s = await readStore()
    if (!s[which].some((r) => r.key === key)) s[which].push({ key, ...(title ? { title } : {}), at: new Date().toISOString() })
    await fs.mkdir(META_DIR, { recursive: true })
    // Whole and atomic: a crash mid-write never leaves half a file that reads as "nothing seen".
    const tmp = `${STORE_PATH}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(s, null, 1) + '\n', 'utf8')
    await fs.rename(tmp, STORE_PATH)
  })
  storeQueue = next.catch(() => {})
  return next
}

const seenKeys = (s: Store) => [...s.kept, ...s.dismissed].map((r) => r.key.split('|'))

// ---- A run ------------------------------------------------------------------------------------

export type Seed =
  { kind: 'piece'; doc: string } | { kind: 'topic'; topic: string } | { kind: 'folder'; folder: string } | { kind: 'tag'; tag: string } | { kind: 'surprise' } | { kind: 'like'; ids: string[] }

export interface SparkRequest {
  seed: Seed
  /** Only sparks that suit this kind of writing. */
  suits?: string
  /** Groups not to offer again this time (the cards on screen, for More like this). */
  exclude?: string[]
  /** False to skip the model and show related passages only. */
  model?: boolean
}

export interface Source {
  id: string
  doc: string
  title: string
  folder: string
  text: string
}
export interface Card {
  key: string
  title?: string
  angle?: string
  why?: string
  suits?: string
  sources: Source[]
}
export interface SparkResult {
  /** 'sparks': the model's ideas; 'pairs': passages that seem related, without a model. */
  mode: 'sparks' | 'pairs'
  cards: Card[]
  /** Why there's nothing to show, or why it fell back to passages. */
  message?: string
  note?: string
}

const toPassage = (c: Chunk): Passage => ({ id: passageId(c.doc, c.text), doc: c.doc, title: c.title, folder: c.folder, platform: c.platform, text: c.text, vec: c.vec })
const source = (p: Passage): Source => ({ id: p.id, doc: p.doc, title: p.title, folder: p.folder, text: p.text })

/** The tags a note carries: `tags:` in its front matter and #tags in its text. */
function tagsOf(raw: string) {
  const { meta, body } = splitFrontMatter(raw)
  const fm = (meta.tags ?? '')
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').trim().toLowerCase())
  const inline = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1].toLowerCase())
  return new Set([...fm, ...inline].filter((t) => t && !/^\d+$/.test(t)))
}

/** Folders and tags the writer can start from. */
export async function sparkOptions() {
  const ix = await refresh()
  const docs = [...new Set(ix.chunks.filter((c) => c.doc !== IDEAS_PATH).map((c) => c.doc))]
  const folders = [...new Set(docs.map((d) => d.split('/').slice(0, -1).join('/')).filter(Boolean))].sort()
  const tags = new Set<string>()
  for (const d of docs) for (const t of tagsOf(await readDoc(d).catch(() => ''))) tags.add(t)
  return { docs: docs.length, folders, tags: [...tags].sort() }
}

async function seedPassages(seed: Seed, all: Passage[]): Promise<Passage[] | string> {
  switch (seed.kind) {
    case 'piece': {
      const mine = all.filter((p) => p.doc === seed.doc)
      return mine.length ? mine : 'This piece has no paragraphs long enough to connect yet. Write a few, or pick another seed.'
    }
    case 'topic': {
      const topic = seed.topic.trim()
      if (!topic) return 'Type a topic to start from.'
      const [q] = await embedder().embed([topic], 'query')
      const scored = all.map((p) => ({ p, s: cosine(q, p.vec) })).sort((a, b) => b.s - a.s)
      if (!scored.length || scored[0].s < embedder().floor - 0.04) return 'Nothing in your notes is close to that topic yet.'
      return scored.slice(0, 6).map((x) => x.p)
    }
    case 'folder': {
      const f = seed.folder.replace(/^\/+|\/+$/g, '')
      const mine = all.filter((p) => p.doc.startsWith(f + '/'))
      return mine.length ? mine : `Nothing in ${f}/ has paragraphs long enough to connect.`
    }
    case 'tag': {
      const tag = seed.tag.replace(/^#/, '').trim().toLowerCase()
      const docs = new Set<string>()
      for (const d of new Set(all.map((p) => p.doc))) if (tagsOf(await readDoc(d).catch(() => '')).has(tag)) docs.add(d)
      const mine = all.filter((p) => docs.has(p.doc))
      return mine.length ? mine : `No notes tagged #${tag} have paragraphs long enough to connect.`
    }
    case 'surprise': {
      // The notes touched most recently: what's on the writer's mind.
      const indexed = new Set(all.map((p) => p.doc))
      const recent = (await listFiles())
        .filter((f) => indexed.has(f.path))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)
        .map((f) => f.path)
      return all.filter((p) => recent.includes(p.doc))
    }
    case 'like': {
      const ids = new Set(seed.ids)
      const mine = all.filter((p) => ids.has(p.id))
      return mine.length ? mine : 'Those passages have changed since; try another seed.'
    }
  }
}

const SYSTEM = `You help a writer find ideas that connect their own notes. You get groups of passages from different notes that seem related.
Propose up to 5 sparks: new ideas that only appear when two or more of the notes are read together.
Each spark: "title" (at most 10 words), "angle" (one sentence: a claim or a question the writer could write about), "why" (one short sentence on what joins the passages), "sources" (the ids of the passages it draws on, from at least two different notes), "suits" (the id of the kind of writing it would make best).
Never write draft prose, openings or outlines. Never invent passages or ids. Prefer surprising connections over obvious ones, and skip a group with no real idea in it.
Return JSON: {"sparks": [{"title": "...", "angle": "...", "why": "...", "sources": ["p1", "p2"], "suits": "essay"}]}`

const str = (v: unknown) => typeof v === 'string'

/** A request's seed, checked: anything else is the caller's mistake (400), not the server's. */
function checkSeed(seed: unknown): Seed {
  const s = (seed ?? {}) as Record<string, unknown>
  const ok =
    (s.kind === 'piece' && str(s.doc)) ||
    (s.kind === 'topic' && str(s.topic)) ||
    (s.kind === 'folder' && str(s.folder)) ||
    (s.kind === 'tag' && str(s.tag)) ||
    s.kind === 'surprise' ||
    (s.kind === 'like' && Array.isArray(s.ids) && s.ids.length > 0 && s.ids.length <= MAX_SOURCES && s.ids.every(str))
  if (!ok) throw new HttpError(400, 'Not a Sparks seed')
  return s as unknown as Seed
}

/** Run Sparks for a seed. Callers check the help ceiling first; this only reads the vault and asks the model. */
export async function runSparks(body: SparkRequest): Promise<SparkResult> {
  const req: SparkRequest = {
    seed: checkSeed(body?.seed),
    suits: str(body?.suits) && body.suits ? body.suits : undefined,
    exclude: Array.isArray(body?.exclude) ? body.exclude.filter((k) => str(k) && SPARK_KEY.test(k)) : [],
    model: body?.model,
  }
  const ix = await refresh() // special folders and template prompts are already left out
  const all = ix.chunks.filter((c) => c.doc !== IDEAS_PATH).map(toPassage)
  if (new Set(all.map((p) => p.doc)).size < 2) return { mode: 'pairs', cards: [], message: 'Sparks needs at least two notes with text.' }

  const found = await seedPassages(req.seed, all)
  if (typeof found === 'string') return { mode: 'pairs', cards: [], message: found }
  const seeds = sample(found, req.seed.kind === 'like' ? found.length : MAX_SEEDS)
  const seedIds = new Set(seeds.map((s) => s.id))
  const pool = sample(all, MAX_POOL, (p) => seedIds.has(p.id))

  const e = embedder()
  const groups = candidateGroups(seeds, pool, { lo: e.floor, hi: e.strong + 0.08 })
  const store = await readStore()
  const seen = [...seenKeys(store), ...(req.exclude ?? []).map((k) => k.split('|'))]
  const fresh = groups.filter((g) => !seenBefore(g.ids, seen))
  if (!fresh.length) return { mode: 'pairs', cards: [], message: groups.length ? 'Nothing new here, try another seed.' : 'No passages in other notes connect to this seed yet. Try another seed.' }

  const byId = new Map(pool.map((p) => [p.id, p]))
  const chosen = mmr(
    fresh,
    (id) => byId.get(id)!.vec,
    (id) => byId.get(id)!.doc,
    MAX_GROUPS,
  )
  const pairs: SparkResult = { mode: 'pairs', cards: chosen.map((g) => ({ key: keyOf(g.ids), sources: g.ids.map((id) => source(byId.get(id)!)) })) }

  const { strong } = await status()
  if (req.model === false || !strong) return pairs

  const kinds = await offeredKinds()
  const labels = new Map<string, Passage>()
  const lines = chosen.map((g, i) => {
    const ps = g.ids.map((id) => {
      const p = byId.get(id)!
      const label = `p${labels.size + 1}`
      labels.set(label, p)
      return `${label} (note "${p.title}", ${p.folder || 'top level'}): ${p.text.replace(/\s+/g, ' ').slice(0, 700)}`
    })
    return `Group ${i + 1}:\n${ps.join('\n')}`
  })
  const kindLine = kinds.map((k) => `${k.id} (${k.name})`).join(', ')
  const want = req.suits ? `\nEvery spark must suit "${req.suits}".` : ''
  let sparks: Spark[] = []
  try {
    const raw = await generate(strong, { system: SYSTEM, prompt: `Kinds of writing: ${kindLine}${want}\n\n${lines.join('\n\n')}`, json: true, temperature: 0.9, tier: 'strong' })
    sparks = validateSparks(
      parseJson(raw),
      labels,
      kinds.map((k) => k.id),
    )
  } catch (err) {
    return { ...pairs, note: `The model didn't answer (${(err as Error).message}), so here are the passages that seem related.` }
  }
  sparks = sparks.filter((s) => !seenBefore(s.ids, seen)).map((s) => (req.suits ? { ...s, suits: s.suits ?? req.suits } : s))
  if (req.suits) sparks = sparks.filter((s) => s.suits === req.suits)
  if (!sparks.length) return { ...pairs, note: 'The model found nothing that joins two notes, so here are the passages that seem related.' }
  const passages = new Map([...labels.values()].map((p) => [p.id, p]))
  return {
    mode: 'sparks',
    cards: sparks.map((s) => ({ key: s.key, title: s.title, angle: s.angle, why: s.why, suits: s.suits, sources: s.ids.map((id) => source(passages.get(id)!)) })),
  }
}

// ---- Acting on a card -------------------------------------------------------------------------

/** Check a card against the index, so a request can only cite passages that exist. */
async function verify(card: { key: string; sources: { id: string }[] }) {
  const ix = await refresh()
  const byId = new Map(ix.chunks.map((c) => [passageId(c.doc, c.text), c]))
  const asked = Array.isArray(card.sources) ? card.sources.slice(0, MAX_SOURCES) : []
  const sources = asked.map((s) => byId.get(s?.id)).filter((c): c is Chunk => !!c)
  if (new Set(sources.map((c) => c.doc)).size < 2) throw new HttpError(409, 'These passages have changed since; run Sparks again.')
  return sources.map(toPassage)
}

/** How a note is linked: its file name, as Obsidian does, or its path when two notes share a name. */
async function linkTarget(doc: string) {
  const name = doc.replace(/\.md$/, '').split('/').pop()!
  const clash = (await listFiles()).filter((f) => f.path.replace(/\.md$/, '').split('/').pop() === name).length > 1
  return clash ? doc.replace(/\.md$/, '') : name
}

/** A card the client sent back, checked before anything is written. */
function checkCard(card: { key: string } | undefined) {
  if (!str(card?.key) || !SPARK_KEY.test(card!.key)) throw new HttpError(400, 'Not a spark')
}

export async function dismissSpark(key: string) {
  checkCard({ key })
  await remember('dismissed', key)
}

/** Keep a spark: one bullet added to the end of ideas/sparks.md, and it isn't offered again. */
export async function keepSpark(card: { key: string; title?: string; angle?: string; sources: { id: string }[] }) {
  checkCard(card)
  const passages = await verify(card)
  const docs = [...new Set(passages.map((p) => p.doc))]
  const links = (await Promise.all(docs.map(linkTarget))).map((t) => `[[${t}]]`).join(', ')
  const title = shortTitle(clean(card.title))
  const angle = clean(card.angle)
  const bullet = title ? `- **${title}** — ${angle} (${links})` : `- These passages seem related (${links})`
  // Only a missing file starts a new list: any other failure to read it must not overwrite it.
  const existing = await readDoc(IDEAS_PATH).catch((e: NodeJS.ErrnoException) => {
    if (e?.code === 'ENOENT') return ''
    throw e
  })
  await writeDoc(IDEAS_PATH, appendBullet(existing, bullet), { reason: 'sparks' })
  await remember('kept', card.key, title || undefined)
  refresh().catch(() => {})
  return { path: IDEAS_PATH, bullet }
}

/**
 * Start a piece from a spark: a new document of the chosen kind whose body stays empty (even if
 * the kind has a template), with the passages and the spark's angle waiting in its Thinking Space
 * and a brief pinned from the spark.
 */
export async function startPiece(card: { key: string; title?: string; angle?: string; why?: string; sources: { id: string }[] }, kindId?: string) {
  checkCard(card)
  const passages = await verify(card)
  // In the chosen kind's folder, made now if it's a suggestion; with no kind, Unfiled at the top of the vault.
  const kind = typeof kindId === 'string' && kindId ? await kindFor(kindId) : undefined
  const created = await createDoc(await vaultKinds(), '', { kind: kind?.id })
  const fm = splitFrontMatter(await readDoc(created))
  const title = shortTitle(clean(card.title))
  const docs = [...new Set(passages.map((p) => p.doc))]
  await writeDoc(created, joinDoc({ ...patchFrontMatter(fm, { title, 'sparked-from': docs.join(', ') }), body: '' }), { reason: 'sparks' })
  const rel = title ? await nameDoc(created, title) : created
  const angle = clean(card.angle)
  await seedThinking(rel, [...(angle ? [{ text: angle, mark: 'Spark' }] : []), ...passages.map((p) => ({ text: p.text, from: { doc: p.doc, title: p.title, folder: p.folder } }))])
  // A pinned brief from the spark, as a piece started from an idea gets: what it is, its angle, where it came from.
  const why = clean(card.why)
  const from = [...new Map(passages.map((p) => [p.doc, p])).values()].map((p) => `[[${p.doc.replace(/\.md$/, '')}|${p.title.replace(/[\]|[]/g, '') || p.doc}]]`)
  await writeBrief(rel, [title && `Idea: ${title}`, angle && `Angle: ${angle}`, why && `Why: ${why}`, `From: ${from.join(', ')}`].filter(Boolean).join('\n'))
  refresh().catch(() => {})
  return { path: rel }
}
