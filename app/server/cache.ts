// A listing of the vault's Markdown files that doesn't read every file every time. Each file's
// parsed entry is kept with the mtime and size it was read at; a listing stats every file and
// re-reads only those that changed (or that Ekdanta itself just wrote, via invalidate()).
// statAll() is the cheap form for polling: stats only, never content.
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface FileStat {
  path: string // relative to the root, with forward slashes
  mtime: number
  size: number
}

/** Every .md file under root, from stats alone. Dot-files and dot-folders (.ekdanta, .obsidian, .git) are skipped. */
export async function statTree(root: string): Promise<FileStat[]> {
  const out: FileStat[] = []
  async function walk(dir: string) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // removed while we walked
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = await fs.stat(abs).catch(() => null)
        if (stat) out.push({ path: path.relative(root, abs).split(path.sep).join('/'), mtime: stat.mtimeMs, size: stat.size })
      }
    }
  }
  await walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export interface FileCache<T> {
  /** Every file's entry, re-reading only files whose mtime or size changed since they were last read. */
  list(): Promise<T[]>
  /** Every file's path, mtime and size, without reading any content. */
  statAll(): Promise<FileStat[]>
  /** Forget a file, so the next listing reads it again. Call it after any write, move or delete. */
  invalidate(rel: string): void
  /** How many files have been read so far (for tests). */
  readonly reads: number
}

export function createFileCache<T>(root: string, parse: (rel: string, raw: string, stat: FileStat) => T): FileCache<T> {
  const entries = new Map<string, { mtime: number; size: number; value: T }>()
  let reads = 0
  return {
    async list() {
      const stats = await statTree(root)
      const live = new Set<string>()
      const out: T[] = []
      for (const stat of stats) {
        live.add(stat.path)
        const hit = entries.get(stat.path)
        if (hit && hit.mtime === stat.mtime && hit.size === stat.size) {
          out.push(hit.value)
          continue
        }
        let raw: string
        try {
          raw = await fs.readFile(path.join(root, stat.path), 'utf8')
        } catch {
          continue // deleted between the stat and the read
        }
        reads++
        const value = parse(stat.path, raw, stat)
        entries.set(stat.path, { mtime: stat.mtime, size: stat.size, value })
        out.push(value)
      }
      for (const p of entries.keys()) if (!live.has(p)) entries.delete(p)
      return out
    },
    statAll: () => statTree(root),
    invalidate(rel) {
      entries.delete(rel)
    },
    get reads() {
      return reads
    },
  }
}
