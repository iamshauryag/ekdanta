// Reading and writing the vault: a plain folder of Markdown files.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyPatch, joinFrontMatter, splitFrontMatter as splitFull, type MetaPatch } from '../src/lib/frontmatter.ts'
import { findKind, kindOfFolder, type Kind } from '../src/lib/kinds.ts'

// `npm run dev` runs from app/, so the bundled sample vault is the default.
export const VAULT = path.resolve(process.env.EKDANTA_VAULT ?? 'sample-vault')
export const META_DIR = path.join(VAULT, '.ekdanta')

export interface FileEntry {
  path: string // relative to the vault, with forward slashes
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
}

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
export function resolveInVault(rel: string): string {
  const abs = path.resolve(VAULT, rel)
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new Error('Path outside the vault')
  return abs
}

export async function listFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.name.endsWith('.md')) {
        const rel = path.relative(VAULT, abs).split(path.sep).join('/')
        const [stat, raw] = await Promise.all([fs.stat(abs), fs.readFile(abs, 'utf8')])
        const { meta, body } = splitFrontMatter(raw)
        out.push({
          path: rel,
          folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          title: meta.title || firstHeading(body) || (isUntitled(rel) ? 'Untitled' : entry.name.replace(/\.md$/, '')),
          platform: meta.platform,
          exemplar: meta.exemplar === 'true',
          mtime: stat.mtimeMs,
        })
      }
    }
  }
  await walk(VAULT)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readDoc(rel: string) {
  return fs.readFile(resolveInVault(rel), 'utf8')
}

export async function writeDoc(rel: string, content: string) {
  const abs = resolveInVault(rel)
  if (!abs.endsWith('.md')) throw new Error('Only .md files can be written')
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

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
  await writeDoc(rel, `---\ntitle: \nplatform: ${platform ?? guess}\nstatus: draft\ncreated: ${today()}\n---\n\n`)
  return rel
}

/** Give an untitled document a file name from its title. Named documents keep theirs, so links to them never break. */
export async function nameDoc(rel: string, title: string) {
  if (!isUntitled(rel) || !title.trim()) return rel
  return moveDoc(rel, await freePath(folderOf(rel), slugify(title)))
}

/** Rename a document. Its history, Thinking Space and Ekdanta's notes on it move too (if there are any yet). */
async function moveDoc(rel: string, next: string) {
  await fs.mkdir(path.dirname(resolveInVault(next)), { recursive: true })
  await fs.rename(resolveInVault(rel), resolveInVault(next))
  await fs.rename(historyFile(rel), historyFile(next)).catch(() => {})
  await fs.rename(resolveInVault(canvasOf(rel)), resolveInVault(canvasOf(next))).catch(() => {})
  await fs.rename(sideFile(rel), sideFile(next)).catch(() => {})
  return next
}

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

async function patchDoc(rel: string, patch: MetaPatch) {
  const { meta, body, raw } = splitFull(await readDoc(rel))
  await writeDoc(rel, joinFrontMatter(raw, applyPatch(meta, patch), body))
}

/** Rename a document: its title, its file, and every [[link]] to it in the vault. */
export async function renameDoc(rel: string, title: string) {
  title = title.trim()
  if (!title) return rel
  await patchDoc(rel, { title })
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
  const files = (await listFiles()).map((f) => resolveInVault(f.path))
  const voice = path.join(META_DIR, 'voice')
  for (const f of await fs.readdir(voice).catch(() => [] as string[])) if (f.endsWith('.md')) files.push(path.join(voice, f))
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const out = text.replace(re, (_m, target: string, ext = '', heading = '', alias = '') => `[[${target === oldFull ? newFull : newName}${ext}${heading}${alias}]]`)
    if (out !== text) await fs.writeFile(file, out, 'utf8')
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
  if (platform) await patchDoc(next, { platform })
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
  await writeDoc(next, joinFrontMatter(raw, applyPatch(meta, patch), body))
  await fs.copyFile(resolveInVault(canvasOf(rel)), resolveInVault(canvasOf(next))).catch(() => {})
  return next
}

// Deleting moves a document into .ekdanta/trash/, with everything Ekdanta keeps about it, so it can come back.
const TRASH = path.join(META_DIR, 'trash')
const parts = (rel: string) => [
  [resolveInVault(rel), 'doc.md'],
  [resolveInVault(canvasOf(rel)), 'doc.canvas'],
  [historyFile(rel), 'history.jsonl'],
  [sideFile(rel), 'thinking.json'],
]

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
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(path.join(dir, from), to).catch(() => {})
  }
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
    if (!(await fs.access(resolveInVault(rel)).then(() => true, () => false))) break
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
  if (await fs.access(resolveInVault(canvasOf(rel))).then(() => true, () => false)) return false
  await fs.unlink(resolveInVault(rel))
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
const sideFile = (rel: string) => path.join(META_DIR, 'thinking', rel.replace(/\.md$/, '').replace(/\//g, '__') + '.json')

// Help history: one JSON object per line, per document.
function historyFile(doc: string) {
  return path.join(META_DIR, 'history', doc.replace(/\.md$/, '').replace(/\//g, '__') + '.jsonl')
}

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
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
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
