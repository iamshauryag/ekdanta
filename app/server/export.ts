// Export: a document as a .docx, a standalone HTML page or clean Markdown, downloaded or saved to
// exports/ in the vault. The source file is only ever read. Word files come from pandoc when it's
// installed (it runs on this machine, so the route is local-only) and from the built-in engine
// otherwise. Images reach either engine only as data: URIs made here from files in the vault, and
// pandoc runs sandboxed, so neither reads a file or fetches anything a note points it at. Copying as
// text and printing to PDF happen in the app, from the same prepare().
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { docTitle, exportName, htmlDocument, prepare, syntaxWarnings, toMarkdown, type Prepared } from '../src/lib/plaintext.ts'
import { builtinDocx } from './export-docx.ts'
import { HttpError, runTool, which } from './net.ts'
import { atomicWrite, listFiles, readDoc, resolveInVault, VAULT } from './vault.ts'

export type FileFormat = 'docx' | 'html' | 'md'
export interface ExportRequest {
  path: string
  format: FileFormat
  options?: { destination?: 'download' | 'vault' }
}
export interface ExportResult {
  data: Buffer
  type: string
  name: string
  engine: 'pandoc' | 'built-in' | null
  warnings: string[]
  /** Where it was saved in the vault, when it was. */
  saved?: string
}

const TYPES: Record<FileFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
}
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' }

// ---- Pandoc -----------------------------------------------------------------------------------

let found: { at: number; info: Promise<{ path: string; version: string } | null> } | null = null

/** Pandoc 2.15 or later is the first that can run with --sandbox: no reading files or fetching URLs a document names. */
export const canSandbox = (version: string) => {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 2 || (major === 2 && minor >= 15)
}

/**
 * Pandoc, if it's installed and can be sandboxed (looked for again after a minute, so installing it
 * needs no restart). An older one is left alone and the built-in engine makes Word files instead.
 * EKDANTA_NO_PANDOC=1 hides it.
 */
export function pandoc(): Promise<{ path: string; version: string } | null> {
  if (process.env.EKDANTA_NO_PANDOC === '1') return Promise.resolve(null)
  if (!found || Date.now() - found.at > 60_000) {
    const info = (async () => {
      const bin = await which('pandoc')
      if (!bin) return null
      try {
        const { stdout } = await runTool(bin, ['--version'], { timeoutMs: 10_000 })
        const version = stdout.match(/pandoc\S*\s+([\d.]+)/)?.[1] ?? ''
        return canSandbox(version) ? { path: bin, version } : null
      } catch {
        return null
      }
    })()
    found = { at: Date.now(), info }
  }
  return found.info
}

// CommonMark, as the editor reads it, with the extras Ekdanta writes and footnotes; without the
// extensions that would change the writer's text (smart quotes, emoji, sub/superscript, maths).
const PANDOC_FROM =
  'commonmark_x+hard_line_breaks-smart-emoji-subscript-superscript-tex_math_dollars-yaml_metadata_block-fancy_lists-alerts-raw_attribute-fenced_divs-definition_lists-implicit_header_references'
// Pandoc's CommonMark reads [x]{.underline} as a span; Word wants it underlined.
const UNDERLINE_FILTER = `function Span(el)
  if el.classes:includes('underline') then return pandoc.Underline(el.content) end
end
`

/** <u> and ==highlight== as the spans pandoc's CommonMark understands, outside code. */
export function forPandoc(body: string): string {
  let fence: string | null = null
  return body
    .split('\n')
    .map((line) => {
      const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1]
      if (fence) {
        if (f && f[0] === fence[0] && f.length >= fence.length) fence = null
        return line
      }
      if (f) {
        fence = f
        return line
      }
      if (/^( {4}|\t)/.test(line)) return line
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) =>
          i % 2
            ? part
            : part
                .replace(/<u>([\s\S]*?)<\/u>/gi, '[$1]{.underline}')
                .replace(/==(?=\S)([^=\n]*?\S)==/g, '[$1]{.mark}')
                .replace(/<\/?u>/gi, ''),
        )
        .join('')
    })
    .join('\n')
}

async function pandocDocx(bin: string, p: Prepared): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-export-'))
  try {
    const input = path.join(dir, 'in.md')
    const filter = path.join(dir, 'underline.lua')
    const output = path.join(dir, 'out.docx')
    await fs.writeFile(input, forPandoc(p.body))
    await fs.writeFile(filter, UNDERLINE_FILTER)
    const meta = (['title', 'author', 'date'] as const).flatMap((k) => (p[k] ? ['-M', `${k}=${p[k]}`] : []))
    // --sandbox: the only files pandoc reads are the ones named here; images come as data: URIs.
    await runTool(bin, ['--sandbox', '-f', PANDOC_FROM, '-t', 'docx', '--lua-filter', filter, ...meta, '-o', output, input], { timeoutMs: 60_000, cwd: dir })
    return await fs.readFile(output)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- Export -----------------------------------------------------------------------------------

const folderOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const rel = (from: string, to: string) => path.posix.relative(from || '.', to) || '.'

export async function exportDoc(req: ExportRequest): Promise<ExportResult> {
  const { path: doc, format } = req
  const toVault = req.options?.destination === 'vault'
  if (!['docx', 'html', 'md'].includes(format)) throw new HttpError(400, `Unknown format: ${format}`)
  if (typeof doc !== 'string' || !doc.endsWith('.md')) throw new HttpError(400, 'Only documents can be exported')
  const content = await readDoc(doc).catch(() => {
    throw new HttpError(404, 'No such document')
  })
  const files = await listFiles()
  const docDir = folderOf(doc)
  // Where the file will sit, for the relative links and images clean Markdown keeps.
  const destDir = toVault ? 'exports' : docDir

  const byName = new Map<string, { title: string; path: string }>()
  for (const f of files) {
    const page = { title: f.title, path: f.path }
    byName.set(f.path.replace(/\.md$/, ''), page)
    if (!byName.has(f.path.replace(/\.md$/, '').split('/').pop()!)) byName.set(f.path.replace(/\.md$/, '').split('/').pop()!, page)
  }
  const lower = new Map([...byName].map(([k, v]) => [k.toLowerCase(), v]))
  const page = (target: string) => byName.get(target) ?? lower.get(target.toLowerCase()) ?? null

  // Every image in the document comes through here (prepare() finds them all, however written). A
  // file is used only if it is in the vault, symlinks followed; anything else is left out with a warning.
  const vaultReal = await fs.realpath(VAULT)
  const image = async (src: string): Promise<{ src?: string; warning?: string }> => {
    if (/^data:/i.test(src)) return { src }
    if (/^https?:/i.test(src)) {
      // Word files are built here, offline: a picture on the web would have to be fetched.
      if (format === 'docx') return { warning: `Image on the web not embedded: ${src}` }
      return { src }
    }
    let file: string
    let inVault: string
    try {
      if (!src) throw new Error('No image')
      inVault = path.posix.normalize(path.posix.join(docDir, decodeURI(src).replace(/^\/+/, '')))
      file = await fs.realpath(resolveInVault(inVault))
      if (!file.startsWith(vaultReal + path.sep) || !(await fs.stat(file)).isFile()) throw new Error('Not in the vault')
    } catch {
      return { warning: `Image missing: ${src}` }
    }
    if (format === 'md') return { src: encodeURI(rel(destDir, inVault)) }
    // HTML carries its images inside; so does a Word file, and the engines read nothing themselves.
    const type = IMAGE_TYPES[file.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '']
    if (!type) return { warning: `Not an image: ${src}` }
    return { src: `data:${type};base64,${(await fs.readFile(file)).toString('base64')}` }
  }
  // prepare() is synchronous: a first pass finds the images, which are then looked up.
  const looked = new Map<string, { src?: string; warning?: string }>()
  prepare(content, { page, image: (src) => (looked.set(src, {}), {}) })
  for (const s of looked.keys()) looked.set(s, await image(s))
  const p = prepare(content, {
    page,
    link: format === 'md' ? (pg) => encodeURI(rel(destDir, pg.path)) : undefined,
    image: (src) => looked.get(src) ?? { warning: `Image missing: ${src}` },
  })

  const name = exportName(docTitle(p, doc), format, path.posix.basename(doc, '.md'))
  let data: Buffer
  let engine: ExportResult['engine'] = null
  const warnings = [...p.warnings]
  if (format === 'md') {
    data = Buffer.from(toMarkdown(p))
  } else if (format === 'html') {
    data = Buffer.from(htmlDocument(p))
    warnings.push(...syntaxWarnings(p.counts, 'as-written'))
  } else {
    const pd = await pandoc()
    if (pd) {
      engine = 'pandoc'
      data = await pandocDocx(pd.path, p)
    } else {
      engine = 'built-in'
      const built = await builtinDocx(p)
      data = built.data
      for (const w of built.warnings) if (!warnings.includes(w)) warnings.push(w)
    }
    warnings.push(...syntaxWarnings(p.counts, engine))
  }

  let saved: string | undefined
  if (toVault) {
    // A Markdown export saved in the vault is a copy, not a page: as .md it would join the writer's
    // pages with the same title, show in Move-to and link pickers, and a [[link]] could open it
    // instead of the original. As .markdown it is the same Markdown, which Ekdanta doesn't list.
    saved = await freeName('exports', format === 'md' ? name.replace(/\.md$/, '.markdown') : name)
    await atomicWrite(resolveInVault(saved), data)
  }
  return { data, type: TYPES[format], name: saved ? path.posix.basename(saved) : name, engine, warnings, saved }
}

/** `folder/name.ext`, or `name-2.ext` and so on: an earlier export is never overwritten. */
async function freeName(folder: string, name: string) {
  const dot = name.lastIndexOf('.')
  for (let n = 1; ; n++) {
    const candidate = `${folder}/${n > 1 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : name}`
    try {
      await fs.access(resolveInVault(candidate))
    } catch {
      return candidate
    }
  }
}
