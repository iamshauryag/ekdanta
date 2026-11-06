// Embeddings for Recall. By default a small model runs inside the app (no Ollama, nothing to
// install): bge-small-en-v1.5, ~33 MB, downloaded once on first use. Ollama is an option.
import path from 'node:path'
import { embed as ollamaEmbed } from './ai.ts'
import { settingsNow } from './settings.ts'

type Kind = 'document' | 'query'

interface Embedder {
  /** Stored with the index, so vectors from a different model are never mixed. */
  id: string
  embed(texts: string[], kind: Kind): Promise<number[][]>
  /** Below this, a match is noise. */
  floor: number
  /** At or above this, a match is strong enough to show the Recall dot. */
  strong: number
}

const BUILTIN_MODEL = 'Xenova/bge-small-en-v1.5'
// bge models expect this instruction on queries (not on documents).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
let extractor: Promise<Extractor> | null = null

function loadBuiltin(): Promise<Extractor> {
  if (!extractor) {
    extractor = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = process.env.EKDANTA_MODEL_CACHE ?? path.resolve('.cache', 'models')
      return (await pipeline('feature-extraction', BUILTIN_MODEL, { dtype: 'q8' })) as unknown as Extractor
    })()
    extractor.catch(() => (extractor = null)) // allow a retry after, say, a failed download
  }
  return extractor
}

const builtin: Embedder = {
  id: `builtin:${BUILTIN_MODEL}:q8`,
  floor: Number(process.env.EKDANTA_RECALL_FLOOR ?? 0.56),
  strong: 0.65,
  async embed(texts, kind) {
    const fe = await loadBuiltin()
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => (kind === 'query' ? QUERY_PREFIX + t : t))
      out.push(...(await fe(batch, { pooling: 'cls', normalize: true })).tolist())
    }
    return out
  },
}

const ollama: Embedder = {
  id: `ollama:${process.env.EKDANTA_EMBED_MODEL ?? 'nomic-embed-text'}`,
  floor: Number(process.env.EKDANTA_RECALL_FLOOR ?? 0.62),
  strong: 0.7,
  embed: (texts, kind) => ollamaEmbed(texts, kind),
}

/** The embedder chosen in Settings. Switching it rebuilds the Recall index. */
export function embedder(): Embedder {
  return settingsNow().embedder === 'ollama' ? ollama : builtin
}

/** Start loading the built-in model early, so the first ⌘1 doesn't wait for it. */
export function warmEmbedder() {
  if (embedder() === builtin) return loadBuiltin().then(() => undefined)
  return Promise.resolve()
}
