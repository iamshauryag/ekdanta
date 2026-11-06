// Thin client for the local server in server/api.ts.
export interface FileEntry {
  path: string
  folder: string
  title: string
  platform?: string
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
  files: () => fetch('/api/files').then(json<FileEntry[]>),
  read: (path: string) =>
    fetch('/api/file?path=' + encodeURIComponent(path))
      .then(json<{ content: string }>)
      .then((d) => d.content),
  write: (path: string, content: string) => fetch('/api/file', send('PUT', { path, content })).then(json),
  history: (doc: string) => fetch('/api/history?doc=' + encodeURIComponent(doc)).then(json<unknown[]>),
  appendHistory: (doc: string, item: unknown) => fetch('/api/history', send('POST', { doc, item })).then(json),
  reindex: () => fetch('/api/index', send('POST', {})).then(json<{ files: number; paragraphs: number }>),
}
