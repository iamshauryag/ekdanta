// Reading and writing the vault: a plain folder of Markdown files.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyPatch, joinFrontMatter, splitFrontMatter as splitFull, type MetaPatch } from '../src/lib/frontmatter.ts'
import { findKind, kindOfFolder, type Kind } from '../src/lib/kinds.ts'
import { isSpecialPath } from '../src/lib/special.ts'
import { createFileCache, type FileStat } from './cache.ts'
import { META_DIR, VAULT } from './paths.ts'

export { META_DIR, VAULT }

export interface FileEntry {
  path: string // relative to the vault, with forward slashes
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
  /** The idea from ideas.md this piece was started from (front matter `from-idea`). */
  fromIdea?: string
}

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
export function resolveInVault(rel: string): string {
  const abs = path.resolve(VAULT, rel)
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new Error('Path outside the vault')
  return abs
}

// The vault's files, read once and re-read only when they change (on disk or through Ekdanta).
const cache = createFileCache<FileEntry>(VAULT, (rel, raw, stat) => {
  const { meta, body } = splitFrontMatter(raw)
  return {
    path: rel,
    folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    title: meta.title || firstHeading(body) || (isUntitled(rel) ? 'Untitled' : path.posix.basename(rel, '.md')),
    platform: meta.platform,
    exemplar: meta.exemplar === 'true',
    mtime: stat.mtime,
    ...(meta['from-idea']?.trim() ? { fromIdea: meta['from-idea'] } : {}),
  }
})

/** Every document in the vault, sorted by path. Only files changed since the last call are read. */
export const listFiles = (): Promise<FileEntry[]> => cache.list()

/** Every document's path, mtime and size, from stats alone: cheap enough to poll. */
export const statAll = (): Promise<FileStat[]> => cache.statAll()

export async function readDoc(rel: string) {
  return fs.readFile(resolveInVault(rel), 'utf8')
}

// ---- Writing --------------------------------------------------------------------------------
// Every write of a document goes through writeDoc: hooks run first (version history registers one),
// then the file is replaced atomically, and a record of what Ekdanta wrote is kept so a change made
// outside Ekdanta can be told apart from our own.

export interface BeforeWrite {
  path: string
  /** What's on disk now, or null for a new file. */
  oldContent: string | null
  newContent: string
  /** Why it's being written: 'save', 'meta', 'rename', 'relink', 'create', 'duplicate'. */
  reason: string
}
type WriteHook = (w: BeforeWrite) => void | Promise<void>
const writeHooks: WriteHook[] = []

/** Run `hook` before every document write. A hook that throws is logged and never stops the save. */
export function onBeforeWrite(hook: WriteHook) {
  writeHooks.push(hook)
  return () => {
    const i = writeHooks.indexOf(hook)
    if (i >= 0) writeHooks.splice(i, 1)
  }
}

/**
 * Replace a file in one step: write a temporary file beside it, then rename it over the original.
 * A symlinked document is written through to its target (the link stays a link), a hard-linked one
 * is written in place (a rename would split it from its other names), and the file keeps its mode.
 */
export async function atomicWrite(abs: string, data: string | Buffer) {
  const real = await fs.realpath(abs).catch(() => abs) // a new file, or a dangling link: write where asked
  const old = await fs.stat(real).catch(() => null)
  if (old && old.nlink > 1) return fs.writeFile(real, data)
  await fs.mkdir(path.dirname(real), { recursive: true })
  // A dot-file, so a listing never shows a half-written document.
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await fs.writeFile(tmp, data, old ? { mode: old.mode & 0o7777 } : {})
    if (old) await fs.chmod(tmp, old.mode & 0o7777) // writeFile's mode is masked by the umask
    await fs.rename(tmp, real)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

// One write at a time per document, so the write record always describes the file on disk:
// two overlapping saves (an autosave and ⌘S, a save and a rename's relink) can't interleave.
const writing = new Map<string, Promise<unknown>>()
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (writing.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  writing.set(key, tail)
  tail.then(() => writing.get(key) === tail && writing.delete(key))
  return run
}

export async function writeDoc(rel: string, content: string, opts: { reason?: string } = {}): Promise<{ mtime: number }> {
  const abs = resolveInVault(rel)
  if (!abs.endsWith('.md')) throw new Error('Only .md files can be written')
  return oneAtATime(abs, () => writeNow(rel, abs, content, opts.reason ?? 'save'))
}

async function writeNow(rel: string, abs: string, content: string, reason: string): Promise<{ mtime: number }> {
  if (writeHooks.length) {
    const oldContent = await fs.readFile(abs, 'utf8').catch(() => null)
    const w: BeforeWrite = { path: rel, oldContent, newContent: content, reason }
    for (const hook of writeHooks) {
      try {
        await hook(w)
      } catch (e) {
        console.error(`[ekdanta] a write hook failed for ${rel}; saving anyway:`, e)
      }
    }
  }
  await atomicWrite(abs, content)
  cache.invalidate(rel)
  const { mtimeMs: mtime } = await fs.stat(abs)
  try {
    await atomicWrite(writtenBody(rel), content)
    await atomicWrite(writtenInfo(rel), JSON.stringify({ mtime, hash: hashOf(content) }))
  } catch (e) {
    console.error(`[ekdanta] couldn't record the write of ${rel}:`, e)
  }
  return { mtime }
}

export const hashOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

/** A document's key for Ekdanta's per-document files: `essays/on-walking.md` → `essays__on-walking`. */
export const docKey = (rel: string) => rel.replace(/\.md$/, '').replace(/\//g, '__')

const WRITTEN = path.join(META_DIR, 'written')
const writtenInfo = (rel: string) => path.join(WRITTEN, docKey(rel) + '.json')
const writtenBody = (rel: string) => path.join(WRITTEN, docKey(rel) + '.md')

/** What Ekdanta last wrote to a document (the whole file, front matter included), or null if it never has. */
export async function lastWritten(rel: string): Promise<{ mtime: number; hash: string; body: string } | null> {
  resolveInVault(rel)
  try {
    const info = JSON.parse(await fs.readFile(writtenInfo(rel), 'utf8')) as { mtime: number; hash: string }
    const body = await fs.readFile(writtenBody(rel), 'utf8')
    if (typeof info.mtime !== 'number' || typeof info.hash !== 'string') return null
    // The two files are written one after the other; if they don't agree, the record can't be trusted.
    if (hashOf(body) !== info.hash) return null
    return { mtime: info.mtime, hash: info.hash, body }
  } catch {
    return null
  }
}

// ---- Sidecars ---------------------------------------------------------------------------------
// Files Ekdanta keeps beside or about a document. They follow it through rename, move, trash and
// restore. The name is also the file's name inside a trash folder, so it must stay stable.

const sidecarList: { name: string; of: (rel: string) => string }[] = []

/** Make a per-document file (or folder) follow its document. `of` maps a document's vault path to the file's absolute path. */
export function registerSidecar(name: string, of: (rel: string) => string) {
  if (!/^[\w.-]+$/.test(name) || name === 'doc.md' || name === 'info.json') throw new Error(`Bad sidecar name: ${name}`)
  if (sidecarList.some((s) => s.name === name)) throw new Error(`Sidecar ${name} is already registered`)
  sidecarList.push({ name, of })
}

/** A document's sidecars: [absolute path, name]. */
const sidecarsOf = (rel: string) => sidecarList.map((s) => [s.of(rel), s.name] as const)

// New documents start as untitled.md and take their name from the title once it's written.

export function isUntitled(rel: string) {
  return /^untitled(-\d+)?\.md$/.test(path.posix.basename(rel))
}

export function slugify(title: string) {
  return (
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .replace(/-$/, '') || 'untitled'
  )
}

/** `folder/name.md`, or `folder/name-2.md` and so on if that's taken. */
async function freePath(folder: string, name: string) {
  for (let n = 1; ; n++) {
    const rel = `${folder ? folder + '/' : ''}${name}${n > 1 ? '-' + n : ''}.md`
    try {
      await fs.access(resolveInVault(rel))
    } catch {
      return rel
    }
  }
}

export async function createDoc(kinds: Kind[], folder: string, platform?: string) {
  folder = folder.replace(/^\/+|\/+$/g, '')
  const guess = kindOfFolder(kinds, folder.split('/').pop()!)?.id ?? kinds[0]?.id ?? 'essay'
  const rel = await freePath(folder, 'untitled')
  await writeDoc(rel, `---\ntitle: \nplatform: ${platform ?? guess}\nstatus: draft\ncreated: ${today()}\n---\n\n`, { reason: 'create' })
  return rel
}

/** Give an untitled document a file name from its title. Named documents keep theirs, so links to them never break. */
export async function nameDoc(rel: string, title: string) {
  if (!isUntitled(rel) || !title.trim()) return rel
  return moveDoc(rel, await freePath(folderOf(rel), slugify(title)))
}

/** Rename a document. Its sidecars (history, Thinking Space, Ekdanta's notes on it) move too, if there are any yet. */
async function moveDoc(rel: string, next: string) {
  await fs.mkdir(path.dirname(resolveInVault(next)), { recursive: true })
  await fs.rename(resolveInVault(rel), resolveInVault(next))
  cache.invalidate(rel)
  cache.invalidate(next)
  const to = new Map(sidecarsOf(next).map(([abs, name]) => [name, abs]))
  for (const [from, name] of sidecarsOf(rel)) {
    const dest = to.get(name)!
    if (!(await exists(from))) continue
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(from, dest).catch((e) => console.error(`[ekdanta] couldn't move ${name} for ${rel}:`, e))
  }
  return next
}

const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )

/**
 * After a platform change, move a document into that platform's folder. Only documents in
 * another platform's folder (or loose at the top of the vault) move; one the writer filed
 * somewhere of their own stays put.
 */
export async function placeDoc(kinds: Kind[], rel: string) {
  const { meta } = splitFrontMatter(await readDoc(rel))
  const kind = findKind(kinds, meta.platform ?? '')
  const folder = folderOf(rel)
  const holds = (f: string) => kindOfFolder(kinds, f)?.id
  // Templates, a journal, sources and the like stay where they are, whatever kind they name.
  if (isSpecialPath(rel)) return rel
  if (!kind || holds(folder) === kind.id) return rel
  if (folder && !holds(folder)) return rel
  const dirs = (await fs.readdir(VAULT, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  const target = dirs.find((d) => holds(d) === kind.id) ?? kind.folder
  return moveDoc(rel, await freePath(target, path.posix.basename(rel, '.md')))
}

const folderOf = (rel: string) => (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))
const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

async function patchDoc(rel: string, patch: MetaPatch, reason = 'meta') {
  const { meta, body, raw } = splitFull(await readDoc(rel))
  await writeDoc(rel, joinFrontMatter(raw, applyPatch(meta, patch), body), { reason })
}

/** Rename a document: its title, its file, and every [[link]] to it in the vault. */
export async function renameDoc(rel: string, title: string) {
  title = title.trim()
  if (!title) return rel
  await patchDoc(rel, { title }, 'rename')
  const name = slugify(title)
  const from = path.posix.basename(rel, '.md')
  if (name === from) return rel
  const next = await moveDoc(rel, await freePath(folderOf(rel), name))
  await relink(rel, next)
  return next
}

/** Point [[links]] at a document's new name, in the vault and in Ekdanta's own notes (voice profiles quote by link). */
async function relink(prev: string, next: string) {
  const oldName = path.posix.basename(prev, '.md')
  const newName = path.posix.basename(next, '.md')
  const oldFull = prev.replace(/\.md$/, '')
  const newFull = next.replace(/\.md$/, '')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\[\\[(${esc(oldFull)}|${esc(oldName)})(\\.md)?(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g')
  const fix = (text: string) => text.replace(re, (_m, target: string, ext = '', heading = '', alias = '') => `[[${target === oldFull ? newFull : newName}${ext}${heading}${alias}]]`)
  for (const f of await listFiles()) {
    const text = await readDoc(f.path)
    const out = fix(text)
    if (out !== text) await writeDoc(f.path, out, { reason: 'relink' })
  }
  const voice = path.join(META_DIR, 'voice')
  for (const f of await fs.readdir(voice).catch(() => [] as string[])) {
    if (!f.endsWith('.md')) continue
    const text = await fs.readFile(path.join(voice, f), 'utf8')
    const out = fix(text)
    if (out !== text) await atomicWrite(path.join(voice, f), out)
  }
}

/** Move a document to another folder. A platform's folder makes it a piece for that platform. */
export async function moveToFolder(kinds: Kind[], rel: string, folder: string) {
  folder = folder.replace(/^\/+|\/+$/g, '').trim()
  if (folder.split('/').some((part) => part.startsWith('.'))) throw new Error('Not a folder for documents')
  resolveInVault(folder || '.')
  if (folder === folderOf(rel)) return rel
  const next = await moveDoc(rel, await freePath(folder, path.posix.basename(rel, '.md')))
  const platform = kindOfFolder(kinds, folder)?.id
  if (platform) await patchDoc(next, { platform }, 'move')
  return next
}

/** A copy of a document (and its Thinking Space) to work on separately. */
export async function duplicateDoc(rel: string) {
  const { meta, body, raw } = splitFull(await readDoc(rel))
  const title = `${meta.title || path.posix.basename(rel, '.md')} (copy)`
  const next = await freePath(folderOf(rel), slugify(title))
  // A copy isn't an exemplar or a published piece until the writer says so.
  const patch: MetaPatch = { title, created: today(), exemplar: null }
  if (meta.status) patch.status = 'draft'
  await writeDoc(next, joinFrontMatter(raw, applyPatch(meta, patch), body), { reason: 'duplicate' })
  await fs.copyFile(resolveInVault(canvasOf(rel)), resolveInVault(canvasOf(next))).catch(() => {})
  return next
}

// Deleting moves a document into .ekdanta/trash/, with everything Ekdanta keeps about it, so it can come back.
const TRASH = path.join(META_DIR, 'trash')
const parts = (rel: string) => [[resolveInVault(rel), 'doc.md'] as const, ...sidecarsOf(rel)]

export interface Trashed {
  id: string
  path: string
  title: string
  deleted: string
}

export async function trashDoc(rel: string): Promise<Trashed> {
  const { meta, body } = splitFrontMatter(await readDoc(rel))
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const dir = path.join(TRASH, id)
  await fs.mkdir(dir, { recursive: true })
  for (const [from, to] of parts(rel)) await fs.rename(from, path.join(dir, to)).catch(() => {})
  cache.invalidate(rel)
  const item = { id, path: rel, title: meta.title || firstHeading(body) || path.posix.basename(rel, '.md'), deleted: new Date().toISOString() }
  await fs.writeFile(path.join(dir, 'info.json'), JSON.stringify(item), 'utf8')
  return item
}

export async function listTrash(): Promise<Trashed[]> {
  const out: Trashed[] = []
  for (const id of await fs.readdir(TRASH).catch(() => [] as string[])) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(TRASH, id, 'info.json'), 'utf8')) as Trashed)
    } catch {
      /* not one of ours */
    }
  }
  return out.sort((a, b) => b.deleted.localeCompare(a.deleted))
}

/** Put a deleted document back where it was (beside it, if that name has since been taken). */
export async function restoreDoc(id: string) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error('Not in the trash')
  const dir = path.join(TRASH, id)
  const item = JSON.parse(await fs.readFile(path.join(dir, 'info.json'), 'utf8')) as Trashed
  const rel = await freePath(folderOf(item.path), path.posix.basename(item.path, '.md'))
  await fs.mkdir(path.dirname(resolveInVault(rel)), { recursive: true })
  for (const [to, from] of parts(rel)) {
    if (!(await exists(path.join(dir, from)))) continue
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(path.join(dir, from), to).catch(() => {})
  }
  cache.invalidate(rel)
  await fs.rm(dir, { recursive: true, force: true })
  return rel
}

// Images pasted or dropped into a document live in attachments/, like Obsidian's default, and the
// document links to them with a relative path, so any Markdown viewer shows them.
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }

export async function saveAsset(doc: string, name: string, base64: string) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase()
  if (!IMAGE_TYPES[ext]) throw new Error('Only images can be added')
  const stem = slugify(name.replace(/\.[^.]+$/, '')) || 'image'
  let rel = ''
  for (let n = 1; ; n++) {
    rel = `attachments/${stem}${n > 1 ? '-' + n : ''}.${ext}`
    if (
      !(await fs.access(resolveInVault(rel)).then(
        () => true,
        () => false,
      ))
    )
      break
  }
  await fs.mkdir(path.dirname(resolveInVault(rel)), { recursive: true })
  await fs.writeFile(resolveInVault(rel), Buffer.from(base64, 'base64'))
  // The link is relative to the document's own folder.
  return path.posix.relative(folderOf(doc) || '.', rel)
}

export async function readAsset(rel: string) {
  const ext = rel.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''
  if (!IMAGE_TYPES[ext]) throw new Error('Not an image')
  return { type: IMAGE_TYPES[ext], data: await fs.readFile(resolveInVault(rel)) }
}

/** Remove a document only if it's an untitled one with nothing in it. */
export async function discardIfEmpty(rel: string) {
  if (!isUntitled(rel)) return false
  const { meta, body } = splitFrontMatter(await readDoc(rel))
  if (meta.title?.trim() || body.trim()) return false
  // Thinking already done for it counts as content.
  if (await exists(resolveInVault(canvasOf(rel)))) return false
  await fs.unlink(resolveInVault(rel))
  cache.invalidate(rel)
  // Its sidecars go too, so the next untitled.md doesn't inherit them.
  for (const [abs] of sidecarsOf(rel)) await fs.rm(abs, { recursive: true, force: true }).catch(() => {})
  return true
}

/** Minimal YAML front-matter: flat `key: value` pairs, which is all Ekdanta writes. */
export function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = unquote(kv[2])
  }
  return { meta, body: raw.slice(m[0].length) }
}

function firstHeading(body: string) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim()
}

const canvasOf = (rel: string) => rel.replace(/\.md$/, '.canvas')
const sideFile = (rel: string) => path.join(META_DIR, 'thinking', docKey(rel) + '.json')

// Help history: one JSON object per line, per document.
function historyFile(doc: string) {
  return path.join(META_DIR, 'history', docKey(doc) + '.jsonl')
}

// The built-in sidecars. The names match what older trash folders hold, so those still restore.
registerSidecar('doc.canvas', (rel) => resolveInVault(canvasOf(rel)))
registerSidecar('history.jsonl', historyFile)
registerSidecar('thinking.json', sideFile)
registerSidecar('written.json', writtenInfo)
registerSidecar('written.md', writtenBody)

export async function appendHistory(doc: string, item: unknown) {
  resolveInVault(doc)
  const file = historyFile(doc)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(item) + '\n', 'utf8')
}

export async function readHistory(doc: string): Promise<unknown[]> {
  resolveInVault(doc)
  try {
    const raw = await fs.readFile(historyFile(doc), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function unquote(v: string) {
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v) as string
    } catch {
      /* fall through */
    }
  }
  return v.replace(/^["']|["']$/g, '')
}
