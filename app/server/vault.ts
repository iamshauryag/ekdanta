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
          title: meta.title || firstHeading(body) || entry.name.replace(/\.md$/, ''),
          platform: meta.platform,
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

/** Minimal YAML front-matter: flat `key: value` pairs, which is all Ekdanta writes. */
export function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: raw.slice(m[0].length) }
}

function firstHeading(body: string) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim()
}

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
