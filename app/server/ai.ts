// Model providers. Ollama runs locally; the Claude CLI reuses an existing Claude Code login;
// an Anthropic API key is the option for anyone without either.
import { spawnSync } from 'node:child_process'
import { askClaude } from './claude-pool.ts'

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.EKDANTA_OLLAMA_MODEL ?? 'gemma4:12b'
const EMBED_MODEL = process.env.EKDANTA_EMBED_MODEL ?? 'nomic-embed-text'
const CLAUDE_MODEL = process.env.EKDANTA_CLAUDE_MODEL ?? 'sonnet'
const CLAUDE_FAST_MODEL = process.env.EKDANTA_CLAUDE_FAST_MODEL ?? 'haiku'
const PREFER_LOCAL = Boolean(process.env.EKDANTA_PREFER_LOCAL)
const API_MODEL = process.env.EKDANTA_API_MODEL ?? 'claude-sonnet-5-5'

export type Provider = 'ollama' | 'claude-cli' | 'anthropic-api'

export interface Status {
  ollama: boolean
  ollamaModels: string[]
  claudeCli: boolean
  anthropicApi: boolean
  fast: Provider | null // used for ⌥3 Word
  strong: Provider | null // used for ⌥2, ⌥4, ⌥5
  models: { ollama: string; embed: string; claude: string; claudeFast: string }
}

let cliAvailable: boolean | null = null
function hasClaudeCli() {
  if (process.env.EKDANTA_DISABLE_CLAUDE_CLI) return false
  if (cliAvailable === null) {
    cliAvailable = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0
  }
  return cliAvailable
}

export async function status(): Promise<Status> {
  let models: string[] = []
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) })
    models = ((await r.json()) as { models: { name: string }[] }).models.map((m) => m.name)
  } catch {
    /* Ollama not running */
  }
  const ollama = models.length > 0
  const hasGen = models.some((m) => m.startsWith(OLLAMA_MODEL))
  const claudeCli = hasClaudeCli()
  const anthropicApi = Boolean(process.env.ANTHROPIC_API_KEY)
  // A signed-in CLI or an API key covers every level; a local model is optional.
  const strong: Provider | null = claudeCli ? 'claude-cli' : anthropicApi ? 'anthropic-api' : hasGen ? 'ollama' : null
  const fast: Provider | null = PREFER_LOCAL && hasGen ? 'ollama' : strong
  return {
    ollama,
    ollamaModels: models,
    claudeCli,
    anthropicApi,
    fast,
    strong,
    models: { ollama: OLLAMA_MODEL, embed: EMBED_MODEL, claude: CLAUDE_MODEL, claudeFast: CLAUDE_FAST_MODEL },
  }
}

export interface GenerateOptions {
  system: string
  prompt: string
  json?: boolean
  temperature?: number
  /** 'fast' for short, latency-sensitive requests (⌥3); 'strong' for the rest. */
  tier?: 'fast' | 'strong'
}

export async function generate(provider: Provider, opts: GenerateOptions): Promise<string> {
  if (provider === 'ollama') return ollamaChat(opts)
  if (provider === 'claude-cli') return claudeCli(opts)
  return anthropicApi(opts)
}

async function ollamaChat({ system, prompt, json, temperature = 0.5 }: GenerateOptions) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      ...(json ? { format: 'json' } : {}),
      options: { temperature },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!r.ok) throw new Error(`Ollama returned ${r.status}`)
  return ((await r.json()) as { message: { content: string } }).message.content
}

/** A request to a warm Claude Code session (see claude-pool.ts), with every tool disabled. */
function claudeCli({ system, prompt, json, tier }: GenerateOptions): Promise<string> {
  const [model, effort] = tier === 'fast' ? [CLAUDE_FAST_MODEL, 'low'] : [CLAUDE_MODEL, 'medium']
  return askClaude(model, effort, system + (json ? '\n\nRespond with JSON only, no prose and no code fences.' : ''), prompt)
}

async function anthropicApi({ system, prompt, temperature = 0.5 }: GenerateOptions) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: API_MODEL,
      max_tokens: 1024,
      temperature,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!r.ok) throw new Error(r.status === 401 ? 'Your API key was rejected' : `Anthropic API returned ${r.status}`)
  const data = (await r.json()) as { content: { type: string; text?: string }[] }
  return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
}

/** nomic-embed-text expects task prefixes on every input. */
export async function embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
  const prefix = kind === 'document' ? 'search_document: ' : 'search_query: '
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => prefix + t) }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`Embedding failed (${r.status})`)
  return ((await r.json()) as { embeddings: number[][] }).embeddings
}

/** Pull the first JSON object out of a model reply, tolerating stray prose or code fences. */
export function parseJson<T>(text: string): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('No JSON in reply')
  return JSON.parse(text.slice(start, end + 1)) as T
}
