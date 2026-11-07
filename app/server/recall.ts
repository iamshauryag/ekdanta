// Recall: semantic search over the writer's own paragraphs, using local embeddings.
// The index lives in .ekdanta/index.json and is always safe to delete.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { embedder } from './embed.ts'
import { META_DIR, listFiles, readDoc, splitFrontMatter, type FileEntry } from './vault.ts'
import { loadSettings } from './settings.ts'
import { isPromptParagraph, isSpecialPath } from '../src/lib/special.ts'
import { isBrainPath, locationText, parseHighlights, typeOf } from '../src/lib/brain.ts'

export interface Chunk {
  doc: string
  title: string
  folder: string
  platform?: string
  exemplar?: boolean
  text: string
  vec: number[]
  /** A highlight kept in the Brain: what kind of source it's from, and where in it. */
  sourceType?: string
  location?: string
}

// Bump when chunks gain a field, so an older index is rebuilt rather than half-filled.
// 3: templates' prompts and special folders are left out.
// 4: each highlight in the Brain is its own chunk, with its source type and location. Only a change to chunking should bump it again.
const INDEX_VERSION = 4

interface IndexFile {
  version?: number
  embedder: string // which model made the vectors
  files: Record<string, number> // path → mtime when indexed
  brain?: string // the Brain folder when indexed: its notes are chunked by highlight
  chunks: Chunk[]
}

const INDEX_PATH = path.join(META_DIR, 'index.json')
let index: IndexFile | null = null
let building: Promise<IndexFile> | null = null
let again: Promise<IndexFile> | null = null
let built = false

/** Has the index been brought up to date at least once since the server started (so a search by meaning is worth asking)? */
export const isReady = () => built

/** Paragraphs worth recalling: prose, not headings, lists of links, one-liners or a template's prompts. */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60 && !p.startsWith('#') && !p.startsWith('```') && !isPromptParagraph(p))
}

async function load(): Promise<IndexFile> {
  if (index && index.embedder === embedder().id && index.version === INDEX_VERSION) return index
  try {
    index = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8')) as IndexFile
  } catch {
    index = null
  }
  // Vectors from a different embedding model can't be compared: start again.
  if (!index || index.embedder !== embedder().id || index.version !== INDEX_VERSION) {
    index = { version: INDEX_VERSION, embedder: embedder().id, files: {}, chunks: [] }
  }
  return index
}

async function save(ix: IndexFile) {
  await fs.mkdir(META_DIR, { recursive: true })
  await fs.writeFile(INDEX_PATH, JSON.stringify(ix), 'utf8')
}

/** A Brain note's highlights worth recalling: each quote on its own, however short, as long as it says something. */
export function highlightChunks(body: string) {
  return parseHighlights(body)
    .map((h) => ({ text: h.text.replace(/\s+/g, ' ').trim(), location: h.location ? locationText(h.location) : undefined }))
    .filter((h) => h.text.length >= 25)
}

async function indexFile(ix: IndexFile, f: FileEntry, brain: string) {
  const { meta, body } = splitFrontMatter(await readDoc(f.path))
  // From the writer's own pages, their paragraphs; from the Brain, only the highlights they kept.
  const isSource = isBrainPath(f.path, brain)
  const items: { text: string; location?: string }[] = isSource ? highlightChunks(body) : paragraphs(body).map((text) => ({ text }))
  const sourceType = isSource ? typeOf(meta, f.path) : undefined
  ix.chunks = ix.chunks.filter((c) => c.doc !== f.path)
  for (let i = 0; i < items.length; i += 32) {
    const batch = items.slice(i, i + 32)
    const vecs = await embedder().embed(
      batch.map((b) => b.text),
      'document',
    )
    batch.forEach(({ text, location }, j) =>
      ix.chunks.push({
        doc: f.path,
        title: f.title,
        folder: f.folder,
        platform: f.platform,
        exemplar: f.exemplar && !isSource,
        text,
        vec: vecs[j],
        ...(isSource ? { sourceType, location } : {}),
      }),
    )
  }
  ix.files[f.path] = f.mtime
}

/**
 * Bring the index up to date with the vault: new, changed and deleted files. A refresh asked for
 * while one is running (after a save, or a change to the excluded folders) runs again once it ends,
 * so it sees what the running one may have missed.
 */
export function refresh(): Promise<IndexFile> {
  if (building) return (again ??= building.catch(() => {}).then(() => ((again = null), refresh())))
  building = (async () => {
    const ix = await load()
    // Templates, journals, sources and the writer's excluded folders aren't recalled; any already
    // indexed (from before they were excluded) are pruned below like deleted files.
    // The Brain's notes are the exception: their highlights are recalled, cited to the source.
    const { excludedFolders, brainFolder } = await loadSettings()
    const files = (await listFiles()).filter((f) => isBrainPath(f.path, brainFolder) || !isSpecialPath(f.path, excludedFolders))
    const live = new Set(files.map((f) => f.path))
    let changed = false
    // Another Brain folder changes how notes are chunked: index everything afresh.
    if ((ix.brain ?? 'brain') !== brainFolder) {
      ix.files = {}
      ix.chunks = []
      ix.brain = brainFolder
      changed = true
    }
    for (const p of Object.keys(ix.files)) {
      if (!live.has(p)) {
        delete ix.files[p]
        ix.chunks = ix.chunks.filter((c) => c.doc !== p)
        changed = true
      }
    }
    for (const f of files) {
      if (ix.files[f.path] !== f.mtime) {
        await indexFile(ix, f, brainFolder)
        changed = true
      }
    }
    if (changed) await save(ix)
    built = true
    return ix
  })().finally(() => (building = null))
  return building
}

/** Whether the index is being brought up to date, and its size so far: for views that wait on it. */
export function indexState() {
  return { building: !!building, docs: index ? Object.keys(index.files).length : 0, paragraphs: index?.chunks.length ?? 0 }
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
  exemplar: boolean
  sourceType?: string
  location?: string
}

/**
 * The chunks nearest a query. `sources: false` leaves out highlights from the Brain: other people's
 * words, which mustn't stand in for the writer's own voice.
 */
export async function search(query: string, opts: { exclude?: string; limit?: number; platform?: string; sources?: boolean } = {}): Promise<RecallResult[]> {
  const ix = await refresh()
  const [q] = await embedder().embed([query], 'query')
  const scored = ix.chunks
    .filter((c) => c.doc !== opts.exclude && (!opts.platform || c.platform === opts.platform) && (opts.sources !== false || !c.sourceType))
    .map((c) => ({
      doc: c.doc,
      title: c.title,
      folder: c.folder,
      text: c.text,
      exemplar: !!c.exemplar,
      score: cosine(q, c.vec),
      ...(c.sourceType ? { sourceType: c.sourceType, location: c.location } : {}),
    }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]?.score ?? 0
  // A strong result shouldn't be padded out with weak ones.
  const cut = Math.max(embedder().floor, best - 0.12)
  return scored.filter((r) => r.score >= cut).slice(0, opts.limit ?? 9)
}
