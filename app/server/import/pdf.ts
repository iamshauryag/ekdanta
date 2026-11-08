// PDFs. The file is read in a worker thread (pdf-worker.ts) with a memory cap and a time limit, so a
// huge or hostile PDF fails on its own instead of taking the server with it. What comes back is said
// plainly: pages that came out empty, two columns, tables, pictures and links left out, garbled text.
// A PDF with no text at all (a scan) fails with a message; Ekdanta doesn't read scans (no OCR).
import { Worker } from 'node:worker_threads'
import { ImportError } from './docx.ts'
import type { Converted } from './html.ts'
import type { PdfJob, PdfResult } from './pdf-worker.ts'

export interface PdfLimits {
  /** Pages read at most; the rest are left out, with a note. */
  maxPages?: number
  /** After this, no more pages are read and what's read is kept. */
  softMs?: number
  /** After this, the reading is stopped and the file fails. */
  hardMs?: number
  /** The worker's heap, in MB. */
  memoryMb?: number
  /** The largest PDF read, in bytes. The file's own bytes sit outside the heap cap, so they're capped here. */
  maxBytes?: number
}

const LIMITS = { maxPages: 2000, softMs: 90_000, hardMs: 150_000, memoryMb: 768, maxBytes: 150 * 1024 * 1024 }

/** pdf.js needs Node 24's built-ins, and the worker is TypeScript Node runs as it is from 22.18 and 23.6. */
const MIN_NODE = 24

/** Why PDFs can't be read on this Node, or null. */
export function nodeProblem(version = process.versions.node): string | null {
  const major = Number(version.split('.')[0])
  return major >= MIN_NODE ? null : needNode(version)
}
const needNode = (version: string) => `PDF import needs Node ${MIN_NODE} or newer. You have ${version}. Update Node, or save the PDF as a Word document first`

/** An error's first line without file paths or URLs, which say nothing to the writer and needn't leave the machine. */
const plainError = (message: string) =>
  message
    .split('\n')[0]
    .replace(/(file:\/\/|[A-Za-z]:\\|\/)[^\s'"`]*/g, '…')
    .slice(0, 160)

// Two PDFs at a time at most, whatever the number of requests: each worker can use a lot of memory.
let running = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** A PDF as Markdown, with notes on anything that didn't come across. Throws ImportError when it can't be read. */
export async function pdfToMarkdown(buf: Buffer, limits: PdfLimits = {}): Promise<Converted> {
  const lim = { ...LIMITS, ...limits }
  const old = nodeProblem()
  if (old) throw new ImportError(old)
  if (buf.length > lim.maxBytes)
    throw new ImportError(`The PDF is ${Math.round(buf.length / 1024 / 1024)} MB; PDFs over ${Math.round(lim.maxBytes / 1024 / 1024)} MB can’t be imported. Split it into smaller files first`)
  const r = await slot(() => runWorker(buf, lim))
  if (!r.ok) {
    if (r.error === 'password') throw new ImportError('The PDF is password-protected. Open it, save a copy without the password, then import that')
    if (r.error === 'damaged') throw new ImportError('The file is damaged or isn’t a PDF')
    throw new ImportError(`Couldn’t read the PDF: ${plainError(r.message ?? '')}`)
  }
  if (!r.chars) {
    if (r.read && r.emptyBlank.length === r.read) throw new ImportError('Every page of the PDF is blank')
    throw new ImportError(
      'No text could be read from this PDF: its pages look scanned, or the words are pictures. Ekdanta can’t read scans yet. Make a text PDF with an OCR tool, then import it again',
    )
  }
  return { markdown: r.markdown, media: [], notes: pdfNotes(r), title: r.title, created: r.created }
}

/** What the writer should check, in plain words. Each one puts the row up for review. */
export function pdfNotes(r: Extract<PdfResult, { ok: true }>): string[] {
  const notes: string[] = []
  const n = (count: number, one: string, many = one + 's') => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
  if (r.read < r.pages) notes.push(`Only the first ${n(r.read, 'page')} of ${r.pages.toLocaleString('en-US')} came across${r.outOfTime ? ' (the rest took too long to read)' : ''}`)
  if (r.emptyDrawn.length) notes.push(`Scanned pages with no text — ${r.emptyDrawn.length} of ${r.read} ${r.read === 1 ? 'page' : 'pages'} came out empty (${pageList(r.emptyDrawn)})`)
  if (r.twoColumns) notes.push(`Two columns detected${r.read > 1 ? ` on ${n(r.twoColumns, 'page')}` : ''}; check the reading order`)
  if (r.tables) notes.push(`${r.tables === 1 ? 'A table was' : `${r.tables} tables were`} rebuilt from the layout, and tables may not have come across cleanly; check against the PDF`)
  if (r.garbled > Math.max(5, r.chars * 0.02)) notes.push('Some text came out garbled: the PDF’s fonts don’t say which letters they draw')
  if (r.sideways) notes.push('Sideways text (a margin note or a stamp) was left out')
  if (r.pictures) notes.push('Pictures in the PDF were left out')
  if (r.links) notes.push(`${r.links === 1 ? 'A link was' : `${r.links} links were`} left out; the linked text is still there`)
  if (r.fields) notes.push(`${r.fields === 1 ? 'A filled-in form field was' : `${r.fields} filled-in form fields were`} left out`)
  if (r.comments) notes.push(`${r.comments === 1 ? 'A comment or text box' : `${r.comments} comments or text boxes`} added on top of the pages ${r.comments === 1 ? 'was' : 'were'} left out`)
  const left = [
    ...r.removed.running.slice(0, 3).map((h) => `“${h.text.length > 60 ? h.text.slice(0, 59) + '…' : h.text}” (${n(h.pages, 'page')})`),
    ...(r.removed.running.length > 3 ? [`${r.removed.running.length - 3} more`] : []),
    ...(r.removed.pageNumbers ? [`page numbers (${r.removed.pageNumbers})`] : []),
  ]
  if (left.length) notes.push(`Left out running headers and footers: ${left.join(', ')}`)
  if (r.rejoined.length) {
    const sample = [...new Set(r.rejoined)].slice(0, 3).join(', ')
    notes.push(
      `${n(r.rejoined.length, 'word')} broken across lines ${r.rejoined.length === 1 ? 'was' : 'were'} joined (${sample}${r.rejoined.length > 3 ? ', …' : ''}); check any that should keep a hyphen`,
    )
  }
  return notes
}

/** "3, 5 and 9", or the first few and how many more. */
function pageList(pages: number[]) {
  const shown = pages.slice(0, 5).map(String)
  const label = pages.length === 1 ? 'page' : 'pages'
  if (pages.length > 5) return `${label} ${shown.join(', ')} and ${pages.length - 5} more`
  return `${label} ${shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0]}`
}

function runWorker(buf: Buffer, lim: typeof LIMITS): Promise<PdfResult> {
  // A copy of its own, handed over rather than cloned.
  const data = new Uint8Array(buf)
  const job: PdfJob = { data, maxPages: lim.maxPages, softMs: lim.softMs }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), {
      workerData: job,
      transferList: [data.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: lim.memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      // None of the server's environment (API keys among it) goes into the thread reading the file.
      env: {},
    })
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
      worker.terminate().catch(() => {})
    }
    const timer = setTimeout(() => finish(() => reject(new ImportError(`The PDF took too long to read (over ${Math.round(lim.hardMs / 1000)} seconds)`))), lim.hardMs)
    worker.once('message', (r: PdfResult) => finish(() => resolve(r)))
    worker.once('error', (e: Error & { code?: string }) =>
      finish(() =>
        reject(
          e.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ImportError('The PDF is too big or too complex to read')
            : // A Node that can't run the TypeScript worker says so this way.
              e.code === 'ERR_UNKNOWN_FILE_EXTENSION'
              ? new ImportError(needNode(process.versions.node))
              : new ImportError(`Couldn’t read the PDF: ${plainError(e.message)}`),
        ),
      ),
    )
    worker.once('exit', (code) => finish(() => reject(new ImportError(`Couldn’t read the PDF (the reader stopped, code ${code})`))))
  })
}
