// CSS snippets: .css files in the vault whose rules the writer adds to the app, as Obsidian does.
// Settings names one; the app reads it and injects it as a <style>. Only files inside the vault, and
// only .css ones, are ever read.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VAULT } from './paths.ts'
import { HttpError } from './net.ts'
import { cleanSnippet } from '../src/lib/appearance.ts'

/** Snippets larger than this are left alone: a snippet is a few rules, not a stylesheet library. */
const MAX_BYTES = 256 * 1024
const MAX_LISTED = 200

/** Every .css file in the vault (outside dot-folders), by path. */
export async function listSnippets(): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number) {
    if (depth > 6 || out.length >= MAX_LISTED) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs, depth + 1)
      else if (entry.isFile() && /\.css$/i.test(entry.name) && out.length < MAX_LISTED) out.push(path.relative(VAULT, abs).split(path.sep).join('/'))
    }
  }
  await walk(VAULT, 0)
  return out.sort((a, b) => a.localeCompare(b))
}

/** A snippet's text. A path that isn't a vault .css file, a missing file or an outsized one is a 4xx the app shows as a notice. */
export async function readSnippet(rel: string): Promise<string> {
  const clean = cleanSnippet(rel)
  if (!clean) throw new HttpError(400, 'Not a .css file in the vault')
  const abs = path.resolve(VAULT, clean)
  if (!abs.startsWith(VAULT + path.sep)) throw new HttpError(400, 'Not a .css file in the vault')
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) throw new HttpError(404, 'Not found')
  // A link inside the vault mustn't lead out of it.
  const [real, root] = await Promise.all([fs.realpath(abs), fs.realpath(VAULT)])
  if (!real.startsWith(root + path.sep)) throw new HttpError(400, 'Not a .css file in the vault')
  if (stat.size > MAX_BYTES) throw new HttpError(413, 'Too large (over 256 KB)')
  return fs.readFile(abs, 'utf8')
}
