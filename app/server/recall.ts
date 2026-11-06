// Recall: semantic search over the writer's own paragraphs, using local embeddings.
// The index lives in .ekdanta/index.json and is always safe to delete.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { embedder } from './embed.ts'
import { META_DIR, listFiles, readDoc, splitFrontMatter, type FileEntry } from './vault.ts'

interface Chunk {
  doc: string
  title: string
  folder: string
  platform?: string
  text: string
  vec: number[]
}

interface IndexFile {
  embedder: string // which model made the vectors
  files: Record<string, number> // path → mtime when indexed
  chunks: Chunk[]
}

const INDEX_PATH = path.join(META_DIR, 'index.json')
let index: IndexFile | null = null
let building: Promise<IndexFile> | null = null

/** Paragraphs worth recalling: prose, not headings, lists of links or one-liners. */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60 && !p.startsWith('#') && !p.startsWith('```'))
}

async function load(): Promise<IndexFile> {
  if (index) return index
  try {
    index = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8')) as IndexFile
  } catch {
    index = null
  }
  // Vectors from a different embedding model can't be compared: start again.
  if (!index || index.embedder !== embedder.id) index = { embedder: embedder.id, files: {}, chunks: [] }
  return index
}

async function save(ix: IndexFile) {
  await fs.mkdir(META_DIR, { recursive: true })
  await fs.writeFile(INDEX_PATH, JSON.stringify(ix), 'utf8')
}

async function indexFile(ix: IndexFile, f: FileEntry) {
  const { body } = splitFrontMatter(await readDoc(f.path))
  const paras = paragraphs(body)
  ix.chunks = ix.chunks.filter((c) => c.doc !== f.path)
  for (let i = 0; i < paras.length; i += 32) {
    const batch = paras.slice(i, i + 32)
    const vecs = await embedder.embed(batch, 'document')
    batch.forEach((text, j) =>
      ix.chunks.push({ doc: f.path, title: f.title, folder: f.folder, platform: f.platform, text, vec: vecs[j] }),
    )
  }
  ix.files[f.path] = f.mtime
}

/** Bring the index up to date with the vault: new, changed and deleted files. */
export function refresh(): Promise<IndexFile> {
  if (building) return building
  building = (async () => {
    const ix = await load()
    const files = await listFiles()
    const live = new Set(files.map((f) => f.path))
    let changed = false
    for (const p of Object.keys(ix.files)) {
      if (!live.has(p)) {
        delete ix.files[p]
        ix.chunks = ix.chunks.filter((c) => c.doc !== p)
        changed = true
      }
    }
    for (const f of files) {
      if (ix.files[f.path] !== f.mtime) {
        await indexFile(ix, f)
        changed = true
      }
    }
    if (changed) await save(ix)
    return ix
  })().finally(() => (building = null))
  return building
}

function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RecallResult {
  doc: string
  title: string
  folder: string
  text: string
  score: number
}

export async function search(query: string, opts: { exclude?: string; limit?: number; platform?: string } = {}) {
  const ix = await refresh()
  const [q] = await embedder.embed([query], 'query')
  const scored = ix.chunks
    .filter((c) => c.doc !== opts.exclude && (!opts.platform || c.platform === opts.platform))
    .map((c) => ({ doc: c.doc, title: c.title, folder: c.folder, text: c.text, score: cosine(q, c.vec) }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]?.score ?? 0
  // A strong result shouldn't be padded out with weak ones.
  const cut = Math.max(embedder.floor, best - 0.12)
  return scored.filter((r) => r.score >= cut).slice(0, opts.limit ?? 9)
}
