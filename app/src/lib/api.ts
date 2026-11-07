import type { Kind } from './kinds.ts'
import type { TemplateInfo } from './templates.ts'
import type { Appearance } from './appearance.ts'
import type { EdgeCandidate, EdgeSlot } from './edge.ts'
import type { VersionEntry, VersionRow } from './versions.ts'
import type { Reader, ReaderQuestion } from './reader.ts'
// Thin client for the local server in server/api.ts.
export interface FileEntry {
  path: string
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
  /** A brief is pinned to it. */
  brief?: boolean
  /** The idea this piece was started from. */
  fromIdea?: string
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

export interface Trashed {
  id: string
  path: string
  title: string
  deleted: string
}

export interface Settings extends Appearance {
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
  /** Shortcuts the writer changed: command id → key ('' to unbind). */
  keys: Record<string, string>
  kinds: Kind[]
  /** Folders (vault-relative) left out of Recall and voice, besides the special ones. */
  excludedFolders: string[]
}

export interface VoiceSummary {
  platform: string
  exists: boolean
  upToDate: boolean
  built?: string
  sources: { path: string; title: string; exemplar: boolean }[]
  exemplars: number
}

export interface CanvasNode {
  id: string
  type: string
  text?: string
  x: number
  y: number
  width: number
  height: number
}
export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  label?: string
}
export interface Cluster {
  id: string
  label: string
  /** The writer renamed it. */
  mine?: boolean
  ids: string[]
}
/** What only Ekdanta keeps about a Thinking Space (the canvas itself is plain JSON Canvas). */
export interface ThinkingSide {
  dismissed?: string[] // fragment pairs ("a|b") the writer said aren't related
  clusters?: Cluster[]
  linkedSig?: string // the fragments as they were when links were last suggested
  recall?: Record<string, { text: string; hit: { doc: string; title: string; folder: string } | null }>
  checked?: Record<string, boolean> // fragments the writer ticked (true) or un-ticked (false) by hand
}
export interface Thinking {
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] }
  side: ThinkingSide
}
type Frag = { id: string; text: string }

export interface IdeaRow {
  text: string
  /** As written after it in ideas.md: "6 Nov 2026". */
  date?: string
  starred: boolean
  /** The newest piece started from it, while that piece exists. */
  started?: { path: string; title: string }
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
  snippets: () => fetch('/api/snippets').then(json<string[]>),
  snippet: (path: string) => fetch('/api/snippet?path=' + encodeURIComponent(path)).then(json<{ css: string; error?: string }>),
  files: () => fetch('/api/files').then(json<FileEntry[]>),
  read: (path: string) =>
    fetch('/api/file?path=' + encodeURIComponent(path))
      .then(json<{ content: string }>)
      .then((d) => d.content),
  write: (path: string, content: string) => fetch('/api/file', send('PUT', { path, content })).then(json),
  create: (folder: string, platform?: string) => fetch('/api/new', send('POST', { folder, platform })).then(json<{ path: string }>),
  name: (path: string, title: string) => fetch('/api/name', send('POST', { path, title })).then(json<{ path: string }>),
  place: (path: string) => fetch('/api/place', send('POST', { path })).then(json<{ path: string }>),
  rename: (path: string, title: string) => fetch('/api/rename', send('POST', { path, title })).then(json<{ path: string }>),
  move: (path: string, folder: string) => fetch('/api/move', send('POST', { path, folder })).then(json<{ path: string }>),
  duplicate: (path: string) => fetch('/api/duplicate', send('POST', { path })).then(json<{ path: string }>),
  remove: (path: string) => fetch('/api/delete', send('POST', { path })).then(json<Trashed>),
  saveImage: (doc: string, name: string, data: string) => fetch('/api/asset', send('POST', { doc, name, data })).then(json<{ src: string }>),
  trash: () => fetch('/api/trash').then(json<Trashed[]>),
  restore: (id: string) => fetch('/api/restore', send('POST', { id })).then(json<{ path: string }>),
  discard: (path: string) => fetch('/api/discard', send('POST', { path })).then(json<{ discarded: boolean }>),
  patchMeta: (path: string, patch: Record<string, string | null>) => fetch('/api/meta', send('POST', { path, patch })).then(json),
  voice: () => fetch('/api/voice').then(json<VoiceSummary[]>),
  voiceProfile: (platform: string) =>
    fetch('/api/voice/profile?platform=' + encodeURIComponent(platform))
      .then(json<{ content: string | null }>)
      .then((d) => d.content),
  saveVoiceProfile: (platform: string, content: string) => fetch('/api/voice/profile', send('PUT', { platform, content })).then(json),
  buildVoice: (platform: string) =>
    fetch('/api/voice/build', send('POST', { platform }))
      .then(json<{ content: string }>)
      .then((d) => d.content),
  thinking: (doc: string) => fetch('/api/thinking?doc=' + encodeURIComponent(doc)).then(json<Thinking>),
  saveThinking: (doc: string, t: Thinking) => fetch('/api/thinking', send('PUT', { doc, ...t })).then(json),
  thinkingLinks: (fragments: Frag[], skip: string[]) => fetch('/api/thinking/links', send('POST', { fragments, skip })).then(json<{ links: { from: string; to: string; label: string }[] }>),
  thinkingClusters: (fragments: Frag[]) => fetch('/api/thinking/clusters', send('POST', { fragments })).then(json<{ clusters: { label: string; ids: string[] }[] }>),
  thinkingRecall: (doc: string, fragments: Frag[], taken: string[]) =>
    fetch('/api/thinking/recall', send('POST', { doc, fragments, taken })).then(json<{ chips: Record<string, { doc: string; title: string; folder: string } | null> }>),
  thinkingMaterial: (doc: string, fragments: Frag[], paragraph: string) =>
    fetch('/api/thinking/material', send('POST', { doc, fragments, paragraph })).then(json<{ covered: string[]; nearest: string | null }>),
  history: (doc: string) => fetch('/api/history?doc=' + encodeURIComponent(doc)).then(json<unknown[]>),
  appendHistory: (doc: string, item: unknown) => fetch('/api/history', send('POST', { doc, item })).then(json),
  versions: (doc: string) => fetch('/api/versions?doc=' + encodeURIComponent(doc)).then(json<VersionRow[]>),
  version: (doc: string, id: string) =>
    fetch(`/api/version?doc=${encodeURIComponent(doc)}&id=${encodeURIComponent(id)}`)
      .then(json<{ content: string }>)
      .then((d) => d.content),
  /** Keep a version: of `content` if given (the text on screen), else of the file as saved. */
  snapshot: (doc: string, opts: { reason: string; name?: string; content?: string }) => fetch('/api/versions/snapshot', send('POST', { doc, ...opts })).then(json<{ version: VersionEntry | null }>),
  nameVersion: (doc: string, id: string, name: string) => fetch('/api/versions/name', send('POST', { doc, id, name })).then(json<{ version: VersionEntry }>),
  clearHistory: (doc: string) => fetch('/api/history?doc=' + encodeURIComponent(doc), { method: 'DELETE' }).then(json),
  renameKindFolder: (id: string) => fetch('/api/kinds/rename-folder', send('POST', { id })).then(json<{ settings: Settings; moved: { from: string; to: string }[] }>),
  templates: () => fetch('/api/templates').then(json<TemplateInfo[]>),
  applyTemplate: (path: string, template: string) => fetch('/api/templates/apply', send('POST', { path, template })).then(json<{ cursor: number | null }>),
  seedTemplates: () => fetch('/api/templates/seed', send('POST', {})).then(json<{ added: string[] }>),
  brief: (doc: string) =>
    fetch('/api/brief?doc=' + encodeURIComponent(doc))
      .then(json<{ text: string }>)
      .then((d) => d.text),
  pinBrief: (doc: string, text: string) =>
    fetch('/api/brief', send('PUT', { doc, text }))
      .then(json<{ text: string }>)
      .then((d) => d.text),
  edge: (req: { slot: EdgeSlot; text: string; kind: string; current?: string; avoid?: string[] }) =>
    fetch('/api/edge', send('POST', req)).then(json<{ kind: 'edge'; candidates: EdgeCandidate[] } | { kind: 'empty' | 'error'; message: string }>),
  ideas: () => fetch('/api/ideas').then(json<{ exists: boolean; ideas: IdeaRow[] }>),
  captureIdea: (text: string) => fetch('/api/ideas', send('POST', { text })).then(json<{ added: boolean; text: string; date: string }>),
  starIdea: (text: string, starred: boolean) => fetch('/api/ideas/star', send('POST', { text, starred })).then(json<{ starred: boolean }>),
  startIdea: (text: string, kind: string) => fetch('/api/ideas/start', send('POST', { text, kind })).then(json<{ path: string }>),
  reindex: () => fetch('/api/index', send('POST', {})).then(json<{ files: number; paragraphs: number }>),
  readAs: (req: { doc: string; platform: string; reader: Reader; text: string; selection: boolean }) => fetch('/api/reader', send('POST', req)).then(json<ReaderReply>),
}

export type ReaderReply = { kind: 'questions'; items: ReaderQuestion[]; provider: string } | { kind: 'empty' | 'error'; message: string }
