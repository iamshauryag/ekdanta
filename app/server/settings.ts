// Settings live in the vault (.ekdanta/settings.json), so every device that opens the vault
// shares them. Environment variables give the defaults. API keys are never stored here.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { META_DIR } from './vault.ts'

export type ProviderChoice = 'auto' | 'claude-cli' | 'anthropic-api' | 'ollama'

export interface Settings {
  /** Who answers ⌘2, ⌘4 and ⌘5 (and ⌘3, unless `wordLocal`). */
  provider: ProviderChoice
  /** Answer ⌘3 Word with the local model, when one is installed. */
  wordLocal: boolean
  claudeModel: string
  claudeFastModel: string
  ollamaModel: string
  embedder: 'builtin' | 'ollama'
  ceiling: number
  recallDot: boolean
  /** In Focus mode, dim every paragraph but the current one. */
  paragraphFocus: boolean
  theme: 'system' | 'light' | 'dark'
}

const env = process.env
export const DEFAULTS: Settings = {
  provider: 'auto',
  wordLocal: Boolean(env.EKDANTA_PREFER_LOCAL),
  claudeModel: env.EKDANTA_CLAUDE_MODEL ?? 'sonnet',
  claudeFastModel: env.EKDANTA_CLAUDE_FAST_MODEL ?? 'haiku',
  ollamaModel: env.EKDANTA_OLLAMA_MODEL ?? 'gemma4:12b',
  embedder: env.EKDANTA_EMBEDDER === 'ollama' ? 'ollama' : 'builtin',
  ceiling: 5,
  recallDot: true,
  paragraphFocus: true,
  theme: 'system',
}

const FILE = path.join(META_DIR, 'settings.json')
let current: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (current) return current
  try {
    current = { ...DEFAULTS, ...(JSON.parse(await fs.readFile(FILE, 'utf8')) as Partial<Settings>) }
  } catch {
    current = { ...DEFAULTS }
  }
  return current
}

/** The settings already loaded (or the defaults), for code that can't wait. */
export function settingsNow(): Settings {
  return current ?? DEFAULTS
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const prev = await loadSettings()
  const next: Settings = { ...prev }
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key in patch && typeof patch[key] === typeof DEFAULTS[key]) (next as unknown as Record<string, unknown>)[key] = patch[key]
  }
  next.ceiling = Math.max(0, Math.min(5, Math.round(next.ceiling)))
  current = next
  await fs.mkdir(META_DIR, { recursive: true })
  // Only what differs from the defaults is written, so the file stays short and readable.
  const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => DEFAULTS[k as keyof Settings] !== v))
  await fs.writeFile(FILE, JSON.stringify(diff, null, 2) + '\n', 'utf8')
  return next
}
