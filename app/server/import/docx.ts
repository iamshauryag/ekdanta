// Word documents. Pandoc, when it's installed, makes the best Markdown; without it, mammoth turns the
// document into HTML and the HTML path takes over. Either way tracked changes come out accepted,
// comments are left out (with a note saying so), and pictures become attachments.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import mammoth from 'mammoth'
import { runTool } from '../net.ts'
import { dateOf, htmlToMarkdown, tidy, type Converted } from './html.ts'
import { MEDIA_PREFIX, type Media } from './sanitize.ts'

/** A conversion that can't go ahead, with the reason in words the writer can act on. */
export class ImportError extends Error {}

// ---- Reading the .docx container (a zip) ---------------------------------------------------------

/** The files in a zip, by name, read on demand. Throws ImportError if it isn't a readable zip. */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>()
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ImportError('The file is damaged or isn’t a Word document')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ImportError('The file is damaged or isn’t a Word document')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    out.set(name, () => {
      if (flags & 1) throw new ImportError('The document is password-protected')
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ImportError('The file is damaged')
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const raw = buf.subarray(start, start + size)
      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      throw new ImportError('The document uses a compression Ekdanta can’t read')
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const isCfb = (buf: Buffer) => buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1

/** Why a .docx can't be read, or null if it looks like one. */
export function docxProblem(buf: Buffer): string | null {
  if (isCfb(buf)) {
    // Word saves a password-protected .docx inside an OLE container with an EncryptionInfo stream.
    if (buf.includes(Buffer.from('EncryptionInfo', 'utf16le'))) return 'The document is password-protected. Remove the password in Word, then import it again'
    return 'This is an older Word file (.doc). Save it as .docx in Word, then import it again'
  }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return 'The file is damaged or isn’t a Word document'
  try {
    if (!readZip(buf).has('word/document.xml')) return 'The file is a zip, but not a Word document'
  } catch (e) {
    return (e as Error).message
  }
  return null
}

/** What the document's properties say: its title and when it was created. */
export function docxProperties(zip: Map<string, () => Buffer>): { title?: string; created?: string } {
  const core = zip.get('docProps/core.xml')
  if (!core) return {}
  const xml = core().toString('utf8')
  const title = decodeXml(xml.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] ?? '').trim() || undefined
  const created = dateOf(xml.match(/<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/)?.[1])
  return { title, created }
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

/** Comments, tracked changes and merged table cells: what the review sheet should mention. */
export function docxFeatures(zip: Map<string, () => Buffer>) {
  const doc = zip.get('word/document.xml')?.().toString('utf8') ?? ''
  const comments = (
    zip
      .get('word/comments.xml')?.()
      .toString('utf8')
      .match(/<w:comment\b/g) ?? []
  ).length
  return {
    comments,
    tracked: /<w:(ins|del)\b/.test(doc),
    merged: /<w:gridSpan\s+w:val="([2-9]|\d\d+)"/.test(doc) || /<w:vMerge\b/.test(doc),
  }
}

// ---- Converting -------------------------------------------------------------------------------

/**
 * A .docx as Markdown. `pandoc`: the path to pandoc, or null to use the built-in converter.
 * `work`: a scratch folder for pandoc's extracted media. `prefix` names the pictures.
 */
export async function docxToMarkdown(buf: Buffer, file: string, opts: { pandoc: string | null; work: string; prefix: string }): Promise<Converted> {
  const problem = docxProblem(buf)
  if (problem) throw new ImportError(problem)
  const zip = readZip(buf)
  const props = docxProperties(zip)
  const features = docxFeatures(zip)
  const notes: string[] = []
  if (features.tracked) notes.push('Tracked changes were accepted')
  if (features.comments) notes.push(`${features.comments === 1 ? 'A comment was' : `${features.comments} comments were`} left out`)
  let out: Converted
  if (opts.pandoc) out = await viaPandoc(file, opts.pandoc, opts.work, opts.prefix, features.merged)
  else {
    const result = await mammoth.convertToHtml({ buffer: buf }, { styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"], includeDefaultStyleMap: true })
    out = htmlToMarkdown(result.value, { prefix: opts.prefix })
  }
  return { ...out, title: props.title, created: props.created, notes: [...notes, ...out.notes] }
}

async function viaPandoc(file: string, pandoc: string, work: string, prefix: string, merged: boolean): Promise<Converted> {
  const mediaDir = path.join(work, 'pandoc-media')
  await fs.rm(mediaDir, { recursive: true, force: true })
  // Merged cells can't be a Markdown table; going through HTML keeps them as an HTML table.
  const to = merged ? 'html5' : 'gfm-raw_html+footnotes'
  const { stdout } = await runTool(pandoc, ['-f', 'docx', '-t', to, '--wrap=none', '--track-changes=accept', `--extract-media=${mediaDir}`, file], { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 })
  // Pictures come out as files under mediaDir; they're renamed for the note and linked by name.
  const media: Media[] = []
  const renames = new Map<string, string>()
  for (const abs of await walk(mediaDir)) {
    const ext = path.extname(abs).toLowerCase() || '.bin'
    const name = `${prefix}-${media.length + 1}${ext}`
    media.push({ name, data: await fs.readFile(abs) })
    renames.set(abs, name)
  }
  await fs.rm(mediaDir, { recursive: true, force: true })
  const relink = (text: string) => {
    for (const [abs, name] of renames) text = text.split(abs).join(MEDIA_PREFIX + name)
    return text
  }
  if (merged) {
    const out = htmlToMarkdown(relink(stdout), { prefix })
    return { ...out, media: [...media, ...out.media] }
  }
  return { markdown: tidy(relink(stdout)), media, notes: [] }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(abs)))
    else if (e.isFile()) out.push(abs)
  }
  return out.sort()
}
