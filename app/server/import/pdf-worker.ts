// Reads one PDF in a worker thread, so a huge or hostile file can't stall the server or eat its memory:
// pdf.ts gives this thread a memory cap and kills it when time runs out. The PDF is read with pdf.js
// (through unpdf's build, which needs no canvas and no native code). pdf.js never runs a PDF's own
// scripts; it's given the bytes, never a URL, and fetch is switched off here in case anything asks.
import { parentPort, workerData } from 'node:worker_threads'
import { cleanTitle, isoDate, layoutPages, pdfDate, type PdfItem, type PdfPage } from './pdf-layout.ts'

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
      links: number
      pictures: boolean
      outOfTime: boolean
    }
  | { ok: false; error: 'password' | 'damaged' | 'other'; message?: string }

globalThis.fetch = () => Promise.reject(new Error('No network while reading a PDF'))

const job = workerData as PdfJob
parentPort!.postMessage(
  await read(job).catch((e: Error): PdfResult => ({
    ok: false,
    error: e?.name === 'PasswordException' ? 'password' : e?.name === 'InvalidPDFException' ? 'damaged' : 'other',
    message: String(e?.message ?? e),
  })),
)

async function read({ data, maxPages, softMs }: PdfJob): Promise<PdfResult> {
  const started = Date.now()
  // Pictures are streams of their own, so their dictionaries are never hidden in compressed object streams.
  const pictures =
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).indexOf('/Subtype/Image') >= 0 || Buffer.from(data.buffer, data.byteOffset, data.byteLength).indexOf('/Subtype /Image') >= 0
  const { getResolvedPDFJS } = await import('unpdf')
  const pdfjs = await getResolvedPDFJS()
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: false, verbosity: 0 })
  const doc = await task.promise
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as { Title?: string; CreationDate?: string }
    const xmp = meta?.metadata
    const title = cleanTitle(xmp?.get('dc:title') ?? info.Title)
    const created = pdfDate(info.CreationDate) ?? isoDate(xmp?.get('xmp:createdate'))

    const pages: PdfPage[] = []
    const empty: number[] = []
    let sideways = 0
    let links = 0
    let outOfTime = false
    const read = Math.min(doc.numPages, maxPages)
    for (let n = 1; n <= read; n++) {
      if (Date.now() - started > softMs) {
        outOfTime = true
        break
      }
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items: PdfItem[] = []
      for (const it of content.items) {
        if (!('str' in it) || !it.str) continue
        const t = pdfjs.Util.transform(vp.transform, it.transform)
        // Upright text only; sideways text (a margin note, a stamp) is counted and left out.
        if (Math.abs(t[1]) > 0.01 * Math.abs(t[0]) || Math.abs(t[2]) > 0.01 * Math.abs(t[3]) || t[0] <= 0) {
          sideways += it.str.trim().length
          continue
        }
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width, size: Math.hypot(t[2], t[3]) })
      }
      if (!items.some((it) => it.str.trim())) empty.push(n)
      links += (await page.getAnnotations().catch(() => [])).filter((a: { subtype?: string; url?: string }) => a.subtype === 'Link' && a.url).length
      pages.push({ width: vp.width, height: vp.height, items })
      page.cleanup()
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
      const list = await page.getOperatorList().catch(() => null)
      const paths = list?.fnArray.filter((f: number) => f === ops.constructPath).length ?? 0
      ;(list?.fnArray.some((f: number) => drawing.has(f)) || paths > 50 ? emptyDrawn : emptyBlank).push(n)
      page.cleanup()
    }

    const layout = layoutPages(pages)
    return { ok: true, ...layout, title, created, pages: doc.numPages, read: pages.length, emptyDrawn, emptyBlank, sideways, links, pictures, outOfTime }
  } finally {
    await task.destroy()
  }
}
