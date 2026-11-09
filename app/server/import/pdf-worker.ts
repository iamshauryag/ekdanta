// Reads one PDF in a worker thread, so a huge or hostile file can't stall the server or eat its memory:
// pdf.ts gives this thread a memory cap and kills it when time runs out. The PDF is read with pdf.js
// (through unpdf's build, which needs no canvas and no native code). pdf.js never runs a PDF's own
// scripts; it's given the bytes, never a URL, and fetch is switched off here in case anything asks.
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { cleanTitle, fontStyle, isoDate, layoutPages, pdfDate, safeUrl, type PdfItem, type PdfPage, type PdfTag, type Removed } from './pdf-layout.ts'

export interface PdfJob {
  data: Uint8Array
  maxPages: number
  /** Stop reading pages after this many milliseconds and keep what's read. */
  softMs: number
}

export type PdfResult =
  | {
      ok: true
      markdown: string
      title?: string
      created?: string
      pages: number
      read: number
      /** Pages with no text: those that draw something (a scan, outlined text) and those that are blank. */
      emptyDrawn: number[]
      emptyBlank: number[]
      twoColumns: number
      tables: number
      garbled: number
      chars: number
      sideways: number
      /** Links whose text couldn't be found on the page, so they were left out. */
      links: number
      /** Filled-in form fields, and comments or text boxes added on top of the page: none are in the text. */
      fields: number
      comments: number
      removed: Removed
      rejoined: string[]
      pictures: boolean
      outOfTime: boolean
    }
  | { ok: false; error: 'password' | 'damaged' | 'other'; message?: string }

export interface Annotation {
  subtype?: string
  url?: string
  rect?: number[]
  /** The link's area line by line: four corners per line. */
  quadPoints?: ArrayLike<number> | null
  fieldType?: string
  fieldValue?: unknown
  contentsObj?: { str?: string }
}

// Structure that holds a block of text of its own.
const BLOCK = new Set(['P', 'Caption', 'TOCI', 'Note', 'TD', 'TH', 'Code', 'Sub'])

if (!isMainThread) globalThis.fetch = () => Promise.reject(new Error('No network while reading a PDF'))

// Imported for its functions (in tests) it reads nothing.
if (!isMainThread && parentPort)
  parentPort.postMessage(
    await read(workerData as PdfJob).catch((e: Error): PdfResult => ({
      ok: false,
      error: e?.name === 'PasswordException' ? 'password' : e?.name === 'InvalidPDFException' ? 'damaged' : 'other',
      message: String(e?.message ?? e),
    })),
  )

async function read({ data, maxPages, softMs }: PdfJob): Promise<PdfResult> {
  const started = Date.now()
  // Pictures are streams of their own, so their dictionaries are never hidden in compressed object streams.
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const pictures = bytes.indexOf('/Subtype/Image') >= 0 || bytes.indexOf('/Subtype /Image') >= 0
  const { getResolvedPDFJS } = await import('unpdf')
  const pdfjs = await getResolvedPDFJS()
  // fontExtraProperties keeps each font's name, which says whether it's bold or italic.
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    fontExtraProperties: true,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
    disableAutoFetch: true,
    disableStream: true,
  })
  const doc = await task.promise
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as { Title?: string; CreationDate?: string }
    const xmp = meta?.metadata
    const title = cleanTitle(xmp?.get('dc:title') ?? info.Title)
    const created = pdfDate(info.CreationDate) ?? isoDate(xmp?.get('xmp:createdate'))

    const styles = new Map<string, Pick<PdfItem, 'bold' | 'italic'>>()
    const tried = new Set<string>()
    const pages: PdfPage[] = []
    const empty: number[] = []
    let sideways = 0
    let links = 0
    let fields = 0
    let comments = 0
    let outOfTime = false
    const read = Math.min(doc.numPages, maxPages)
    for (let n = 1; n <= read; n++) {
      if (Date.now() - started > softMs) {
        outOfTime = true
        break
      }
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const content = await page.getTextContent({ includeMarkedContent: true })
      // The page's drawing is what loads its fonts, and with them their names. Fonts are shared between
      // pages, so it's read only for a page that brings in a font not tried before, and only for as long
      // as the time left: a heavy page then keeps its text, plain, and reading stops there.
      const fresh = [...new Set(content.items.flatMap((it) => ('fontName' in it && it.str && !tried.has(it.fontName) ? [it.fontName] : [])))]
      if (fresh.length) {
        const drawn = await within(page.getOperatorList(), softMs - (Date.now() - started))
        if (drawn === 'late') outOfTime = true
        else for (const f of fresh) tried.add(f)
      }
      // A tagged PDF (Word, Google Docs, a browser's Save as PDF) says what each run is: heading, list item, paragraph.
      const tags = tagMap(await page.getStructTree().catch(() => null), n)
      const items: PdfItem[] = []
      const marks: (string | null)[] = []
      for (const it of content.items) {
        if (!('str' in it)) {
          if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') marks.push(it.id ?? null)
          else if (it.type === 'endMarkedContent') marks.pop()
          continue
        }
        if (!it.str) continue
        const t = pdfjs.Util.transform(vp.transform, it.transform)
        // Upright text only. Sideways text (a margin note, a stamp) is counted and left out; mirrored or
        // upside-down text is a drawing effect, not something to read, and is left out quietly.
        if (Math.abs(t[1]) > 0.01 * Math.abs(t[0]) || Math.abs(t[2]) > 0.01 * Math.abs(t[3])) {
          sideways += it.str.trim().length
          continue
        }
        if (t[0] <= 0 || t[3] >= 0) continue
        const item: PdfItem = { str: it.str, x: t[4], y: t[5], w: it.width, size: Math.hypot(t[2], t[3]), ...styleOf(page.commonObjs, it.fontName) }
        const id = marks.findLast((m) => m && tags.has(m))
        if (id) item.tag = tags.get(id)
        items.push(item)
      }
      if (!items.some((it) => it.str.trim())) empty.push(n)
      let linked = items
      for (const a of (await page.getAnnotations().catch(() => [])) as Annotation[]) {
        if (a.subtype === 'Link' && a.url) {
          const done = linkItems(a, vp, linked)
          if (done) linked = done
          else links++
        } else if (a.subtype === 'Widget' && (a.fieldType === 'Tx' || a.fieldType === 'Ch') && [a.fieldValue].flat().some((v) => typeof v === 'string' && v.trim())) fields++
        else if ((a.subtype === 'FreeText' || a.subtype === 'Text') && (a.contentsObj?.str ?? '').trim()) comments++
      }
      pages.push({ width: vp.width, height: vp.height, items: linked })
      page.cleanup()
      if (outOfTime) break
    }

    // A page with no text is a scan (or text drawn as shapes) if it draws anything; a few are looked at.
    const emptyDrawn: number[] = []
    const emptyBlank: number[] = []
    const ops = pdfjs.OPS
    const drawing = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject, ops.paintImageXObjectRepeat, ops.paintInlineImageXObjectGroup])
    for (const n of empty) {
      if (emptyDrawn.length + emptyBlank.length >= 20 || Date.now() - started > softMs) {
        // The rest are taken to be like the ones looked at.
        ;(emptyDrawn.length >= emptyBlank.length ? emptyDrawn : emptyBlank).push(n)
        continue
      }
      const page = await doc.getPage(n)
      const drawn = await within(page.getOperatorList(), softMs - (Date.now() - started))
      const list = drawn === 'late' ? null : drawn
      const paths = list?.fnArray.filter((f: number) => f === ops.constructPath).length ?? 0
      ;(list?.fnArray.some((f: number) => drawing.has(f)) || paths > 50 ? emptyDrawn : emptyBlank).push(n)
      page.cleanup()
    }

    /**
     * Bold and italic for a font: pdf.js's own flags where it sets them, else the font's name
     * ("ABCDEF+Georgia-BoldItalic"). A font that isn't loaded is plain for now, and asked again later.
     */
    function styleOf(fonts: unknown, fontName: string): Pick<PdfItem, 'bold' | 'italic'> {
      const known = styles.get(fontName)
      if (known) return known
      let font: { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | undefined
      try {
        font = (fonts as { get(id: string): typeof font }).get(fontName)
      } catch {
        return {}
      }
      if (!font) return {}
      const named = fontStyle(String(font.name ?? ''))
      const style = {
        ...(font.bold || font.black || named.bold ? { bold: true } : {}),
        ...(font.italic || named.italic ? { italic: true } : {}),
      }
      styles.set(fontName, style)
      return style
    }

    const layout = layoutPages(pages)
    return { ok: true, ...layout, title, created, pages: doc.numPages, read: pages.length, emptyDrawn, emptyBlank, sideways, links, fields, comments, pictures, outOfTime }
  } finally {
    await task.destroy()
  }
}

/** A promise's value, or 'late' once the time is up (it isn't stopped, only no longer waited for). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | 'late' | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), Math.max(0, ms))))
  try {
    return await Promise.race([work.catch(() => null), late])
  } finally {
    clearTimeout(timer)
  }
}

type Box = { left: number; right: number; top: number; bottom: number }

/**
 * The page's runs with a link's text marked with its address, or null when no text sits under it.
 * Only the characters under the link are marked: a run is split where the link starts and ends,
 * placed by its characters' share of the run's width and moved to the nearest word edge. The link's
 * area is read line by line where the PDF gives it so; a box over two or more lines (with what comes
 * before the link inside it too) only marks the words that are part of the address itself.
 */
export function linkItems(a: Annotation, vp: { convertToViewportPoint(x: number, y: number): number[] }, items: PdfItem[]): PdfItem[] | null {
  const url = safeUrl(a.url ?? '')
  if (!url || a.rect?.length !== 4) return null
  const toBox = (pts: number[]): Box => {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const [x, y] = vp.convertToViewportPoint(pts[i], pts[i + 1])
      xs.push(x)
      ys.push(y)
    }
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
  }
  const quads = a.quadPoints && a.quadPoints.length >= 8 && a.quadPoints.length % 8 === 0 ? Array.from(a.quadPoints) : null
  const boxes = quads ? Array.from({ length: quads.length / 8 }, (_, i) => toBox(quads.slice(i * 8, i * 8 + 8))) : [toBox(a.rect)]
  const under = (it: PdfItem, b: Box) => {
    const mid = it.y - it.size * 0.3
    return !it.link && it.str.trim() && mid >= b.top - 1 && mid <= b.bottom + 1
  }
  const ranges = new Map<PdfItem, [number, number][]>()
  const add = (it: PdfItem, from: number, to: number) => {
    if (to > from) ranges.set(it, [...(ranges.get(it) ?? []), [from, to]])
  }
  const rows = new Set(items.filter((it) => under(it, boxes[0])).map((it) => Math.round(it.y)))
  if (!quads && rows.size > 1) {
    // One box over several lines: only the words of the address are sure to be the link.
    const bare = url.toLowerCase().replace(/^(https?:\/\/|mailto:)/, '')
    for (const it of items.filter((it) => under(it, boxes[0])))
      for (const m of it.str.matchAll(/\S+/g)) {
        const word = m[0].replace(/[.,;:!?)\]"'’”]+$/, '').toLowerCase()
        if (word.length >= 4 && /[./:@]/.test(word) && (url.toLowerCase().includes(word) || word.includes(bare))) add(it, m.index!, m.index! + word.length)
      }
  } else
    for (const b of boxes)
      for (const it of items) {
        if (!under(it, b)) continue
        const len = it.str.length
        const per = it.w / Math.max(len, 1)
        // The characters whose middles lie inside the box.
        let from = Math.ceil((b.left - 1 - it.x) / per - 0.5)
        let to = Math.floor((b.right + 1 - it.x) / per - 0.5) + 1
        from = Math.max(0, from)
        to = Math.min(len, to)
        // No character under the box: nothing to move to a word's edge.
        if (to <= from || !it.str.slice(from, to).trim()) continue
        from = snap(it.str, from, false)
        to = snap(it.str, to, true)
        add(it, from, to)
      }
  if (!ranges.size) return null
  return items.flatMap((it) => {
    const marks = ranges.get(it)
    if (!marks) return [it]
    const per = it.w / Math.max(it.str.length, 1)
    const piece = (from: number, to: number, link?: string): PdfItem[] =>
      to > from ? [{ ...it, str: it.str.slice(from, to), x: it.x + per * from, w: per * (to - from), ...(link ? { link } : {}) }] : []
    const out: PdfItem[] = []
    let at = 0
    for (const [from, to] of marks.sort((p, q) => p[0] - q[0])) {
      if (from < at) continue
      out.push(...piece(at, from), ...piece(from, to, url))
      at = to
    }
    out.push(...piece(at, it.str.length))
    return out
  })
}

/** A link's start (or end) in a run, moved to the nearest start (or end) of a word within two characters. */
function snap(s: string, i: number, end: boolean): number {
  const word = (c: string | undefined) => c !== undefined && !/\s/.test(c)
  const edge = (j: number) => (end ? word(s[j - 1]) && !word(s[j]) : word(s[j]) && !word(s[j - 1]))
  for (const d of [0, -1, 1, -2, 2]) if (i + d >= 0 && i + d <= s.length && edge(i + d)) return i + d
  return i
}

interface StructNode {
  role?: string
  type?: string
  id?: string
  children?: StructNode[]
}

/** Whether an element holds any content on this page, at any depth. */
function holdsContent(node: StructNode, depth = 0): boolean {
  return depth < 50 && (node.children ?? []).some((c) => c.type === 'content' || holdsContent(c, depth + 1))
}

/** Each marked run's place in a tagged PDF's structure, by its id. */
function tagMap(tree: StructNode | null, page: number): Map<string, PdfTag> {
  const map = new Map<string, PdfTag>()
  let n = 0
  const walk = (node: StructNode, ctx: PdfTag, depth: number) => {
    if (depth > 200) return
    for (const c of node.children ?? []) {
      if (c.type === 'content') {
        if (c.id) map.set(c.id, ctx)
        continue
      }
      const role = c.role ?? ''
      const key = `${page}:${n++}`
      const h = role.match(/^H([1-6])?$/)
      let next = ctx
      if (h) next = { ...ctx, block: key, heading: h[1] ? Number(h[1]) : 2 }
      else if (role === 'Title') next = { ...ctx, block: key, heading: 1 }
      else if (role === 'L') next = { ...ctx, depth: (ctx.depth ?? -1) + 1 }
      // A page's tree can list an item's label with nothing in it (Chrome does, for the part of an item
      // carried over a page break): only a label with content on this page counts.
      else if (role === 'LI') next = { ...ctx, li: key, block: key, lbl: (c.children ?? []).some((k) => k.role === 'Lbl' && holdsContent(k)) }
      else if (role === 'BlockQuote') next = { ...ctx, quote: true, block: key }
      else if (BLOCK.has(role)) next = { ...ctx, block: key }
      walk(c, next, depth + 1)
    }
  }
  if (tree) walk(tree, {}, 0)
  return map
}
