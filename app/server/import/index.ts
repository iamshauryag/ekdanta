// Importing files into the vault as clean Markdown notes, with a review step.
//
// A batch is one visit to the Import sheet: .ekdanta/import/<batch>/ holds a manifest, a copy of every
// original (originals/), and each file's converted text and pictures (items/<id>/). Nothing reaches
// the vault until the writer imports a row; then the note is written, its pictures go to
// attachments/<note>/, and a ledger remembers the original's hash, so the same file is recognised
// next time. Undo takes a batch's notes and pictures back out. Originals always stay.
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadSettings } from '../settings.ts'
import { HttpError, runTool, which } from '../net.ts'
import { deleteDoc, freePath, hashOf, META_DIR, readDoc, resolveInVault, slugify, trashDoc, writeDoc } from '../vault.ts'
import { csvToMarkdown } from './csv.ts'
import { docxToMarkdown, ImportError } from './docx.ts'
import { dateOf, htmlToMarkdown, type Converted } from './html.ts'
import { splitFrontMatter } from '../../src/lib/frontmatter.ts'
import { buildNote, countWords, firstHeading, guessPlatform, titleFromFileName, ymd } from './meta.ts'
import { MEDIA_PREFIX } from './sanitize.ts'
import { clippingsToMarkdown, decodeText, isKindleClippings, normalizeNewlines, textToMarkdown } from './text.ts'

export const IMPORT_DIR = path.join(META_DIR, 'import')
const LEDGER = path.join(IMPORT_DIR, 'ledger.json')
export const INBOX = '_inbox'
/** Where notes go when no kind is chosen. */
export const DEFAULT_FOLDER = 'imported'
/** The most one upload may be. The app asks before sending anything over 50 MB. */
const MAX_BYTES = 1024 * 1024 * 1024

export type FileType = 'docx' | 'doc' | 'html' | 'text' | 'markdown' | 'rtf' | 'csv' | 'other'
export type ItemStatus = 'pending' | 'converted' | 'review' | 'failed' | 'duplicate' | 'unsupported'

export interface ImportItem {
  id: string
  /** The original's name (sanitised). */
  name: string
  type: FileType
  size: number
  sha: string
  /** The original's place in the vault's _inbox/, for files found there. */
  inbox?: string
  /** 'pandoc', 'textutil' or 'built-in'. */
  converter?: string
  status: ItemStatus
  /** Why it failed, or what it duplicates. */
  reason?: string
  notes: string[]
  words: number
  title: string
  created: string
  /** The guessed kind. */
  platform?: string
  folder: string
  /** Set once it's in the vault. */
  imported?: { path: string; media: string[]; hash: string }
}

interface Manifest {
  id: string
  created: string
  items: ImportItem[]
}

export interface BatchView {
  batch: string
  items: ImportItem[]
  pandoc: boolean
  inbox: string
}

// ---- Names and paths ------------------------------------------------------------------------------

/**
 * A file name from the browser, reduced to a safe base name: no folders, no `..`, no absolute paths,
 * no characters a file system rejects, not hidden. '../../etc/x.docx' → 'x.docx'.
 */
export function safeName(raw: string): string {
  let s = raw
  try {
    s = decodeURIComponent(raw)
  } catch {
    /* already plain */
  }
  s = s.replace(/\\/g, '/').split('/').pop() ?? ''
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim()
  s = s.replace(/^[.\s]+/, '')
  if (!s) s = 'file'
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 12)
    s = s.slice(0, 120 - ext.length) + ext
  }
  return s
}

/** A folder for notes typed by the writer: vault-relative, no `..`, no hidden folders, not the inbox. */
export function cleanFolder(raw: string): string {
  const f = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')
  if (f.split('/').some((p) => p === '..' || p.startsWith('.'))) throw new HttpError(400, 'That folder name can’t be used')
  if (f.split('/')[0]?.toLowerCase() === INBOX) throw new HttpError(400, 'Notes can’t be imported into _inbox')
  return f
}

const batchDir = (batch: string) => {
  if (!/^[a-z0-9-]{6,40}$/.test(batch)) throw new HttpError(400, 'No such import')
  return path.join(IMPORT_DIR, batch)
}

/** A path inside a folder, refusing anything that would land outside it. */
function inside(dir: string, ...parts: string[]) {
  const abs = path.resolve(dir, ...parts)
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new HttpError(400, 'Path outside the import folder')
  return abs
}

const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )

/** `name.ext`, or `name-2.ext` and so on, free in `dir`. */
async function freeFile(dir: string, name: string) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = n > 1 ? `${stem}-${n}${ext}` : name
    if (!(await exists(inside(dir, candidate)))) return candidate
  }
}

// ---- Detecting the type --------------------------------------------------------------------------

const BY_EXT: Record<string, FileType> = {
  '.docx': 'docx',
  '.doc': 'doc',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.txt': 'text',
  '.text': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.rtf': 'rtf',
  '.csv': 'csv',
  '.tsv': 'csv',
}

/** What a file is, from its extension, corrected by its first bytes when they say otherwise. */
export function detectType(name: string, head: Buffer): FileType {
  const byExt = BY_EXT[path.extname(name).toLowerCase()] ?? 'other'
  const sniffed = sniff(head)
  if (!sniffed || sniffed === byExt) return byExt
  // Binary formats can't be text, whatever the name says. An .rtf saved as .doc is common.
  const loose = byExt === 'other' || byExt === 'text' || byExt === 'markdown'
  if (sniffed === 'docx') return loose || byExt === 'doc' ? 'docx' : byExt
  if (sniffed === 'rtf') return loose || byExt === 'doc' || byExt === 'docx' ? 'rtf' : byExt
  // An OLE file named .docx is a password-protected .docx, which the .docx converter explains.
  if (sniffed === 'doc') return byExt === 'docx' ? 'docx' : loose ? 'doc' : byExt
  if (sniffed === 'html' && byExt === 'other') return 'html'
  return byExt
}

function sniff(head: Buffer): FileType | null {
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return head.includes(Buffer.from('word/')) || head.includes(Buffer.from('[Content_Types].xml')) ? 'docx' : null
  if (head.length >= 8 && head.readUInt32BE(0) === 0xd0cf11e0) return 'doc'
  const start = head
    .subarray(0, 512)
    .toString('latin1')
    .replace(/^﻿|^\xEF\xBB\xBF/, '')
    .trimStart()
  if (start.startsWith('{\\rtf')) return 'rtf'
  if (/^<(!doctype html|html[\s>])/i.test(start)) return 'html'
  return null
}

// ---- Converting -----------------------------------------------------------------------------------

let pandocPath: Promise<string | null> | null = null
/** Pandoc, if it's installed and not switched off with EKDANTA_NO_PANDOC=1. */
export function findPandoc(): Promise<string | null> {
  if (process.env.EKDANTA_NO_PANDOC === '1') return Promise.resolve(null)
  pandocPath ??= which('pandoc')
  return pandocPath
}

let textutilPath: Promise<string | null> | null = null
const findTextutil = () => (textutilPath ??= process.platform === 'darwin' ? which('textutil') : Promise.resolve(null))

interface Output extends Converted {
  converter: string
  status?: ItemStatus
  reason?: string
}

/** Convert one original. Never throws: a failure is a row that says why. */
async function convertFile(abs: string, name: string, type: FileType, work: string): Promise<Output> {
  const prefix = slugify(name.replace(/\.[^.]+$/, '')).slice(0, 40) || 'file'
  const buf = await fs.readFile(abs)
  try {
    switch (type) {
      case 'docx': {
        const pandoc = await findPandoc()
        if (pandoc) {
          try {
            return { ...(await docxToMarkdown(buf, abs, { pandoc, work, prefix })), converter: 'pandoc' }
          } catch (e) {
            if (e instanceof ImportError) throw e
            // Pandoc choked on it; the built-in converter may still manage.
          }
        }
        return { ...(await docxToMarkdown(buf, abs, { pandoc: null, work, prefix })), converter: 'built-in' }
      }
      case 'html':
        return { ...htmlToMarkdown(decodeText(buf).text, { article: true, prefix }), converter: 'built-in' }
      case 'text': {
        const { text } = decodeText(buf)
        if (isKindleClippings(name, text))
          return { markdown: clippingsToMarkdown(text), media: [], notes: ['Kindle highlights — the Brain imports these per book'], converter: 'built-in', title: 'Kindle highlights' }
        return { markdown: textToMarkdown(text), media: [], notes: [], converter: 'built-in' }
      }
      case 'markdown':
        return { markdown: normalizeNewlines(decodeText(buf).text), media: [], notes: [], converter: 'built-in' }
      case 'csv': {
        const { text } = decodeText(buf)
        const csv = csvToMarkdown(text, { attachment: MEDIA_PREFIX + mediaName(name), delimiter: path.extname(name).toLowerCase() === '.tsv' ? '\t' : undefined })
        const notes = csv.dropped ? [`Only the first ${csv.rows - csv.dropped} rows are in the table; the whole file is attached`] : []
        return { markdown: csv.markdown, media: csv.dropped ? [{ name: mediaName(name), data: buf }] : [], notes, converter: 'built-in' }
      }
      case 'rtf':
      case 'doc': {
        const textutil = await findTextutil()
        const pandoc = type === 'rtf' ? await findPandoc() : null
        let html: string
        let converter: string
        if (textutil) {
          html = (await runTool(textutil, ['-convert', 'html', '-stdout', abs], { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout
          converter = 'textutil'
        } else if (pandoc) {
          html = (await runTool(pandoc, ['-f', 'rtf', '-t', 'html5', abs], { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout
          converter = 'pandoc'
        } else if (type === 'doc') throw new ImportError('Older Word files (.doc) need macOS. Save it as .docx in Word, then import it again')
        else throw new ImportError('Rich text (.rtf) needs macOS or Pandoc')
        const out = htmlToMarkdown(html, { prefix })
        // textutil names the page after the file; that's not a title.
        return { ...out, title: undefined, converter }
      }
      default:
        return {
          markdown: `This file is attached as it is: [${name.replace(/[[\]]/g, '')}](${MEDIA_PREFIX}${mediaName(name)})\n`,
          media: [{ name: mediaName(name), data: buf }],
          notes: [],
          converter: 'built-in',
          status: 'unsupported',
          reason: 'Unsupported type',
        }
    }
  } catch (e) {
    const reason = e instanceof ImportError ? e.message : `Couldn’t convert it: ${(e as Error).message.split('\n')[0].slice(0, 160)}`
    return { markdown: '', media: [], notes: [], converter: type === 'docx' && (await findPandoc()) ? 'pandoc' : 'built-in', status: 'failed', reason }
  }
}

/** A file name safe to keep as an attachment: the original's, slugged, with its extension. */
const mediaName = (name: string) => {
  const ext = path
    .extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '')
  return (slugify(name.slice(0, name.length - path.extname(name).length)) || 'file') + ext
}

// ---- Batches ----------------------------------------------------------------------------------

// Manifest and ledger changes happen one at a time (conversions run outside this queue).
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function readManifest(batch: string): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(path.join(batchDir(batch), 'manifest.json'), 'utf8')) as Manifest
  } catch {
    throw new HttpError(404, 'No such import')
  }
}
const writeManifest = (m: Manifest) => fs.writeFile(path.join(batchDir(m.id), 'manifest.json'), JSON.stringify(m, null, 1))

type Ledger = Record<string, { batch: string; id: string; path: string }>
async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER, 'utf8')) as Ledger
  } catch {
    return {}
  }
}
const writeLedger = async (l: Ledger) => {
  await fs.mkdir(IMPORT_DIR, { recursive: true })
  await fs.writeFile(LEDGER, JSON.stringify(l, null, 1))
}

/** Start an import: a new batch, holding whatever is waiting in _inbox/. */
export async function openBatch(): Promise<BatchView> {
  await pruneBatches()
  const now = new Date()
  const id = `${ymd(now).replace(/-/g, '')}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}-${randomBytes(3).toString('hex')}`
  const dir = batchDir(id)
  await fs.mkdir(path.join(dir, 'originals'), { recursive: true })
  const manifest: Manifest = { id, created: now.toISOString(), items: [] }
  for (const rel of await inboxFiles()) {
    const abs = resolveInVault(rel)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat?.isFile()) continue
    const name = await freeFile(path.join(dir, 'originals'), safeName(path.posix.basename(rel)))
    await fs.copyFile(abs, inside(path.join(dir, 'originals'), name))
    const item = await newItem(manifest, name, stat.mtime, rel)
    manifest.items.push(item)
  }
  await writeManifest(manifest)
  return { batch: id, items: manifest.items, pandoc: !!(await findPandoc()), inbox: INBOX }
}

/** Files waiting in the vault's _inbox/ (any depth), oldest first. Hidden files are skipped. */
async function inboxFiles(): Promise<string[]> {
  const out: { rel: string; mtime: number }[] = []
  async function walk(rel: string) {
    for (const e of await fs.readdir(resolveInVault(rel), { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) await walk(child)
      else if (e.isFile()) out.push({ rel: child, mtime: (await fs.stat(resolveInVault(child))).mtimeMs })
    }
  }
  await walk(INBOX)
  return out.sort((a, b) => a.mtime - b.mtime || a.rel.localeCompare(b.rel)).map((f) => f.rel)
}

/** A row for an original already copied into the batch, waiting to be converted. */
async function newItem(m: Manifest, name: string, mtime: Date, inbox?: string): Promise<ImportItem> {
  const abs = inside(path.join(batchDir(m.id), 'originals'), name)
  const buf = await fs.readFile(abs)
  const id = String(m.items.length + 1).padStart(3, '0') + '-' + randomBytes(2).toString('hex')
  return {
    id,
    name,
    type: detectType(name, buf.subarray(0, 4096)),
    size: buf.length,
    sha: createHash('sha256').update(buf).digest('hex'),
    inbox,
    status: 'pending',
    notes: [],
    words: 0,
    title: titleFromFileName(name),
    created: ymd(mtime),
    folder: DEFAULT_FOLDER,
  }
}

/** Save an upload's bytes (streamed, never buffered whole) into the batch, then convert it. */
export async function addUpload(batch: string, rawName: string, mtime: number, body: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<ImportItem> {
  const dir = path.join(batchDir(batch), 'originals')
  await readManifest(batch)
  const name = await serial(async () => {
    const n = await freeFile(dir, safeName(rawName))
    await fs.writeFile(inside(dir, n), '', { flag: 'wx' }) // claim the name
    return n
  })
  const abs = inside(dir, name)
  const out = await fs.open(abs, 'w')
  let size = 0
  try {
    for await (const chunk of body) {
      size += chunk.length
      if (size > MAX_BYTES) throw new HttpError(413, 'That file is too big to import (over 1 GB)')
      await out.write(chunk)
    }
  } catch (e) {
    await out.close()
    await fs.rm(abs, { force: true })
    throw e
  }
  await out.close()
  const id = await serial(async () => {
    const m = await readManifest(batch)
    const item = await newItem(m, name, new Date(Number.isFinite(mtime) && mtime > 0 ? mtime : Date.now()))
    m.items.push(item)
    await writeManifest(m)
    return item.id
  })
  return convert(batch, id)
}

/** Convert a waiting row (or convert it again). */
export async function convert(batch: string, id: string): Promise<ImportItem> {
  const m = await readManifest(batch)
  const item = m.items.find((i) => i.id === id)
  if (!item) throw new HttpError(404, 'No such file in this import')
  if (item.imported) return item
  const dir = batchDir(batch)
  const work = inside(dir, 'items', item.id)
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(path.join(work, 'media'), { recursive: true })
  const out = await convertFile(inside(path.join(dir, 'originals'), item.name), item.name, item.type, work)
  for (const media of out.media) await fs.writeFile(inside(path.join(work, 'media'), safeName(media.name)), media.data)
  await fs.writeFile(path.join(work, 'out.md'), out.markdown)
  const kinds = (await loadSettings()).kinds
  const platform =
    out.status === 'failed'
      ? undefined
      : guessPlatform(
          out.markdown,
          kinds.map((k) => k.id),
        )
  const ledger = await readLedger()
  return serial(async () => {
    const fresh = await readManifest(batch)
    const it = fresh.items.find((i) => i.id === id)!
    it.converter = out.converter
    it.notes = out.notes
    it.words = countWords(out.markdown)
    // The title: the text's own front matter, else its top heading, else what the file's
    // properties say, else any heading, else the file name.
    const own = splitFrontMatter(out.markdown).meta
    const h1 = out.markdown.match(/^#[ \t]+\S.*$/m)?.[0]
    // A multi-line <title> or dc:title becomes one line.
    const oneLine = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim()
    it.title = oneLine(own.title) || (h1 && firstHeading(h1)) || oneLine(out.title) || firstHeading(out.markdown) || titleFromFileName(item.name)
    it.created = out.created ?? dateOf(own.created) ?? it.created
    it.platform = platform
    it.folder = (platform && kinds.find((k) => k.id === platform)?.folder) || DEFAULT_FOLDER
    const earlier = ledger[it.sha]
    const twin = fresh.items.find((o) => o.id !== it.id && o.sha === it.sha && o.id < it.id)
    if (out.status) {
      it.status = out.status
      it.reason = out.reason
    } else if (earlier && (await exists(resolveInVault(earlier.path)))) {
      it.status = 'duplicate'
      it.reason = `Already imported as ${earlier.path}`
    } else if (twin) {
      it.status = 'duplicate'
      it.reason = `The same file as ${twin.name}`
    } else if (!it.words && !out.media.length) {
      it.status = 'review'
      it.notes = [...it.notes, 'No text was found in it']
    } else {
      it.status = it.notes.length ? 'review' : 'converted'
      it.reason = undefined
    }
    await writeManifest(fresh)
    return it
  })
}

/** The note a row would become, front matter and all, as Markdown. */
export async function preview(batch: string, id: string, platform?: string): Promise<string> {
  const m = await readManifest(batch)
  const item = m.items.find((i) => i.id === id)
  if (!item) throw new HttpError(404, 'No such file in this import')
  if (item.status === 'failed' || item.status === 'pending') return ''
  const md = await fs.readFile(path.join(inside(batchDir(batch), 'items', item.id), 'out.md'), 'utf8').catch(() => '')
  return buildNote(md, noteMeta(item, platform ?? item.platform))
}

const noteMeta = (item: ImportItem, platform: string | undefined) => ({ title: item.title, created: item.created, imported: ymd(new Date()), source: item.name, platform: platform || undefined })

/** Write a row into the vault as a note. Returns the row, with where its note is. */
export async function commit(batch: string, id: string, choice: { platform?: string; folder?: string }): Promise<ImportItem> {
  const kinds = (await loadSettings()).kinds
  const platform = choice.platform && kinds.some((k) => k.id === choice.platform) ? choice.platform : undefined
  const folder = cleanFolder(choice.folder ?? DEFAULT_FOLDER)
  return serial(async () => {
    const m = await readManifest(batch)
    const item = m.items.find((i) => i.id === id)
    if (!item) throw new HttpError(404, 'No such file in this import')
    if (item.imported) return item
    if (item.status === 'failed' || item.status === 'pending') throw new HttpError(409, item.reason ?? 'It hasn’t been converted')
    const work = inside(batchDir(batch), 'items', item.id)
    let md = await fs.readFile(path.join(work, 'out.md'), 'utf8')
    const rel = await freePath(folder, slugify(item.title))
    const stem = path.posix.basename(rel, '.md')
    // Pictures go to attachments/<note>/, a folder of the note's own.
    const media: string[] = []
    const names = (await fs.readdir(path.join(work, 'media')).catch(() => [] as string[])).filter((n) => md.includes(MEDIA_PREFIX + n))
    if (names.length) {
      let dir = `attachments/${stem}`
      for (let n = 2; await exists(resolveInVault(dir)); n++) dir = `attachments/${stem}-${n}`
      await fs.mkdir(resolveInVault(dir), { recursive: true })
      for (const name of names) {
        const target = `${dir}/${name}`
        await fs.copyFile(inside(path.join(work, 'media'), name), resolveInVault(target))
        media.push(target)
        const link = path.posix
          .relative(folder || '.', target)
          .split('/')
          .map(encodeURIComponent)
          .join('/')
        md = md.split(MEDIA_PREFIX + name).join(link)
      }
    }
    const note = buildNote(md, noteMeta(item, platform))
    await writeDoc(rel, note, { reason: 'import' })
    item.imported = { path: rel, media, hash: hashOf(note) }
    item.platform = platform
    item.folder = folder
    // A file from the inbox leaves it now, and only now (its copy stays in originals/).
    if (item.inbox) {
      const abs = resolveInVault(item.inbox)
      const now = await fs.readFile(abs).catch(() => null)
      if (now && createHash('sha256').update(now).digest('hex') === item.sha) await fs.unlink(abs).catch(() => {})
    }
    const ledger = await readLedger()
    ledger[item.sha] = { batch, id: item.id, path: rel }
    await writeLedger(ledger)
    await writeManifest(m)
    return item
  })
}

export interface Undone {
  /** Notes taken out of the vault, deleted or moved to Recently deleted. */
  removed: string[]
  /** Notes the writer had changed: they're in Recently deleted, their pictures still in attachments/. */
  trashed: string[]
  /** Notes no longer where they were imported (renamed, moved or deleted since); they and their pictures are left alone. */
  missing: string[]
}

/**
 * Take a batch's notes and pictures back out of the vault and return inbox files to _inbox/. Only a
 * note the writer hasn't touched is deleted, with its pictures. One they've changed goes to Recently
 * deleted and keeps its pictures, so restoring it brings back a working note; one that's been renamed
 * or moved is left where it is, pictures and all.
 */
export async function undo(batch: string): Promise<Undone> {
  return serial(async () => {
    const m = await readManifest(batch)
    const ledger = await readLedger()
    const result: Undone = { removed: [], trashed: [], missing: [] }
    for (const item of m.items) {
      const done = item.imported
      if (!done) continue
      const text = await readDoc(done.path).catch(() => null)
      if (text === null) result.missing.push(done.path)
      else if (hashOf(text) !== done.hash) {
        await trashDoc(done.path)
        result.trashed.push(done.path)
        result.removed.push(done.path)
      } else {
        await deleteDoc(done.path)
        result.removed.push(done.path)
        for (const rel of done.media) await fs.rm(resolveInVault(rel), { force: true })
        const dirs = new Set(done.media.map((rel) => path.posix.dirname(rel)))
        for (const dir of dirs) await fs.rmdir(resolveInVault(dir)).catch(() => {}) // only if empty
      }
      if (item.inbox && !(await exists(resolveInVault(item.inbox)))) {
        await fs.mkdir(path.dirname(resolveInVault(item.inbox)), { recursive: true })
        await fs.copyFile(inside(path.join(batchDir(batch), 'originals'), item.name), resolveInVault(item.inbox))
      }
      if (ledger[item.sha]?.batch === batch && ledger[item.sha]?.id === item.id) delete ledger[item.sha]
      item.imported = undefined
    }
    await writeLedger(ledger)
    await writeManifest(m)
    return result
  })
}

/** Remove batches nothing was imported from, once they're a day old (their originals are still where they came from). */
async function pruneBatches() {
  const day = 24 * 60 * 60 * 1000
  for (const e of await fs.readdir(IMPORT_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^[a-z0-9-]{6,40}$/.test(e.name)) continue
    const m = await readManifest(e.name).catch(() => null)
    const age = m ? Date.now() - Date.parse(m.created) : Infinity
    if ((!m || !m.items.some((i) => i.imported)) && age > day) await fs.rm(path.join(IMPORT_DIR, e.name), { recursive: true, force: true })
  }
}
