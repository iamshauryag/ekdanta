// Thin client for the local server in server/api.ts.
export interface FileEntry {
  path: string
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
}

export interface Status {
  ollama: boolean
  ollamaModels: string[]
  claudeCli: boolean
  anthropicApi: boolean
  fast: string | null
  strong: string | null
  models: { ollama: string; embed: string; claude: string; claudeFast: string }
  vault: string
  embedder: string
}

export interface Settings {
  provider: 'auto' | 'claude-cli' | 'anthropic-api' | 'ollama'
  wordLocal: boolean
  claudeModel: string
  claudeFastModel: string
  ollamaModel: string
  embedder: 'builtin' | 'ollama'
  ceiling: number
  recallDot: boolean
  paragraphFocus: boolean
  theme: 'system' | 'light' | 'dark'
}

async function json<T>(r: Response): Promise<T> {
  const data = await r.json()
  if (!r.ok) throw new Error((data as { error?: string }).error ?? r.statusText)
  return data as T
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  status: () => fetch('/api/status').then(json<Status>),
  settings: () => fetch('/api/settings').then(json<Settings>),
  saveSettings: (patch: Partial<Settings>) => fetch('/api/settings', send('PUT', patch)).then(json<Settings>),
  files: () => fetch('/api/files').then(json<FileEntry[]>),
  read: (path: string) =>
    fetch('/api/file?path=' + encodeURIComponent(path))
      .then(json<{ content: string }>)
      .then((d) => d.content),
  write: (path: string, content: string) => fetch('/api/file', send('PUT', { path, content })).then(json),
  create: (folder: string, platform?: string) => fetch('/api/new', send('POST', { folder, platform })).then(json<{ path: string }>),
  name: (path: string, title: string) => fetch('/api/name', send('POST', { path, title })).then(json<{ path: string }>),
  discard: (path: string) => fetch('/api/discard', send('POST', { path })).then(json<{ discarded: boolean }>),
  patchMeta: (path: string, patch: Record<string, string | null>) => fetch('/api/meta', send('POST', { path, patch })).then(json),
  history: (doc: string) => fetch('/api/history?doc=' + encodeURIComponent(doc)).then(json<unknown[]>),
  appendHistory: (doc: string, item: unknown) => fetch('/api/history', send('POST', { doc, item })).then(json),
  reindex: () => fetch('/api/index', send('POST', {})).then(json<{ files: number; paragraphs: number }>),
}
