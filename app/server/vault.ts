// Reading and writing the vault: a plain folder of Markdown files.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { joinDoc, joinFrontMatter, patchContent, patchFrontMatter, splitFrontMatter, type MetaPatch } from '../src/lib/frontmatter.ts'
import { docTags } from '../src/lib/tags.ts'
import { findKind, kindOfFolder, type Kind } from '../src/lib/kinds.ts'
import { docDefaults } from '../src/lib/docstyle.ts'
import { isSpecialFile, isSpecialPath } from '../src/lib/special.ts'
import { docSlug, sameName, slug } from '../src/lib/slug.ts'
import { frontMatterList } from '../src/lib/searchQuery.ts'
import { createFileCache, type FileStat } from './cache.ts'
import { HttpError } from './net.ts'
import { META_DIR, VAULT } from './paths.ts'

export { META_DIR, VAULT, splitFrontMatter }

export interface FileEntry {
  path: string // relative to the vault, with forward slashes
  folder: string
  title: string
  platform?: string
  exemplar: boolean
  mtime: number
  /** Other names for the page, from front-matter `aliases` (the quick switcher finds it by them). */
  aliases?: string[]
  /** Front-matter and inline tags, as written. */
  tags: string[]
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
  const fm = splitFrontMatter(raw)
  const { meta, body } = fm
  return {
    path: rel,
    folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    title: meta.title || meta['template-name'] || firstHeading(body) || (isUntitled(rel) ? 'Untitled' : path.posix.basename(rel, '.md')),
    platform: meta.platform,
    exemplar: meta.exemplar === 'true',
    mtime: stat.mtime,
    tags: docTags(fm),
    ...(meta['from-idea']?.trim() ? { fromIdea: meta['from-idea'] } : {}),
    ...aliasesOf(raw),
  }
})

function aliasesOf(raw: string) {
  const aliases = frontMatterList(raw, 'aliases')
  return aliases.length ? { aliases } : {}
}

/**
 * Every document in the vault, sorted by path. Only files changed since the last call are read.
 * Files waiting in _inbox/ aren't documents yet (the Import sheet picks them up), so they're left out.
 */
export const listFiles = async (): Promise<FileEntry[]> => (await cache.list()).filter((f) => !/^_inbox\//i.test(f.path))

/** Every document's path, mtime and size, from stats alone: cheap enough to poll. */
export const statAll = (): Promise<FileStat[]> => cache.statAll()

export async function readDoc(rel: string) {
  return fs.readFile(resolveInVault(rel), 'utf8')
}

/** A document's text and the mtime of exactly that text (both read from one open file), or null if it isn't there. */
export async function readWithMtime(rel: string): Promise<{ content: string; mtime: number } | null> {
  return readCurrent(resolveInVault(rel))
}

async function readCurrent(abs: string): Promise<{ content: string; mtime: number } | null> {
  let fh
  try {
    fh = await fs.open(abs, 'r')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    // A save replaces the file by renaming a new one over it, so this handle keeps seeing one version.
    const [stat, content] = await Promise.all([fh.stat(), fh.readFile('utf8')])
    return { content, mtime: stat.mtimeMs }
  } finally {
    await fh.close()
  }
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

/**
 * Run `fn` while no write of this document is under way (and hold later writes until it's done), so
 * the file and the write record agree while it looks at them. Never call writeDoc from inside it.
 */
export const betweenWrites = <T>(rel: string, fn: () => Promise<T>): Promise<T> => oneAtATime(resolveInVault(rel), fn)

/** The file changed on disk since the version the writer's text is based on. */
export class StaleWrite extends Error {
  readonly mtime: number
  readonly content: string
  constructor(rel: string, disk: { mtime: number; content: string }) {
    super(`${rel} changed on disk`)
    this.mtime = disk.mtime
    this.content = disk.content
  }
}

/** The file isn't there any more (deleted, or renamed elsewhere), and the write didn't ask to create it. */
export class MissingDoc extends Error {
  constructor(rel: string) {
    super(`${rel} is not in the vault`)
  }
}

export interface WriteOptions {
  /** Why it's being written (see BeforeWrite.reason). Default 'save'. */
  reason?: string
  /** The mtime of the version this text was based on. If the file has changed since, nothing is written and StaleWrite is thrown. */
  baseMtime?: number
  /** False: a missing file is not created (MissingDoc is thrown). Default true. */
  create?: boolean
}

/**
 * Write a document. Writing what's already there changes nothing, not even the mtime. The checks
 * and the write happen in one turn of the document's queue, so nothing can slip in between them.
 */
export async function writeDoc(rel: string, content: string, opts: WriteOptions = {}): Promise<{ mtime: number }> {
  const abs = resolveInVault(rel)
  if (!abs.endsWith('.md')) throw new Error('Only .md files can be written')
  const result = await oneAtATime(abs, () => writeNow(rel, abs, content, opts))
  touch(rel, result.mtime)
  return result
}

async function writeNow(rel: string, abs: string, content: string, opts: WriteOptions): Promise<{ mtime: number }> {
  const reason = opts.reason ?? 'save'
  await adoptOldKey(rel) // before the write hooks and the record touch its sidecars
  const disk = await readCurrent(abs)
  if (!disk && opts.create === false) throw new MissingDoc(rel)
  if (disk && disk.content === content) {
    // Nothing to write. Bring the record up to date if the same text arrived from outside.
    const rec = await lastWritten(rel)
    if (!rec || rec.mtime !== disk.mtime || rec.hash !== hashOf(content)) await record(rel, disk.mtime, content)
    return { mtime: disk.mtime }
  }
  if (disk && opts.baseMtime !== undefined && disk.mtime !== opts.baseMtime) throw new StaleWrite(rel, disk)
  if (writeHooks.length) {
    const w: BeforeWrite = { path: rel, oldContent: disk?.content ?? null, newContent: content, reason }
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
  await record(rel, mtime, content)
  return { mtime }
}

async function record(rel: string, mtime: number, content: string) {
  try {
    await atomicWrite(writtenBody(rel), content)
    await atomicWrite(writtenInfo(rel), JSON.stringify({ mtime, hash: hashOf(content) }))
  } catch (e) {
    console.error(`[ekdanta] couldn't record the write of ${rel}:`, e)
  }
}

// ---- Touched documents ------------------------------------------------------------------------
// A route that changes documents (a rename relinks others, a star rewrites front matter) reports
// each document it wrote or moved, with its new mtime. The open document is often among them, and
// the app adopts the new version instead of mistaking it for someone else's edit.

export interface Touched {
  path: string
  mtime: number
}
const touchedStore = new AsyncLocalStorage<Map<string, number>>()

/** Run `fn`, collecting every document written or moved while it runs (the last mtime of each). */
export async function collectTouched<T>(fn: () => Promise<T>): Promise<{ result: T; touched: Touched[] }> {
  const seen = new Map<string, number>()
  const result = await touchedStore.run(seen, fn)
  return { result, touched: [...seen].map(([path, mtime]) => ({ path, mtime })) }
}

function touch(rel: string, mtime: number) {
  touchedStore.getStore()?.set(rel, mtime)
}

async function touchOnDisk(rel: string) {
  if (!touchedStore.getStore()) return
  const stat = await fs.stat(resolveInVault(rel)).catch(() => null)
  if (stat) touch(rel, stat.mtimeMs)
}

// ---- Changes on disk --------------------------------------------------------------------------
// The app polls for changes made outside it (Obsidian, a shell, another tab). Each poll stats the
// vault (never reading a file) and compares it with the last scan; what differs is logged with the
// time it was seen. A client passes back the `now` it was given and gets everything seen since.

export interface Changes {
  now: number
  /** The log no longer reaches back to `since`: refresh everything. */
  reset?: boolean
  changed: Touched[]
  created: Touched[]
  deleted: string[]
}
type Seen = { at: number; path: string; kind: 'changed' | 'created' | 'deleted'; mtime: number }
const KEEP_CHANGES_MS = 10 * 60_000
let snapshot: Map<string, number> | null = null
let changeLog: Seen[] = []
let logFrom = 0 // the log is complete from this time on
let lastScan = 0
let scanning: Promise<void> = Promise.resolve()

async function scan() {
  const stats = await statAll()
  const at = Math.max(Date.now(), lastScan + 1) // strictly increasing, so `since` never skips a scan
  const next = new Map(stats.map((s) => [s.path, s.mtime]))
  if (snapshot) {
    for (const [p, mtime] of next) {
      const before = snapshot.get(p)
      if (before === undefined) changeLog.push({ at, path: p, kind: 'created', mtime })
      else if (before !== mtime) changeLog.push({ at, path: p, kind: 'changed', mtime })
    }
    for (const p of snapshot.keys()) if (!next.has(p)) changeLog.push({ at, path: p, kind: 'deleted', mtime: 0 })
  } else logFrom = at
  snapshot = next
  lastScan = at
  const cutoff = at - KEEP_CHANGES_MS
  if (changeLog.length && changeLog[0].at <= cutoff) {
    changeLog = changeLog.filter((c) => c.at > cutoff)
    logFrom = cutoff
  }
}

/** What changed in the vault since `since` (a `now` from an earlier call). Without `since`, just the current `now`. */
export async function changesSince(since?: number): Promise<Changes> {
  scanning = scanning.then(scan, scan)
  await scanning
  const now = lastScan
  if (since === undefined || !Number.isFinite(since)) return { now, changed: [], created: [], deleted: [] }
  if (since < logFrom) return { now, reset: true, changed: [], created: [], deleted: [] }
  // Fold several sightings of one path into what's different now from then.
  const net = new Map<string, Seen>()
  for (const c of changeLog) {
    if (c.at <= since) continue
    const prev = net.get(c.path)
    if (!prev) net.set(c.path, c)
    else if (prev.kind === 'created' && c.kind === 'deleted') net.delete(c.path)
    else if (prev.kind === 'created') net.set(c.path, { ...c, kind: 'created' })
    else if (prev.kind === 'deleted' && c.kind === 'created') net.set(c.path, { ...c, kind: 'changed' })
    else net.set(c.path, c)
  }
  const out: Changes = { now, changed: [], created: [], deleted: [] }
  for (const c of net.values()) {
    if (c.kind === 'deleted') out.deleted.push(c.path)
    else out[c.kind].push({ path: c.path, mtime: c.mtime })
  }
  return out
}

export const hashOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

/**
 * A document's key for Ekdanta's per-document files: `essays/on-walking.md` → `essays__on-walking`.
 * `/` becomes `__` and `_` becomes `_-`, so no two paths share a key (`a/b__c.md` and `a__b/c.md` once
 * did, and so shared their versions). A path without `_` keeps the key it always had.
 */
export const docKey = (rel: string) => keyOf(rel)
const currentKey = (rel: string) => rel.replace(/\.md$/, '').replace(/[/_]/g, (c) => (c === '/' ? '__' : '_-'))
/** The key before that: `/` → `__` only. Used to find files still kept under it (adoptOldKey). */
const legacyKey = (rel: string) => rel.replace(/\.md$/, '').replace(/\//g, '__')
let keyOf = currentKey

const WRITTEN = path.join(META_DIR, 'written')
const writtenInfo = (rel: string) => path.join(WRITTEN, docKey(rel) + '.json')
const writtenBody = (rel: string) => path.join(WRITTEN, docKey(rel) + '.md')

/** What Ekdanta last wrote to a document (the whole file, front matter included), or null if it never has. */
export async function lastWritten(rel: string): Promise<{ mtime: number; hash: string; body: string } | null> {
  resolveInVault(rel)
  await adoptOldKey(rel)
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

const sidecarList: { name: string; of: (rel: string) => string; content: boolean }[] = []

/**
 * Make a per-document file (or folder) follow its document. `of` maps a document's vault path to the file's absolute path.
 * A sidecar that holds the writer's own words (`content: true`) keeps an otherwise empty new draft from being discarded.
 */
export function registerSidecar(name: string, of: (rel: string) => string, opts: { content?: boolean } = {}) {
  if (!/^[\w.-]+$/.test(name) || name === 'doc.md' || name === 'info.json') throw new Error(`Bad sidecar name: ${name}`)
  if (sidecarList.some((s) => s.name === name)) throw new Error(`Sidecar ${name} is already registered`)
  sidecarList.push({ name, of, content: Boolean(opts.content) })
}

/** A document's sidecars: [absolute path, name]. */
const sidecarsOf = (rel: string) => sidecarList.map((s) => [s.of(rel), s.name] as const)

// ---- Sidecars kept under the old document key ---------------------------------------------
// A document whose path has `_` in it had a different key before. The first time such a document's
// sidecars are used, each one still under the old key is renamed to the new key: one fs.rename,
// so a crash leaves either name, never half of each. Nothing is ever deleted or merged.
//
// Whose files are where:
// - An old key shared by two documents in the vault can't be told apart: its files are left where
//   they are, and both start fresh.
// - A new key can be another document's old key (`a_b.md` → `a_-b`, the old key of `a_-b.md`).
//   Until the first document has used its new key, what's there is the other's: the other is
//   brought over first (and so on down the chain, which ends because keys only get longer), and
//   anything it couldn't take is set aside, never used as the first document's own.
// - Once a document has been brought over, a marker named by its new key (.ekdanta/keys/<key>)
//   says that key is in use under the new scheme, so it's never taken for an old key again, and
//   later runs of the server skip the work. Before its first file moves, a pending marker
//   (.ekdanta/keys-pending/<key>) says what's at the new key is its own: a start after a crash
//   part-way finishes the moves instead of taking its own files for someone else's.
// - Not handled: a plain document (no `_`) keeps its key, which can be a `_` document's old key
//   (`a/b.md` and `a__b.md` both had `a__b`). The `_` document starts fresh and the plain one
//   keeps the folder; whose each file was can't be told.

const CLAIMED = path.join(META_DIR, 'keys')
/** Where files that can't be given to anyone go, rather than being deleted or mixed in. */
const SET_ASIDE = path.join(META_DIR, 'set-aside')
const PENDING = path.join(META_DIR, 'keys-pending')
const claimed = (key: string) => exists(path.join(CLAIMED, key))

/**
 * The documents in the vault whose old key is `key`. Each `__` may have been a `/`, but only where
 * the path so far is a folder that exists, so a deep path costs a few checks, not one per guess.
 */
async function oldKeyOwners(key: string): Promise<string[]> {
  const out = new Set<string>()
  const isDir = new Map<string, Promise<boolean>>()
  const dirExists = (rel: string) => {
    let p = isDir.get(rel)
    if (!p) {
      let abs: string
      try {
        abs = resolveInVault(rel)
      } catch {
        abs = ''
      }
      p = abs
        ? fs.stat(abs).then(
            (s) => s.isDirectory(),
            () => false,
          )
        : Promise.resolve(false)
      isDir.set(rel, p)
    }
    return p
  }
  const seen = new Set<string>()
  async function walk(i: number, dir: string, seg: string): Promise<void> {
    const state = `${i}\0${dir}\0${seg}`
    if (seen.has(state)) return
    seen.add(state)
    if (i >= key.length) {
      const rel = dir + seg + '.md'
      if (seg && (await docExists(rel))) out.add(rel)
      return
    }
    if (key.startsWith('__', i) && seg && (await dirExists(dir + seg))) await walk(i + 2, dir + seg + '/', '')
    await walk(i + 1, dir, seg + key[i])
  }
  await walk(0, '', '')
  return [...out]
}

/** A sidecar's path under the old key. `of` is synchronous, so nothing else runs while the key is swapped. */
function legacyPathOf(of: (rel: string) => string, rel: string) {
  keyOf = legacyKey
  try {
    return of(rel)
  } finally {
    keyOf = currentKey
  }
}

const docExists = async (rel: string) => {
  try {
    return (await fs.stat(resolveInVault(rel))).isFile()
  } catch {
    return false // missing, or not a path in the vault
  }
}

async function setAside(abs: string, name: string) {
  let dest = path.join(SET_ASIDE, name, path.basename(abs))
  for (let n = 2; await exists(dest); n++) dest = path.join(SET_ASIDE, name, `${path.basename(abs)}-${n}`)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.rename(abs, dest)
  console.warn(`[ekdanta] ${path.relative(VAULT, abs)} belonged to another document; set aside as ${path.relative(VAULT, dest)}`)
}

const adopting = new Map<string, Promise<void>>()

/**
 * Bring a document's sidecars over from its old key, once per document per run of the server. Every
 * read or write of a sidecar awaits this first, so the rename always happens before anything reads
 * or writes the new name. Costs nothing for a path without `_`: its key never changed.
 *
 * `arriving`: a document is being moved or restored to `rel` and brings its own sidecars, so
 * anything under `rel`'s keys (old or new) is someone else's and isn't taken.
 */
export function adoptOldKey(rel: string, opts: { arriving?: boolean } = {}): Promise<void> {
  if (legacyKey(rel) === currentKey(rel)) return Promise.resolve()
  let p = adopting.get(rel)
  if (!p) {
    // A failure is kept until the server restarts: every use of the document's files fails with it,
    // rather than reading (or pruning) files under its new key it can't vouch for.
    p = adoptNow(rel, Boolean(opts.arriving)).catch((e: Error) => {
      console.error(`[ekdanta] couldn't bring over the files kept for ${rel}:`, e)
      throw new Error(`Ekdanta couldn’t sort out the files it keeps for ${rel}, so it won’t use them until it’s restarted (${e.message})`, { cause: e })
    })
    p.catch(() => {}) // the callers handle it
    adopting.set(rel, p)
  }
  return p
}

async function adoptNow(rel: string, arriving: boolean) {
  const key = currentKey(rel)
  if (await claimed(key)) return // brought over in an earlier run
  const pending = path.join(PENDING, key)
  // Stopped part-way last time: what's at the new key is already this document's own.
  if (!(await exists(pending))) await clearNewKey(rel, key)
  await fs.mkdir(PENDING, { recursive: true })
  await fs.writeFile(pending, '')
  // This document's own old files: only if no other document has the same old key, and that key
  // isn't one some document already uses under the new scheme.
  const old = legacyKey(rel)
  const sharing = (await oldKeyOwners(old)).filter((d) => d !== rel)
  if (sharing.length) console.warn(`[ekdanta] ${rel} shares its old key with ${sharing.join(', ')}; what was kept under it is left where it is`)
  if (!arriving && !sharing.length && !(await claimed(old))) {
    for (const s of sidecarList) {
      const from = legacyPathOf(s.of, rel)
      const to = s.of(rel)
      if (from === to || (await exists(to)) || !(await exists(from))) continue
      try {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.rename(from, to)
      } catch (e) {
        console.error(`[ekdanta] couldn't bring over ${s.name} for ${rel}; it stays under the old key:`, e)
      }
    }
  }
  await fs.mkdir(CLAIMED, { recursive: true })
  await fs.writeFile(path.join(CLAIMED, key), '')
  await fs.rm(pending, { force: true })
}

/** Before a document first uses its new key: whatever is there is someone else's. */
async function clearNewKey(rel: string, key: string) {
  // It may be the old files of other documents: they go to their own new keys first.
  for (const other of await oldKeyOwners(key)) if (other !== rel) await adoptOldKey(other)
  // Anything still there isn't this document's. Set aside, so it's never read or pruned as this document's.
  for (const s of sidecarList) {
    const to = s.of(rel)
    if (to === legacyPathOf(s.of, rel) || !(await exists(to))) continue
    try {
      await setAside(to, s.name)
    } catch (e) {
      throw new Error(`${path.relative(VAULT, to)} isn't ${rel}'s and couldn't be set aside`, { cause: e })
    }
  }
}

/** For tests: forget what this run has brought over, as a restart would. */
export const forgetAdoptions = () => adopting.clear()

// New documents start as untitled.md and take their name from the title once it's written.

export function isUntitled(rel: string) {
  return /^untitled(-\d+)?\.md$/.test(path.posix.basename(rel))
}

/** A document's file name from its title, in any script: "मेरा निबंध" → मेरा-निबंध. A title with nothing nameable (emoji only) gets note-<date>. */
export const slugify = (title: string) => docSlug(title, today())

/** `folder/name.md`, or `folder/name-2.md` and so on if that's taken. */
export async function freePath(folder: string, name: string) {
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
  const kind = platform ?? guess
  // A kind with document defaults (an academic essay in MLA, say) passes them on to its new pieces.
  const meta = { title: '', platform: kind, status: 'draft', created: today(), ...docDefaults(findKind(kinds, kind)?.doc) }
  const rel = await freePath(folder, 'untitled')
  await writeDoc(rel, joinFrontMatter('', meta, ''), { reason: 'create' })
  return rel
}

/** Give an untitled document a file name from its title. Named documents keep theirs, so links to them never break. */
export async function nameDoc(rel: string, title: string) {
  if (!isUntitled(rel) || !title.trim()) return rel
  const name = slugify(title)
  // A title that slugs to the name it already has ("Untitled") stays put rather than hopping to untitled-2.md.
  if (sameName(name, path.posix.basename(rel, '.md'))) return rel
  return moveDoc(rel, await freePath(folderOf(rel), name))
}

/** Rename a document. Its sidecars (history, Thinking Space, Ekdanta's notes on it) move too, if there are any yet. */
async function moveDoc(rel: string, next: string) {
  await adoptOldKey(rel) // so what's still under the old key moves too
  await fs.mkdir(path.dirname(resolveInVault(next)), { recursive: true })
  await fs.rename(resolveInVault(rel), resolveInVault(next))
  cache.invalidate(rel)
  cache.invalidate(next)
  await adoptOldKey(next, { arriving: true }) // whatever is under the new name's keys isn't this document's
  const to = new Map(sidecarsOf(next).map(([abs, name]) => [name, abs]))
  for (const [from, name] of sidecarsOf(rel)) {
    const dest = to.get(name)!
    if (!(await exists(from))) continue
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(from, dest).catch((e) => console.error(`[ekdanta] couldn't move ${name} for ${rel}:`, e))
  }
  await touchOnDisk(next)
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
  await writeDoc(rel, patchContent(await readDoc(rel), patch), { reason })
}

/**
 * A document's front matter, when Ekdanta may change it. A block it can't model is never rewritten,
 * so renaming, starring or copying such a page would only seem to work: say so instead (409).
 */
export async function editableFrontMatter(rel: string, doing: string) {
  const fm = splitFrontMatter(await readDoc(rel))
  if (fm.readonly) throw new HttpError(409, `Can't ${doing} “${fm.meta.title || path.posix.basename(rel, '.md')}”: its front matter can't be edited in Ekdanta. ${fm.problem ?? ''}`.trim())
  return fm
}

/** Rename a document: its title, its file, and every [[link]] to it in the vault. */
export async function renameDoc(rel: string, title: string) {
  title = title.trim()
  if (!title) return rel
  await editableFrontMatter(rel, 'rename')
  await patchDoc(rel, { title }, 'rename')
  const name = slugify(title)
  // macOS may hand back a decomposed (NFD) file name for a title typed composed: still the same name.
  if (sameName(name, path.posix.basename(rel, '.md'))) return rel
  const next = await moveDoc(rel, await freePath(folderOf(rel), name))
  await relink(rel, next)
  return next
}

/** Point [[links]] at a document's new name, in the vault and in Ekdanta's own notes (voice profiles quote by link). */
const relink = (prev: string, next: string) => relinkAll([[prev, next]])

/** Point [[links]] at several documents' new names in one pass over the vault, so a link is changed at most once. */
async function relinkAll(moves: [prev: string, next: string][]) {
  const to = new Map<string, string>()
  for (const [prev, next] of moves) {
    const oldName = path.posix.basename(prev, '.md')
    const newName = path.posix.basename(next, '.md')
    to.set(prev.replace(/\.md$/, ''), next.replace(/\.md$/, ''))
    if (oldName !== newName) to.set(oldName, newName)
  }
  if (!to.size) return
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [...to.keys()].sort((a, b) => b.length - a.length).map(esc)
  const re = new RegExp(`\\[\\[(${names.join('|')})(\\.md)?(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g')
  const fix = (text: string) => text.replace(re, (_m, target: string, ext = '', heading = '', alias = '') => `[[${to.get(target) ?? target}${ext}${heading}${alias}]]`)
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

/** A vault-relative folder in a standard form, refusing dot-folders and anything outside the vault. */
function cleanFolder(folder: string) {
  const f = folder
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
  if (!f || f.split('/').some((part) => !part || part.startsWith('.'))) throw new Error('Not a folder for documents')
  resolveInVault(f)
  return f
}

/**
 * Rename a folder: every document in it (and in its subfolders) moves through moveDoc, so its history,
 * Thinking Space and write record follow, and [[links]] to it are updated. If the new folder already
 * exists the two are merged; a name already taken there gets -2. Other files move with them, and the
 * old folder is removed once it's empty. Returns the documents moved.
 */
export async function renameFolder(from: string, to: string): Promise<{ from: string; to: string }[]> {
  from = cleanFolder(from)
  to = cleanFolder(to)
  if (sameName(from, to)) return []
  if (to.normalize('NFC').startsWith(from.normalize('NFC') + '/')) throw new Error("A folder can't move inside itself")
  const src = resolveInVault(from)
  if (!(await fs.stat(src).catch(() => null))?.isDirectory()) throw new Error(`There's no ${from}/ folder`)
  const depth = from.split('/').length
  const within = (rel: string) => {
    const parts = rel.split('/')
    return parts.length > depth && sameName(parts.slice(0, depth).join('/'), from) ? parts.slice(depth).join('/') : null
  }
  const moved: { from: string; to: string }[] = []
  for (const f of await listFiles()) {
    const rest = within(f.path)
    if (rest === null) continue
    const dir = path.posix.dirname(rest)
    const next = await moveDoc(f.path, await freePath(dir === '.' ? to : `${to}/${dir}`, path.posix.basename(rest, '.md')))
    moved.push({ from: f.path, to: next })
  }
  await relinkAll(moved.map((m) => [m.from, m.to]))
  // Whatever else is left (images, a stray file of the writer's) goes along, beside the documents.
  await moveRest(src, resolveInVault(to))
  return moved
}

async function moveRest(srcDir: string, destDir: string) {
  for (const e of await fs.readdir(srcDir, { withFileTypes: true }).catch(() => [])) {
    const from = path.join(srcDir, e.name)
    if (e.isDirectory()) {
      await moveRest(from, path.join(destDir, e.name))
      continue
    }
    // Finder's own bookkeeping isn't the writer's; it would only keep the old folder from going.
    if (e.name === '.DS_Store') {
      await fs.unlink(from).catch(() => {})
      continue
    }
    await fs.mkdir(destDir, { recursive: true })
    const ext = path.extname(e.name)
    const stem = e.name.slice(0, e.name.length - ext.length)
    let dest = path.join(destDir, e.name)
    for (let n = 2; await exists(dest); n++) dest = path.join(destDir, `${stem}-${n}${ext}`)
    await fs.rename(from, dest).catch((err) => console.error(`[ekdanta] couldn't move ${from}:`, err))
  }
  // Only an empty folder is removed: rmdir refuses one that still holds anything.
  await fs.rmdir(srcDir).catch(() => {})
}

/** Move a document to another folder. A platform's folder makes it a piece for that platform. */
export async function moveToFolder(kinds: Kind[], rel: string, folder: string) {
  folder = folder.replace(/^\/+|\/+$/g, '').trim()
  if (folder.split('/').some((part) => part.startsWith('.'))) throw new Error('Not a folder for documents')
  resolveInVault(folder || '.')
  if (folder === folderOf(rel)) return rel
  const platform = kindOfFolder(kinds, folder)?.id
  // A kind's folder files the page as that kind; one whose front matter can't change can't say so, so it stays put.
  if (platform && splitFrontMatter(await readDoc(rel)).meta.platform?.toLowerCase() !== platform) await editableFrontMatter(rel, 'move')
  const next = await moveDoc(rel, await freePath(folder, path.posix.basename(rel, '.md')))
  if (platform) await patchDoc(next, { platform }, 'move')
  return next
}

/** A copy of a document (and its Thinking Space) to work on separately. */
export async function duplicateDoc(rel: string) {
  // A copy must say it's a copy (and not be starred or published); a block that can't be rewritten can't say that.
  const fm = await editableFrontMatter(rel, 'duplicate')
  const { meta } = fm
  const title = `${meta.title || path.posix.basename(rel, '.md')} (copy)`
  const next = await freePath(folderOf(rel), slugify(title))
  // A copy isn't an exemplar or a published piece until the writer says so.
  const patch: MetaPatch = { title, created: today(), exemplar: null }
  if (meta.status) patch.status = 'draft'
  await writeDoc(next, joinDoc(patchFrontMatter(fm, patch)), { reason: 'duplicate' })
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
  await adoptOldKey(rel)
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
  await adoptOldKey(rel, { arriving: true }) // it brings its own sidecars
  for (const [to, from] of parts(rel)) {
    if (!(await exists(path.join(dir, from)))) continue
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(path.join(dir, from), to).catch(() => {})
  }
  cache.invalidate(rel)
  await touchOnDisk(rel)
  await fs.rm(dir, { recursive: true, force: true })
  return rel
}

// Images pasted or dropped into a document live in attachments/, like Obsidian's default, and the
// document links to them with a relative path, so any Markdown viewer shows them.
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }

export async function saveAsset(doc: string, name: string, base64: string) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase()
  if (!IMAGE_TYPES[ext]) throw new Error('Only images can be added')
  const stem = slug(name.replace(/\.[^.]+$/, ''), 60) || 'image'
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
  // Thinking already done for it counts as content, and so does anything else the writer put beside it.
  if (await exists(resolveInVault(canvasOf(rel)))) return false
  for (const s of sidecarList) if (s.content && (await exists(s.of(rel)))) return false
  await deleteDoc(rel)
  return true
}

/**
 * Remove a document for good, with its sidecars, so a later file of the same name doesn't inherit
 * them. Only for documents with nothing of the writer's in them (an empty draft, an untouched import).
 */
export async function deleteDoc(rel: string) {
  await adoptOldKey(rel)
  await fs.unlink(resolveInVault(rel))
  cache.invalidate(rel)
  for (const [abs] of sidecarsOf(rel)) await fs.rm(abs, { recursive: true, force: true }).catch(() => {})
}

// ---- The vault folder itself ----------------------------------------------------------------

/** Why the vault can't be used (missing and can't be made, a file, not writable), or null if it's fine. */
export async function vaultProblem(): Promise<string | null> {
  try {
    await fs.mkdir(VAULT, { recursive: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTDIR') return 'It’s a file, not a folder'
    if (code === 'EACCES' || code === 'EPERM') return 'Ekdanta isn’t allowed to create it'
    return (e as Error).message
  }
  const stat = await fs.stat(VAULT).catch(() => null)
  if (!stat?.isDirectory()) return 'It’s a file, not a folder'
  try {
    await fs.access(VAULT, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    return 'Ekdanta isn’t allowed to read and write it'
  }
  return null
}

/**
 * Is there nothing in the vault yet? Ekdanta's own .ekdanta folder and other dot-files don't count,
 * nor do empty folders, nor the app's own material files (ideas.md): a vault whose only file is an
 * idea list has no writing in it.
 */
export async function vaultIsEmpty(): Promise<boolean> {
  async function empty(dir: string, rel: string): Promise<boolean> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (!e.isDirectory() && isSpecialFile(child)) continue
      if (!e.isDirectory() || !(await empty(path.join(dir, e.name), child))) return false
    }
    return true
  }
  return empty(VAULT, '')
}

/** Fill an empty vault with a copy of the sample vault. Refuses if the vault has anything in it. */
export async function copySampleVault(from: string) {
  const src = path.resolve(from)
  if (src === VAULT) throw new Error('This is the sample vault')
  if (!(await vaultIsEmpty())) throw new Error('The vault isn’t empty, so the samples weren’t added')
  // Only the writing: not the sample vault's own settings, index or history (dot-folders).
  const visible = (abs: string) => !path.basename(abs).startsWith('.')
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (!visible(e.name)) continue
    await fs.cp(path.join(src, e.name), path.join(VAULT, e.name), { recursive: true, errorOnExist: true, force: false, filter: visible })
  }
  return (await listFiles()).length
}

function firstHeading(body: string) {
  const h = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  // A template's `# {{title}}`, still waiting for the title, isn't one.
  return h && !/^\{\{\s*title\s*\}\}$/i.test(h) ? h : undefined
}

const canvasOf = (rel: string) => rel.replace(/\.md$/, '.canvas')
/** Where a document's Thinking Space keeps what only Ekdanta needs. thinking.ts reads and writes it here, so it follows the document. */
export const thinkingSideFile = (rel: string) => path.join(META_DIR, 'thinking', docKey(rel) + '.json')

// Help history: one JSON object per line, per document.
function historyFile(doc: string) {
  return path.join(META_DIR, 'history', docKey(doc) + '.jsonl')
}

// The built-in sidecars. The names match what older trash folders hold, so those still restore.
registerSidecar('doc.canvas', (rel) => resolveInVault(canvasOf(rel)))
registerSidecar('history.jsonl', historyFile)
registerSidecar('thinking.json', thinkingSideFile)
registerSidecar('written.json', writtenInfo)
registerSidecar('written.md', writtenBody)

export async function appendHistory(doc: string, item: unknown) {
  resolveInVault(doc)
  await adoptOldKey(doc)
  const file = historyFile(doc)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(item) + '\n', 'utf8')
}

/** Clear a document's help log. The file stays, empty, so the log reads empty after a reload too. */
export async function clearHistory(doc: string) {
  resolveInVault(doc)
  await adoptOldKey(doc)
  await fs.truncate(historyFile(doc), 0).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
}

export async function readHistory(doc: string): Promise<unknown[]> {
  resolveInVault(doc)
  await adoptOldKey(doc)
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
