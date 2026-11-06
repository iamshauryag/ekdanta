// A document's pinned brief: what the piece answers (an essay question, a job post, the email being
// replied to). It's kept in .ekdanta/briefs/<doc>.brief.md, never in the document, so it stays out of
// the body, the word count, exports, Recall and voice profiles. It follows its document through
// rename, move, trash and restore; a duplicate starts without one.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BRIEF_MAX_CHARS, normalizeBrief } from '../src/lib/brief.ts'
import { HttpError } from './net.ts'
import { META_DIR, atomicWrite, docKey, registerSidecar, resolveInVault } from './vault.ts'

/** Where a document's brief lives. */
export const briefFile = (rel: string) => path.join(META_DIR, 'briefs', docKey(rel) + '.brief.md')

// The writer's own words: a new draft with only a brief pinned isn't an empty one.
registerSidecar('brief.md', briefFile, { content: true })

function checkDoc(rel: string) {
  if (typeof rel !== 'string' || !rel.endsWith('.md')) throw new HttpError(400, 'Not a document')
  resolveInVault(rel)
}

/** The brief pinned to a document, or '' if there isn't one. */
export async function readBrief(rel: string): Promise<string> {
  checkDoc(rel)
  try {
    return await fs.readFile(briefFile(rel), 'utf8')
  } catch {
    return ''
  }
}

/** Pin (or replace) a document's brief. An empty one unpins it. Returns what was saved. */
export async function writeBrief(rel: string, text: string): Promise<string> {
  checkDoc(rel)
  if (typeof text !== 'string') throw new HttpError(400, 'A brief is text')
  const clean = normalizeBrief(text)
  if (clean.length > BRIEF_MAX_CHARS) throw new HttpError(413, `That’s too long to pin (${clean.length.toLocaleString()} characters; the most is ${BRIEF_MAX_CHARS.toLocaleString()}).`)
  // Only for a document that exists, so a brief never outlives a page that was never there.
  const stat = await fs.stat(resolveInVault(rel)).catch(() => null)
  if (!stat?.isFile()) throw new HttpError(404, 'No such document')
  if (!clean) {
    await fs.rm(briefFile(rel), { force: true })
    return ''
  }
  await atomicWrite(briefFile(rel), clean + '\n')
  return clean
}

/** Mark which documents have a brief pinned, so a page's ⋯ menu can say "Edit the pinned brief". */
export async function markBriefs<T extends { path: string }>(files: T[]): Promise<(T & { brief: boolean })[]> {
  const pinned = new Set(await fs.readdir(path.join(META_DIR, 'briefs')).catch(() => [] as string[]))
  return files.map((f) => ({ ...f, brief: pinned.has(path.basename(briefFile(f.path))) }))
}

/** The brief to ground a Nudge in: '' when there's none, or when it can't be read. */
export async function briefForPrompt(rel: string | undefined): Promise<string> {
  if (!rel) return ''
  try {
    return normalizeBrief(await readBrief(rel))
  } catch {
    return ''
  }
}
