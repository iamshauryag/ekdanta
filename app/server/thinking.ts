// The Thinking Space for a document: loose fragments on a canvas, stored as JSON Canvas
// (https://jsoncanvas.org) next to the draft, so Obsidian opens it too. What only Ekdanta
// needs (clusters, links the writer dismissed, Recall chips) lives in .ekdanta/thinking/.
// The model only links, groups and labels fragments. It never rewrites them.
import { promises as fs } from 'node:fs'
import path from 'node:path'
// The models and the Recall index are loaded only when a function needs them, so the canvas's own
// storage (read, write, seed) can be used, and tested, without them.
const ai = () => import('./ai.ts')
const embedderNow = async () => (await import('./embed.ts')).embedder()
import { adoptOldKey, readDoc, resolveInVault, splitFrontMatter, thinkingSideFile } from './vault.ts'

export interface Fragment {
  id: string
  text: string
}

interface Canvas {
  nodes: { id: string; type: string; text?: string; x: number; y: number; width: number; height: number }[]
  edges: { id: string; fromNode: string; toNode: string; label?: string }[]
}

const EMPTY_CANVAS: Canvas = { nodes: [], edges: [] }
const LABELS = ['same idea', 'contradicts', 'example of', 'leads to']

function canvasPath(doc: string) {
  if (!doc.endsWith('.md')) throw new Error('Not a document')
  return resolveInVault(doc.replace(/\.md$/, '.canvas'))
}
function sidePath(doc: string) {
  resolveInVault(doc)
  return thinkingSideFile(doc) // the path the sidecar registry moves with the document
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function readThinking(doc: string) {
  await adoptOldKey(doc)
  return {
    canvas: await readJson(canvasPath(doc), EMPTY_CANVAS),
    side: await readJson<Record<string, unknown>>(sidePath(doc), {}),
  }
}

export async function writeThinking(doc: string, canvas: Canvas, side: unknown) {
  await fs.access(resolveInVault(doc)) // only next to a document that exists
  await adoptOldKey(doc)
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
  const file = canvasPath(doc)
  // An empty Thinking Space leaves no file behind.
  if (!nodes.length) await fs.unlink(file).catch(() => {})
  else await fs.writeFile(file, JSON.stringify({ nodes, edges: canvas.edges ?? [] }, null, '\t') + '\n', 'utf8')
  const sp = sidePath(doc)
  await fs.mkdir(path.dirname(sp), { recursive: true })
  await fs.writeFile(sp, JSON.stringify(side ?? {}), 'utf8')
}

/**
 * Fill a new document's Thinking Space (Sparks' Start a piece): a fragment marked with its origin,
 * then quoted passages, each with a chip naming the note it came from. Only for an empty canvas.
 */
export async function seedThinking(doc: string, fragments: { text: string; mark?: string; from?: { doc: string; title: string; folder: string } }[]) {
  const { canvas } = await readThinking(doc)
  if (canvas.nodes.length) return
  const nodes: Canvas['nodes'] = []
  const recall: Record<string, { text: string; hit: { doc: string; title: string; folder: string } | null }> = {}
  const marks: Record<string, string> = {}
  const id = () => Math.random().toString(36).slice(2, 10)
  // A fragment's height before the canvas measures it, erring tall so long passages never overlap:
  // about one character per 8px, each line break starting a new line, plus room for the chip or mark
  // drawn with it.
  const height = (text: string, width: number, extra: number) => text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (width / 8))), 0) * 24 + 16 + extra
  let y = 96
  const heads = fragments.filter((f) => !f.from)
  const quotes = fragments.filter((f) => f.from)
  for (const f of heads) {
    const n = { id: id(), type: 'text', text: f.text, x: 120, y, width: 420, height: height(f.text, 420, f.mark ? 22 : 0) }
    nodes.push(n)
    if (f.mark) marks[n.id] = f.mark
    y += n.height + 48
  }
  // Quoted passages in two columns, each column stacking down the canvas.
  const col = [y, y]
  quotes.forEach((f, i) => {
    const c = i % 2
    const n = { id: id(), type: 'text', text: f.text, x: 120 + c * 360, y: col[c], width: 320, height: height(f.text, 320, 30) }
    nodes.push(n)
    recall[n.id] = { text: f.text, hit: f.from! }
    col[c] += n.height + 52
  })
  await writeThinking(doc, { nodes, edges: [] }, { recall, marks })
}

const usable = (fragments: Fragment[]) => fragments.filter((f) => f.id && f.text?.trim()).slice(0, 60)
const listFor = (fragments: Fragment[]) => fragments.map((f) => `${f.id}: ${f.text.replace(/\s+/g, ' ').trim()}`).join('\n')

/** Soft links between fragments that clearly relate. Few and certain beats many and loose. */
export async function suggestLinks(fragments: Fragment[], skip: string[] = []) {
  const frags = usable(fragments)
  if (frags.length < 3) return []
  const { generate, parseJson, status } = await ai()
  const { fast } = await status()
  if (!fast) return []
  const system = `A writer is brain-dumping fragments before drafting. Find the few clear relations between fragments.
Use only these labels: "same idea" (they say the same thing), "contradicts" (they pull against each other), "example of" (from is an example of to), "leads to" (from naturally leads to to).
Only link pairs where the relation is obvious. At most ${Math.max(2, Math.ceil(frags.length / 2))} links. Never rewrite or summarise fragments.
Return JSON: {"links": [{"from": "id", "to": "id", "label": "same idea"}]}`
  const raw = await generate(fast, { system, prompt: `Fragments (id: text):\n${listFor(frags)}`, json: true, temperature: 0.2, tier: 'fast' })
  const ids = new Set(frags.map((f) => f.id))
  const seen = new Set(skip)
  const out: { from: string; to: string; label: string }[] = []
  for (const l of parseJson<{ links: { from: string; to: string; label: string }[] }>(raw).links ?? []) {
    const key = [l.from, l.to].sort().join('|')
    if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to || !LABELS.includes(l.label) || seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/** Gather fragments into a few themes with one- or two-word labels. Misfits stay unclustered. */
export async function suggestClusters(fragments: Fragment[]) {
  const frags = usable(fragments)
  if (frags.length < 2) return []
  const { generate, parseJson, status } = await ai()
  const { fast } = await status()
  if (!fast) throw new Error('No model available to group fragments')
  const system = `A writer is brain-dumping fragments before drafting. Group them into 2 to 5 themes.
Label each theme with one or two lowercase words taken from the writer's own vocabulary where possible.
A fragment belongs to at most one theme; leave out fragments that fit no theme. Never rewrite fragments.
Return JSON: {"clusters": [{"label": "...", "ids": ["id", "..."]}]}`
  const raw = await generate(fast, { system, prompt: `Fragments (id: text):\n${listFor(frags)}`, json: true, temperature: 0.2, tier: 'fast' })
  const ids = new Set(frags.map((f) => f.id))
  const used = new Set<string>()
  return (parseJson<{ clusters: { label: string; ids: string[] }[] }>(raw).clusters ?? [])
    .map((c) => ({
      label: String(c.label ?? '')
        .toLowerCase()
        .split(/\s+/)
        .slice(0, 3)
        .join(' '),
      ids: (c.ids ?? []).filter((id) => ids.has(id) && !used.has(id) && used.add(id)),
    }))
    .filter((c) => c.label && c.ids.length)
}

/**
 * For each fragment, the writer's own note that matches it strongly, if any. A note is shown
 * once, on the fragment it matches best, so the canvas doesn't fill with the same chip.
 */
export async function recallChips(doc: string, fragments: Fragment[], taken: string[] = []) {
  const out: Record<string, { doc: string; title: string; folder: string } | null> = {}
  const best = new Map<string, { id: string; score: number; hit: { doc: string; title: string; folder: string } }>()
  const { search } = await import('./recall.ts')
  const bar = (await embedderNow()).strong + 0.04 // fragments are short, so they match loosely; ask for more
  for (const f of usable(fragments)) {
    out[f.id] = null
    const [hit] = await search(f.text, { exclude: doc, limit: 1, sources: false })
    if (!hit || hit.score < bar || taken.includes(hit.doc)) continue
    if ((best.get(hit.doc)?.score ?? 0) < hit.score) best.set(hit.doc, { id: f.id, score: hit.score, hit: { doc: hit.doc, title: hit.title, folder: hit.folder } })
  }
  for (const b of best.values()) out[b.id] = b.hit
  return out
}

// Fragment and paragraph vectors, so coverage checks while writing stay quick.
const vectors = new Map<string, number[]>()
async function vecs(texts: string[]) {
  const missing = [...new Set(texts.filter((t) => !vectors.has(t)))]
  if (missing.length) {
    const got = await (await embedderNow()).embed(missing, 'document')
    missing.forEach((t, i) => vectors.set(t, got[i]))
    if (vectors.size > 4000) [...vectors.keys()].slice(0, 2000).forEach((k) => vectors.delete(k))
  }
  return texts.map((t) => vectors.get(t)!)
}
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0) // vectors are normalised

/**
 * For the Material panel: which fragments the draft already covers, and which fragment is
 * closest to the paragraph being written (so its group can be the one that's open).
 */
export async function material(doc: string, fragments: Fragment[], paragraph: string) {
  const frags = usable(fragments)
  if (!frags.length) return { covered: [], nearest: null }
  const { body } = splitFrontMatter(await readDoc(doc))
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 20 && !p.startsWith('#'))
  // A short fragment can match one sentence closely and its whole paragraph only loosely, or
  // the other way round, so the draft is compared both ways.
  const sentences = paras.flatMap((p) => p.split(/(?<=[.!?])\s+/)).filter((s) => s.length >= 12)
  const fv = await vecs(frags.map((f) => f.text.trim()))
  const pv = await vecs([...new Set([...paras, ...sentences])])
  const COVERED = (await embedderNow()).id.startsWith('builtin') ? 0.78 : 0.8
  const covered = frags.filter((_, i) => pv.some((p) => dot(fv[i], p) >= COVERED)).map((f) => f.id)
  let nearest: string | null = null
  if (paragraph.trim().length >= 20) {
    const [cur] = await vecs([paragraph.trim()])
    let best = 0.55
    frags.forEach((f, i) => {
      const s = dot(fv[i], cur)
      if (s > best) [best, nearest] = [s, f.id]
    })
  }
  return { covered, nearest }
}
