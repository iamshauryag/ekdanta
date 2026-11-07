// Settings live in the vault (.ekdanta/settings.json), so every device that opens the vault
// shares them. Environment variables give the defaults. API keys are never stored here.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { META_DIR, VAULT } from './paths.ts'
import { cleanKinds, DEFAULT_KINDS, doubledFolder, type Kind } from '../src/lib/kinds.ts'

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
  /** Shortcuts the writer changed: command id → key in CodeMirror's notation ('' to unbind). */
  keys: Record<string, string>
  /** Kinds of writing: the built-in ones, as the writer edited them, and any they added. */
  kinds: Kind[]
  /** Folders (vault-relative) left out of Recall, voice profiles and filing, besides the special ones. */
  excludedFolders: string[]
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
  keys: {},
  kinds: DEFAULT_KINDS,
  excludedFolders: [],
}

const FILE = path.join(META_DIR, 'settings.json')
let current: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (current) return current
  try {
    const saved = JSON.parse(await fs.readFile(FILE, 'utf8')) as Partial<Settings>
    current = { ...DEFAULTS, ...saved, kinds: await settleFolders(cleanKinds(saved.kinds) ?? DEFAULTS.kinds), excludedFolders: cleanFolders(saved.excludedFolders) }
  } catch {
    current = { ...DEFAULTS }
  }
  return current
}

/**
 * A kind saved with a doubled plural folder (yt-scriptses/, from before the word rules) gets its
 * proper folder when the doubled one holds nothing, so there is nothing to move. One that holds
 * pieces keeps it until the writer renames it from Settings → Kinds. A proper folder another kind
 * already files into is left alone too: two kinds sharing one folder would mix up their pieces.
 */
async function settleFolders(kinds: Kind[]): Promise<Kind[]> {
  const taken = new Set(kinds.map((k) => k.folder))
  return Promise.all(
    kinds.map(async (k) => {
      const fix = doubledFolder(k)
      if (!fix || taken.has(fix) || (await holdsAnything(path.join(VAULT, k.folder)))) return k
      return { ...k, folder: fix }
    }),
  )
}

const holdsAnything = (abs: string) =>
  fs.readdir(abs).then(
    (names) => names.some((n) => n !== '.DS_Store'),
    () => false,
  )

/** Vault-relative folder paths, tidied: forward slashes, no leading or trailing slash, no dot-folders or `..`, no repeats. */
function cleanFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const f = v
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .trim()
    if (!f || f.length > 200 || f.split('/').some((part) => !part.trim() || part.startsWith('.'))) continue
    if (!out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f)
  }
  return out
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
  next.kinds = await settleFolders(cleanKinds(next.kinds) ?? prev.kinds)
  next.excludedFolders = cleanFolders(next.excludedFolders)
  next.keys = Object.fromEntries(Object.entries(next.keys ?? {}).filter(([k, v]) => /^[\w.-]+$/.test(k) && typeof v === 'string' && v.length < 40))
  current = next
  await fs.mkdir(META_DIR, { recursive: true })
  // Only what differs from the defaults is written, so the file stays short and readable.
  const diff = Object.fromEntries(
    Object.entries(next).filter(([k, v]) =>
      k === 'keys' || k === 'excludedFolders' ? Object.keys(v as object).length > 0 : k === 'kinds' ? JSON.stringify(v) !== JSON.stringify(DEFAULTS.kinds) : DEFAULTS[k as keyof Settings] !== v,
    ),
  )
  await fs.writeFile(FILE, JSON.stringify(diff, null, 2) + '\n', 'utf8')
  return next
}
