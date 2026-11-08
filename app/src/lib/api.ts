import type { Kind } from './kinds.ts'
import type { MetaPatch } from './frontmatter.ts'
import type { TagCount } from './tags.ts'
import type { TemplateInfo } from './templates.ts'
import type { Appearance } from './appearance.ts'
import type { EdgeCandidate, EdgeSlot } from './edge.ts'
import type { VersionEntry, VersionRow } from './versions.ts'
import type { Reader, ReaderQuestion } from './reader.ts'
import type { SourceFields, SourceType } from './brain.ts'
// Thin client for the local server in server/api.ts.
/** Why a kind change left a document where it was (see server/vault.ts). */
export type PlaceStay = 'special' | 'excluded' | 'brain' | 'unknown-kind' | 'target-special' | 'target-excluded' | 'target-brain'

export interface FileEntry {
  path: string
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
  /** Front-matter and inline tags, as written. */
  tags: string[]
  /** Just the front matter's `tags`: the ones the sidebar can add and take away. */
  fmTags?: string[]
  /** A brief is pinned to it. */
  brief?: boolean
  /** The idea this piece was started from. */
  fromIdea?: string
  aliases?: string[]
}

export type Range = [number, number]
export interface SearchHit {
  line: number
  text: string
  ranges: Range[]
  select: { text: string; nth: number }
}
export interface SearchFile {
  path: string
  title: string
  folder: string
  platform?: string
  titleRanges: Range[]
  hits: SearchHit[]
}
export interface SearchResult {
  files: SearchFile[]
  /** Result rows found (lines with a match, or a document matched by title or filters alone): what More… pages through. */
  total: number
  /** Occurrences found, in text and titles. */
  matches: number
  /** Documents that matched, shown or not. */
  documents: number
  more: boolean
  error?: string
}
export interface MeaningHit {
  doc: string
  title: string
  folder: string
  text: string
  score: number
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
  profileName: string
  profileInstitution: string
  defaultStyle: 'mla' | 'apa' | 'chicago' | 'none'
  /** Folders (vault-relative) left out of Recall and voice, besides the special ones. */
  excludedFolders: string[]
  /** Where the Brain keeps its source notes. */
  brainFolder: string
}

/** A source in the Brain, as the shelf lists it. */
export interface Source extends SourceFields {
  path: string
  highlights: number
  mtime: number
}
/** Details a lookup found, for the writer to check before saving. */
export interface SourceCandidate extends Partial<SourceFields> {
  type: SourceType
  title: string
}
export interface ImportPlan {
  format: 'kindle' | 'readwise' | null
  books: { title: string; author: string; path: string | null; highlights: number; fresh: number }[]
  fresh: number
  skipped: number
  created?: number
  /** After an import: every note it wrote. */
  changed?: string[]
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
  marks?: Record<string, string> // where a fragment came from, shown on it ('Spark')
}
export interface Thinking {
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] }
  side: ThinkingSide
}
type Frag = { id: string; text: string }

export type SparkSeed =
  { kind: 'piece'; doc: string } | { kind: 'topic'; topic: string } | { kind: 'folder'; folder: string } | { kind: 'tag'; tag: string } | { kind: 'surprise' } | { kind: 'like'; ids: string[] }
export interface SparkSource {
  id: string
  doc: string
  title: string
  folder: string
  text: string
}
export interface SparkCard {
  key: string
  title?: string
  angle?: string
  why?: string
  suits?: string
  sources: SparkSource[]
}
export interface SparkResult {
  mode: 'sparks' | 'pairs'
  cards: SparkCard[]
  message?: string
  note?: string
}
export interface IndexState {
  building: boolean
  docs: number
  paragraphs: number
}

/** What an export made: its file name, the engine that made a Word file, and what the writer should know. */
export interface Exported {
  name: string
  engine: 'pandoc' | 'built-in' | null
  warnings: string[]
  /** Where it was saved in the vault, or null when it came back as a download. */
  saved: string | null
  /** The file, for a download. */
  blob: Blob | null
}

/** A request the server answered with an error: its status, its code when it gives one (VAULT_UNAVAILABLE), and anything else it sent. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly data: Record<string, unknown>
  constructor(status: number, data: Record<string, unknown>, fallback: string) {
    super(typeof data.error === 'string' ? data.error : fallback)
    this.status = status
    this.data = data
    if (typeof data.code === 'string') this.code = data.code
  }
}

async function json<T>(r: Response): Promise<T> {
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, data as Record<string, unknown>, r.statusText || 'The app’s server didn’t answer')
  return data as T
}

/** A document a server operation wrote or moved, and its mtime now. */
export interface Touched {
  path: string
  mtime: number
}
/** What a file operation answers: where the document is now, and every document it changed. */
export interface Moved {
  path: string
  touched?: Touched[]
}
export interface Changes {
  now: number
  reset?: boolean
  changed: Touched[]
  created: Touched[]
  deleted: string[]
}

export interface IdeaRow {
  text: string
  /** As written after it in ideas.md: "6 Nov 2026". */
  date?: string
  starred: boolean
  /** The newest piece started from it, while that piece exists. */
  started?: { path: string; title: string }
}

export type ImportStatus = 'pending' | 'converted' | 'review' | 'failed' | 'duplicate' | 'unsupported'
/** One file in an import (server/import/index.ts). */
export interface ImportItem {
  id: string
  name: string
  type: 'docx' | 'doc' | 'pdf' | 'html' | 'text' | 'markdown' | 'rtf' | 'csv' | 'other'
  size: number
  sha: string
  inbox?: string
  converter?: string
  status: ImportStatus
  reason?: string
  notes: string[]
  words: number
  title: string
  created: string
  platform?: string
  folder: string
  tags?: string[]
  imported?: { path: string; media: string[]; hash: string }
}
export interface ImportBatch {
  batch: string
  items: ImportItem[]
  pandoc: boolean
  inbox: string
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
  /** The document's text and the mtime of exactly that text. */
  readFile: (path: string) => fetch('/api/file?path=' + encodeURIComponent(path)).then(json<{ content: string; mtime: number }>),
  /** Save. With baseMtime, a file changed since is refused (ApiError 409, data {mtime, content}); a gone file is a 404 unless create. */
  write: (path: string, content: string, opts: { baseMtime?: number; create?: boolean } = {}) => fetch('/api/file', send('PUT', { path, content, ...opts })).then(json<{ ok: true; mtime: number }>),
  changes: (since?: number) => fetch('/api/changes' + (since === undefined ? '' : '?since=' + since)).then(json<Changes>),
  create: (folder: string, platform?: string) => fetch('/api/new', send('POST', { folder, platform })).then(json<{ path: string }>),
  name: (path: string, title: string) => fetch('/api/name', send('POST', { path, title })).then(json<Moved>),
  /** File a document in its kind's folder after a kind change from `was`; `stay` says why it didn't move, `undo` puts it back. */
  place: (path: string, was?: string) => fetch('/api/place', send('POST', { path, was })).then(json<Moved & { stay?: PlaceStay; folder?: string; undo?: string }>),
  /** Undo a kind change that moved a document, by the token the move gave. */
  unplace: (token: string) => fetch('/api/place/undo', send('POST', { token })).then(json<Moved>),
  rename: (path: string, title: string) => fetch('/api/rename', send('POST', { path, title })).then(json<Moved>),
  move: (path: string, folder: string) => fetch('/api/move', send('POST', { path, folder })).then(json<Moved>),
  duplicate: (path: string) => fetch('/api/duplicate', send('POST', { path })).then(json<Moved>),
  remove: (path: string) => fetch('/api/delete', send('POST', { path })).then(json<Trashed>),
  saveImage: (doc: string, name: string, data: string) => fetch('/api/asset', send('POST', { doc, name, data })).then(json<{ src: string }>),
  trash: () => fetch('/api/trash').then(json<Trashed[]>),
  restore: (id: string) => fetch('/api/restore', send('POST', { id })).then(json<Moved>),
  discard: (path: string) => fetch('/api/discard', send('POST', { path })).then(json<{ discarded: boolean }>),
  patchMeta: (path: string, patch: MetaPatch) => fetch('/api/meta', send('POST', { path, patch })).then(json<{ ok: true; touched?: Touched[] }>),
  tags: () => fetch('/api/tags').then(json<TagCount[]>),
  /** Add and take away front-matter tags on a note that isn't open. */
  editTags: (path: string, add: string[], remove: string[]) => fetch('/api/tags/edit', send('POST', { path, add, remove })).then(json<{ tags: string[]; touched?: Touched[] }>),
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
  sparks: (req: { seed: SparkSeed; suits?: string; exclude?: string[] }) => fetch('/api/sparks', send('POST', req)).then(json<SparkResult>),
  sparkState: () => fetch('/api/sparks/state').then(json<IndexState>),
  sparkOptions: () => fetch('/api/sparks/options').then(json<{ docs: number; folders: string[]; tags: string[] }>),
  keepSpark: (card: SparkCard) => fetch('/api/sparks/keep', send('POST', card)).then(json<{ path: string; bullet: string }>),
  dismissSpark: (key: string) => fetch('/api/sparks/dismiss', send('POST', { key })).then(json),
  startFromSpark: (card: SparkCard, kind: string) => fetch('/api/sparks/start', send('POST', { card, kind })).then(json<{ path: string }>),
  search: (q: string, opts: { matchCase?: boolean; limit?: number } = {}, signal?: AbortSignal) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}${opts.matchCase ? '&case=1' : ''}${opts.limit ? '&limit=' + opts.limit : ''}`, { signal }).then(json<SearchResult>),
  searchMeaning: (q: string, signal?: AbortSignal) => fetch('/api/search/meaning?q=' + encodeURIComponent(q), { signal }).then(json<{ ready: boolean; results: MeaningHit[] }>),
  versions: (doc: string) => fetch('/api/versions?doc=' + encodeURIComponent(doc)).then(json<VersionRow[]>),
  version: (doc: string, id: string) =>
    fetch(`/api/version?doc=${encodeURIComponent(doc)}&id=${encodeURIComponent(id)}`)
      .then(json<{ content: string }>)
      .then((d) => d.content),
  /** Keep a version: of `content` if given (the text on screen), else of the file as saved. */
  snapshot: (doc: string, opts: { reason: string; name?: string; content?: string }) => fetch('/api/versions/snapshot', send('POST', { doc, ...opts })).then(json<{ version: VersionEntry | null }>),
  nameVersion: (doc: string, id: string, name: string) => fetch('/api/versions/name', send('POST', { doc, id, name })).then(json<{ version: VersionEntry }>),
  clearHistory: (doc: string) => fetch('/api/history?doc=' + encodeURIComponent(doc), { method: 'DELETE' }).then(json),
  renameKindFolder: (id: string) => fetch('/api/kinds/rename-folder', send('POST', { id })).then(json<{ settings: Settings; moved: { from: string; to: string }[]; touched?: Touched[] }>),
  templates: () => fetch('/api/templates').then(json<TemplateInfo[]>),
  applyTemplate: (path: string, template: string) => fetch('/api/templates/apply', send('POST', { path, template })).then(json<{ cursor: number | null; touched?: Touched[] }>),
  seedTemplates: () => fetch('/api/templates/seed', send('POST', {})).then(json<{ added: string[] }>),
  useSample: () => fetch('/api/vault/use-sample', send('POST', {})).then(json<{ files: number }>),
  importBatch: () => fetch('/api/import/batch', send('POST', {})).then(json<ImportBatch>),
  /** One file, sent as it is (not as JSON), so a big one never sits in memory twice. */
  importUpload: (batch: string, file: File) =>
    fetch('/api/import/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-batch': batch, 'x-filename': encodeURIComponent(file.name), 'x-mtime': String(file.lastModified || 0) },
      body: file,
    }).then(json<ImportItem>),
  importConvert: (batch: string, id: string) => fetch('/api/import/convert', send('POST', { batch, id })).then(json<ImportItem>),
  importPreview: (batch: string, id: string, platform: string, tags: string[] = []) =>
    fetch(`/api/import/preview?${new URLSearchParams([['batch', batch], ['id', id], ['platform', platform], ...tags.map((t) => ['tag', t])])}`)
      .then(json<{ content: string }>)
      .then((d) => d.content),
  importCommit: (batch: string, id: string, platform: string, folder: string, tags: string[] = []) =>
    fetch('/api/import/commit', send('POST', { batch, id, platform, folder, tags })).then(json<ImportItem>),
  importUndo: (batch: string) => fetch('/api/import/undo', send('POST', { batch })).then(json<{ removed: string[]; trashed: string[]; missing: string[] }>),
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
  captureIdea: (text: string) => fetch('/api/ideas', send('POST', { text })).then(json<{ added: boolean; text: string; date: string; touched?: Touched[] }>),
  starIdea: (text: string, starred: boolean) => fetch('/api/ideas/star', send('POST', { text, starred })).then(json<{ starred: boolean }>),
  startIdea: (text: string, kind: string) => fetch('/api/ideas/start', send('POST', { text, kind })).then(json<{ path: string }>),
  reindex: () => fetch('/api/index', send('POST', {})).then(json<{ files: number; paragraphs: number }>),
  readAs: (req: { doc: string; platform: string; reader: Reader; text: string; selection: boolean }) => fetch('/api/reader', send('POST', req)).then(json<ReaderReply>),
  exportEngine: () => fetch('/api/export/engine').then(json<{ pandoc: string | null }>),
  exportFile: async (path: string, format: 'docx' | 'html' | 'md', options: { destination: 'download' | 'vault' }): Promise<Exported> => {
    const r = await fetch('/api/export', send('POST', { path, format, options }))
    if (!r.ok || r.headers.get('content-type')?.startsWith('application/json')) {
      const data = await json<Omit<Exported, 'blob'>>(r)
      return { ...data, blob: null }
    }
    const info = JSON.parse(decodeURIComponent(r.headers.get('x-ekdanta-export') ?? '%7B%7D')) as Omit<Exported, 'blob'>
    return { ...info, blob: await r.blob() }
  },
  brain: () => fetch('/api/brain').then(json<Source[]>),
  addSource: (fields: Partial<SourceFields>) => fetch('/api/brain/source', send('POST', fields)).then(json<{ path: string; existed: boolean; touched?: Touched[] }>),
  addHighlight: (path: string, text: string, location: string) => fetch('/api/brain/highlight', send('POST', { path, text, location })).then(json<{ added: number; touched?: Touched[] }>),
  lookupSource: (input: string) => fetch('/api/brain/lookup', send('POST', { input })).then(json<{ candidates: SourceCandidate[] }>),
  previewImport: (text: string, name: string) => fetch('/api/brain/import/preview', send('POST', { text, name })).then(json<ImportPlan>),
  runImport: (text: string, name: string) => fetch('/api/brain/import', send('POST', { text, name })).then(json<ImportPlan & { touched?: Touched[] }>),
}

export type ReaderReply = { kind: 'questions'; items: ReaderQuestion[]; provider: string } | { kind: 'empty' | 'error'; message: string }
