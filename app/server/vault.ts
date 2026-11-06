// Reading and writing the vault: a plain folder of Markdown files.
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
const PLATFORMS = ['essay', 'linkedin', 'email', 'text', 'blog']

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

export async function createDoc(folder: string, platform?: string) {
  folder = folder.replace(/^\/+|\/+$/g, '')
  const guess = PLATFORMS.find((p) => folder.toLowerCase().split('/').pop()!.startsWith(p)) ?? 'essay'
  const rel = await freePath(folder, 'untitled')
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  await writeDoc(rel, `---\ntitle: \nplatform: ${platform ?? guess}\nstatus: draft\ncreated: ${today}\n---\n\n`)
  return rel
}

/** Give an untitled document a file name from its title. Named documents keep theirs, so links to them never break. */
export async function nameDoc(rel: string, title: string) {
  if (!isUntitled(rel) || !title.trim()) return rel
  const folder = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
  const next = await freePath(folder, slugify(title))
  await fs.rename(resolveInVault(rel), resolveInVault(next))
  // Its history, Thinking Space and Ekdanta's notes on it move too (if there are any yet).
  await fs.rename(historyFile(rel), historyFile(next)).catch(() => {})
  await fs.rename(resolveInVault(canvasOf(rel)), resolveInVault(canvasOf(next))).catch(() => {})
  await fs.rename(sideFile(rel), sideFile(next)).catch(() => {})
  return next
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
