// Version history: snapshots of a document, kept under .ekdanta/versions/<doc key>/ as plain .md
// files with an index.json beside them. Taken automatically (at most every five minutes while
// saving, and around a change made outside Ekdanta) and on request (Save version…, before a
// restore, before an AI accept that replaces more than a sentence, before rename/move/trash).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countWords, isVersionId, retain, splitDoc, versionId, wordDelta, type VersionEntry, type VersionRow } from '../src/lib/versions.ts'
import { META_DIR, adoptOldKey, betweenWrites, docKey, hashOf, lastWritten, onBeforeWrite, readDoc, readWithMtime, registerSidecar, resolveInVault, atomicWrite } from './vault.ts'
import { HttpError } from './net.ts'

/** Saves closer together than this don't each get a version. */
export const AUTOSAVE_GAP = 5 * 60_000

const ROOT = path.join(META_DIR, 'versions')
const dirOf = (rel: string) => path.join(ROOT, docKey(rel))
const indexOf = (rel: string) => path.join(dirOf(rel), 'index.json')

// The versions folder follows its document through rename, move, trash and restore, and goes with
// an empty untitled draft that's discarded.
registerSidecar('versions', dirOf)

// One change to a document's versions at a time, so two snapshots can't both rewrite the index.
const queue = new Map<string, Promise<unknown>>()
function serial<T>(rel: string, fn: () => Promise<T>): Promise<T> {
  const key = dirOf(rel)
  // Versions still under the document's old key are brought over first.
  const go = () => adoptOldKey(rel).then(fn)
  const run = (queue.get(key) ?? Promise.resolve()).then(go, go)
  const tail = run.catch(() => {})
  queue.set(key, tail)
  tail.then(() => queue.get(key) === tail && queue.delete(key))
  return run
}

async function readIndex(rel: string): Promise<VersionEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(indexOf(rel), 'utf8')) as unknown
    if (Array.isArray(raw)) return raw.filter(isEntry)
  } catch {
    /* missing or damaged: rebuilt from the files below */
  }
  return rebuildIndex(rel)
}

const isEntry = (e: unknown): e is VersionEntry => {
  const v = e as VersionEntry
  return !!v && typeof v.id === 'string' && isVersionId(v.id) && typeof v.at === 'string' && typeof v.hash === 'string' && typeof v.reason === 'string' && typeof v.words === 'number'
}

/** An index made from the snapshot files themselves, if index.json is gone or unreadable. Names are lost; the text isn't. */
async function rebuildIndex(rel: string): Promise<VersionEntry[]> {
  const out: VersionEntry[] = []
  for (const f of await fs.readdir(dirOf(rel)).catch(() => [] as string[])) {
    const id = f.replace(/\.md$/, '')
    if (!f.endsWith('.md') || !isVersionId(id)) continue
    const content = await fs.readFile(path.join(dirOf(rel), f), 'utf8').catch(() => null)
    if (content === null) continue
    const at = id.replace(/-\d+$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3')
    out.push({ id, at, words: countWords(splitDoc(content).body), reason: 'recovered', hash: hashOf(content) })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

async function writeIndex(rel: string, entries: VersionEntry[]) {
  await fs.mkdir(dirOf(rel), { recursive: true })
  await atomicWrite(indexOf(rel), JSON.stringify(entries, null, 1))
}

export interface SnapshotOpts {
  /** The text to keep; what's on disk if left out. */
  content?: string
  reason: string
  name?: string
  /** When the text was as given (defaults to now). */
  at?: Date
}

/**
 * Keep a version of a document. Nothing new is kept if the text is the same as the latest version's:
 * a name, if given, goes on that version instead (or, if it already has another name, a second named
 * version of the same text is kept, so every name the writer gives exists). Returns the version, or
 * null if there was nothing to keep.
 */
export function snapshot(rel: string, opts: SnapshotOpts): Promise<VersionEntry | null> {
  resolveInVault(rel)
  return serial(rel, () => snapshotNow(rel, opts))
}

async function snapshotNow(rel: string, opts: SnapshotOpts): Promise<VersionEntry | null> {
  const content = opts.content ?? (await readDoc(rel).catch(() => null))
  if (content === null) return null
  const name = opts.name?.trim().slice(0, 80) || undefined
  const hash = hashOf(content)
  const entries = await readIndex(rel)
  const latest = entries[entries.length - 1]
  if (latest && latest.hash === hash) {
    if (!name) return null
    if (latest.name === name) return latest
    if (!latest.name) {
      latest.name = name
      await writeIndex(rel, entries)
      return latest
    }
  }
  const at = opts.at ?? new Date()
  let id = versionId(at)
  for (let n = 2; entries.some((e) => e.id === id); n++) id = `${versionId(at)}-${n}`
  const entry: VersionEntry = { id, at: at.toISOString(), words: countWords(splitDoc(content).body), reason: opts.reason, hash, ...(name ? { name } : {}) }
  await fs.mkdir(dirOf(rel), { recursive: true })
  await atomicWrite(path.join(dirOf(rel), id + '.md'), content)
  entries.push(entry)
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  await prune(rel, entries)
  return entry
}

/** Apply the retention rules and delete the files of versions that go. */
async function prune(rel: string, entries: VersionEntry[], now = Date.now()) {
  const kept = retain(entries, now)
  const keep = new Set(kept.map((e) => e.id))
  for (const e of entries) if (!keep.has(e.id)) await fs.rm(path.join(dirOf(rel), e.id + '.md'), { force: true })
  await writeIndex(rel, kept)
  return kept
}

/** For tests: prune as if it were `now`. */
export const pruneAt = (rel: string, now: number) => serial(rel, async () => prune(rel, await readIndex(rel), now))

/** A document's versions, oldest first, each with the words added and removed since the one before. */
export async function listVersions(rel: string): Promise<VersionRow[]> {
  resolveInVault(rel)
  const entries = await serial(rel, () => readIndex(rel))
  const rows: VersionRow[] = []
  let prev = ''
  for (const e of entries) {
    const body = splitDoc((await readVersion(rel, e.id).catch(() => null)) ?? '').body
    rows.push({ ...e, ...cachedDelta(prev, body) })
    prev = body
  }
  return rows
}

// Word deltas are worth remembering: the same pairs are asked for every time the list refreshes.
const deltas = new Map<string, { added: number; removed: number }>()
function cachedDelta(a: string, b: string) {
  const key = hashOf(a) + hashOf(b)
  let d = deltas.get(key)
  if (!d) {
    d = wordDelta(a, b)
    if (deltas.size > 2000) deltas.clear()
    deltas.set(key, d)
  }
  return d
}
export async function readVersion(rel: string, id: string): Promise<string> {
  resolveInVault(rel)
  if (!isVersionId(id)) throw new HttpError(404, 'No such version')
  await adoptOldKey(rel)
  return fs.readFile(path.join(dirOf(rel), id + '.md'), 'utf8').catch(() => {
    throw new HttpError(404, 'No such version')
  })
}

/** Name a version (an empty name removes it). Named versions are kept for good. */
export function nameVersion(rel: string, id: string, name: string) {
  resolveInVault(rel)
  return serial(rel, async () => {
    const entries = await readIndex(rel)
    const e = entries.find((x) => x.id === id)
    if (!e) throw new HttpError(404, 'No such version')
    const clean = name.trim().slice(0, 80)
    if (clean) e.name = clean
    else delete e.name
    await prune(rel, entries)
    return e
  })
}

/**
 * Open a document: read it and, if it was changed outside Ekdanta since Ekdanta last wrote it, keep
 * both sides as versions. Done between writes, so a save in flight is never mistaken for an outside
 * change (the file already new, the write record not yet). Returns the file's text and mtime, or null if it isn't there.
 */
export function checkOutside(rel: string): Promise<{ content: string; mtime: number } | null> {
  return betweenWrites(rel, async () => {
    const now = await readWithMtime(rel)
    if (now) await noteOutside(rel, now.content).catch((e) => console.error(`[ekdanta] couldn't keep versions of ${rel}:`, e))
    return now
  })
}

/**
 * Keep a version just before the server moves, renames or trashes a document. An outside change is
 * caught first, so what Ekdanta last saved is kept before the text on disk.
 */
export function keepBefore(rel: string, reason: string) {
  return betweenWrites(rel, async () => {
    const now = await readDoc(rel).catch(() => null)
    if (now === null) return
    await noteOutside(rel, now)
    await snapshot(rel, { content: now, reason })
  }).catch((e) => console.error(`[ekdanta] couldn't keep a version of ${rel}:`, e))
}

/**
 * The file's text is `now`. If that isn't what Ekdanta last wrote, keep what Ekdanta last wrote (unless
 * some version already has it) and then `now`. Both are dated now, when the change was found: dated by
 * the file's time, they could land in one retention bucket (or before older versions) and the first
 * would be pruned straight away. Call only between writes (from the write hook, or via betweenWrites).
 */
async function noteOutside(rel: string, now: string) {
  const rec = await lastWritten(rel)
  if (!rec || rec.hash === hashOf(now)) return
  await serial(rel, async () => {
    const entries = await readIndex(rel)
    const savedKept = entries.some((e) => e.hash === rec.hash)
    // Opened again with the same outside change: nothing to add.
    if (savedKept && entries[entries.length - 1]?.hash === hashOf(now)) return
    const t = Date.now()
    if (!savedKept) await snapshotNow(rel, { content: rec.body, reason: 'last saved in Ekdanta', at: new Date(t - 1) })
    await snapshotNow(rel, { content: now, reason: 'changed outside Ekdanta', at: new Date(t) })
  })
}

// Every write: catch outside changes, keep the first text of a new document, and otherwise keep the
// text being replaced if the last version is more than five minutes old.
onBeforeWrite(async ({ path: rel, oldContent, newContent, reason }) => {
  if (oldContent === newContent) return
  if (oldContent !== null) await noteOutside(rel, oldContent)
  await serial(rel, async () => {
    const entries = await readIndex(rel)
    const latest = entries[entries.length - 1]
    const oldBody = oldContent === null ? '' : splitDoc(oldContent).body
    if (!latest && !oldBody.trim()) {
      // A new document's first words: the first version.
      if (splitDoc(newContent).body.trim()) await snapshotNow(rel, { content: newContent, reason: 'first save' })
      return
    }
    if (oldContent === null) return
    if (latest && Date.now() - Date.parse(latest.at) < AUTOSAVE_GAP) return
    // A rename elsewhere rewrote this document's [[links]]: say so, it wasn't the writer's doing.
    await snapshotNow(rel, { content: oldContent, reason: reason === 'relink' ? 'before links were updated' : 'autosave' })
  })
})
