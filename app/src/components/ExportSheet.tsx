// Export… : a piece out of Ekdanta as a file (Word, PDF, HTML, clean Markdown) or on the clipboard
// (LinkedIn-ready text, plain text, rich text). The document is saved first and never changed.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FileEntry } from '../lib/api.ts'
import { FORMATS, LINKEDIN_LIMIT, charCount, defaultFormat, docTitle, exportName, prepare, syntaxWarnings, toHtml, toText, type ExportFormat, type Prepared } from '../lib/plaintext.ts'

interface Props {
  path: string
  kind: { id: string; name: string } | null
  files: FileEntry[]
  /** Finish any save in progress, so the export has everything typed. */
  flush: () => Promise<void>
  /** Something was saved into the vault (exports/). */
  onSaved: () => void
  onClose: () => void
}

type Destination = 'download' | 'vault'
interface Result {
  text: string
  warnings: string[]
  /** The text to copy by hand, when the clipboard said no. */
  manual?: string
}

const COPY: ExportFormat[] = ['linkedin', 'plain', 'rich']
const FILES: ExportFormat[] = ['docx', 'pdf', 'html', 'md']

// Per-viewer conveniences: the last format for each kind, where files go, Unicode bold.
const load = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem('ekdanta.export.' + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem('ekdanta.export.' + key, JSON.stringify(value))
  } catch {
    /* only a convenience */
  }
}

export function ExportSheet({ path, kind, files, flush, onSaved, onClose }: Props) {
  const sheet = useRef<HTMLDivElement>(null)
  const kindKey = 'format.' + (kind?.id ?? 'none')
  const [format, setFormatState] = useState<ExportFormat>(() => {
    const f = load<string>(kindKey, '')
    return FORMATS.some((x) => x.id === f) ? (f as ExportFormat) : defaultFormat(kind)
  })
  const setFormat = (f: ExportFormat) => {
    setFormatState(f)
    store(kindKey, f)
    setResult(null)
    setError(null)
  }
  const [destination, setDestState] = useState<Destination>(() => (load<string>('destination', 'download') === 'vault' ? 'vault' : 'download'))
  const setDestination = (d: Destination) => {
    setDestState(d)
    store('destination', d)
  }
  const [bold, setBoldState] = useState(() => load<boolean>('bold', false) === true)
  const setBold = (b: boolean) => {
    setBoldState(b)
    store('bold', b)
    setResult(null)
  }
  const [content, setContent] = useState<string | null>(null)
  const [engine, setEngine] = useState<string | null | undefined>(undefined) // undefined: still asking
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manualRef = useRef<HTMLTextAreaElement>(null)

  // Save what's typed, then read the document as it is on disk.
  useEffect(() => {
    let live = true
    flush()
      .then(() => api.read(path))
      .then((c) => live && setContent(c))
      .catch((e) => live && setError(`Couldn't read the document: ${(e as Error).message}`))
    api
      .exportEngine()
      .then((e) => live && setEngine(e.pandoc))
      .catch(() => live && setEngine(null))
    return () => {
      live = false
    }
  }, [path, flush])

  useEffect(() => {
    sheet.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (result?.manual) manualRef.current?.select()
  }, [result])

  /** [[link]] targets → pages, by file name as the editor links them. */
  const page = useMemo(() => {
    const byName = new Map<string, { title: string; path: string }>()
    for (const f of files) {
      const stem = f.path.replace(/\.md$/, '')
      byName.set(stem, { title: f.title, path: f.path })
      if (!byName.has(stem.split('/').pop()!)) byName.set(stem.split('/').pop()!, { title: f.title, path: f.path })
    }
    return (target: string) => byName.get(target) ?? null
  }, [files])

  /** An image's address in this app, for rich text and printing. */
  const imageUrl = (src: string) => {
    if (/^(https?:|data:)/i.test(src)) return { src }
    const parts = (path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : []).concat(safeDecode(src).split('/'))
    const out: string[] = []
    for (const part of parts) {
      if (part === '..') out.pop()
      else if (part && part !== '.') out.push(part)
    }
    return { src: `${location.origin}/api/asset?path=${encodeURIComponent(out.join('/'))}` }
  }

  const prepared: Prepared | null = useMemo(() => (content === null ? null : prepare(content, { page, image: imageUrl })), [content, page])
  const text = useMemo(() => {
    if (!prepared || (format !== 'linkedin' && format !== 'plain')) return null
    return toText(prepared.body, { style: format, bold: format === 'linkedin' && bold })
  }, [prepared, format, bold])
  const count = text ? charCount(text.text) : 0
  const title = prepared ? docTitle(prepared, path) : (files.find((f) => f.path === path)?.title ?? '')

  const copy = async (plain: string, html?: string) => {
    try {
      if (html && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })])
      } else await navigator.clipboard.writeText(plain)
      return true
    } catch {
      return false
    }
  }

  const run = async () => {
    if (!prepared || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    // Footnote marks and citations stay as written in everything made here (only pandoc makes footnotes).
    const notes = [...prepared.warnings, ...syntaxWarnings(prepared.counts, 'as-written')]
    try {
      if (format === 'linkedin' || format === 'plain') {
        const t = text!
        const warnings = [...notes, ...t.warnings]
        if (format === 'linkedin' && count > LINKEDIN_LIMIT)
          warnings.unshift(`${(count - LINKEDIN_LIMIT).toLocaleString()} characters over LinkedIn’s ${LINKEDIN_LIMIT.toLocaleString()}: it won’t post until it’s shorter`)
        const ok = await copy(t.text)
        setResult(ok ? { text: `Copied ${count.toLocaleString()} characters`, warnings } : { text: 'The clipboard isn’t available here. Select the text below and copy it.', warnings, manual: t.text })
      } else if (format === 'rich') {
        // The pictures go inside the copy, so they paste into apps that can't reach this one.
        const { html, warnings: left } = await inlineImages(toHtml(prepared.body))
        const plain = toText(prepared.body, { style: 'plain' }).text
        const ok = await copy(plain, html)
        const warnings = [...notes, ...left]
        setResult(ok ? { text: 'Copied with its formatting', warnings } : { text: 'The clipboard isn’t available here. Select the text below and copy it.', warnings, manual: plain })
      } else if (format === 'pdf') {
        const missing = await printClean(prepared, title)
        setResult({ text: 'Sent to the print dialog. Choose Save as PDF there.', warnings: [...notes, ...missing] })
      } else {
        const r = await api.exportFile(path, format, { destination })
        const by = r.engine === 'pandoc' ? ' with pandoc' : r.engine === 'built-in' ? ' with the built-in engine' : ''
        if (r.engine === 'built-in') setEngine(null)
        if (r.saved) {
          onSaved()
          setResult({ text: `Saved to ${r.saved}${by}`, warnings: r.warnings })
        } else if (r.blob) {
          const name = r.name || exportName(title, format)
          download(r.blob, name)
          setResult({ text: `Downloaded ${name}${by}`, warnings: r.warnings })
        }
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isFile = format === 'docx' || format === 'html' || format === 'md'
  const action = COPY.includes(format) ? 'Copy' : format === 'pdf' ? 'Print…' : 'Export'

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet export-sheet" role="dialog" aria-label="Export" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <div className="export-head">
            <h2>Export</h2>
            <span className="muted">{title || 'Untitled'}</span>
          </div>
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        <form
          className="sheet-body export-body"
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
        >
          <div className="export-formats" role="radiogroup" aria-label="Format">
            {[
              ['File', FILES],
              ['Copy', COPY],
            ].map(([label, ids]) => (
              <div key={label as string} className="export-group">
                <h3>{label as string}</h3>
                <div className="choices">
                  {FORMATS.filter((f) => (ids as ExportFormat[]).includes(f.id)).map((f) => (
                    <button key={f.id} type="button" role="radio" aria-checked={format === f.id} className={`choice${format === f.id ? ' is-on' : ''}`} onClick={() => setFormat(f.id)}>
                      <span className="dot" />
                      <span>
                        <b>{f.label}</b>
                        <small>{f.note}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="export-options">
            {isFile && (
              <div className="seg seg-text export-dest" role="radiogroup" aria-label="Where to">
                <button type="button" role="radio" aria-checked={destination === 'download'} className={destination === 'download' ? 'is-on' : ''} onClick={() => setDestination('download')}>
                  Download
                </button>
                <button type="button" role="radio" aria-checked={destination === 'vault'} className={destination === 'vault' ? 'is-on' : ''} onClick={() => setDestination('vault')}>
                  Save to exports/ in vault
                </button>
              </div>
            )}
            {format === 'docx' && (
              <p className="export-engine">{engine === undefined ? 'Checking for pandoc…' : engine ? `Made with pandoc ${engine}` : 'Made with the built-in engine. Install pandoc for footnotes.'}</p>
            )}
            {format === 'linkedin' && (
              <>
                <label className="export-check">
                  <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> Bold with Unicode{' '}
                  <small className="muted">(headings and bold text; screen readers may spell it out)</small>
                </label>
                <p className={`export-count${count > LINKEDIN_LIMIT ? ' is-over' : ''}`} aria-live="polite">
                  {prepared ? `${count.toLocaleString()} / ${LINKEDIN_LIMIT.toLocaleString()} characters` : '…'}
                  {count > LINKEDIN_LIMIT && ' · too long for one post'}
                </p>
              </>
            )}
            {format === 'pdf' && <p className="export-engine">The page alone, with its title and page numbers. Choose Save as PDF in the print dialog.</p>}
          </div>

          <div className="export-actions">
            <button type="submit" className="btn primary" disabled={!prepared || busy}>
              {content === null && !error ? 'Saving…' : busy ? 'Working…' : action}
            </button>
            {result && (
              <span className="export-done" role="status">
                {result.text}
              </span>
            )}
            {error && (
              <span className="export-error" role="alert">
                {error}
              </span>
            )}
          </div>
          {result?.manual && <textarea ref={manualRef} className="export-manual" readOnly value={result.manual} aria-label="Text to copy" onFocus={(e) => e.target.select()} />}
          {result && result.warnings.length > 0 && (
            <ul className="export-warnings" aria-label="Notes on this export">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </form>
      </div>
    </div>
  )
}

function safeDecode(s: string) {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** The most picture data a rich-text copy carries; past it, pictures stay as links to this app. */
const INLINE_LIMIT = 8 * 1024 * 1024

/**
 * The HTML with this app's pictures (/api/asset) written into it as data, so a rich-text paste into a
 * mail or a document elsewhere still shows them. Pictures that can't be read, or that would make the
 * copy too big, keep their link, and the warnings say so.
 */
async function inlineImages(html: string): Promise<{ html: string; warnings: string[] }> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const warnings: string[] = []
  let total = 0
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src.startsWith(`${location.origin}/api/asset?`)) continue
    const name = safeDecode(decodeURIComponent(src.split('path=').pop() ?? ''))
      .split('/')
      .pop()
    try {
      const r = await fetch(src)
      if (!r.ok) throw new Error(String(r.status))
      const blob = await r.blob()
      if (total + blob.size > INLINE_LIMIT) {
        warnings.push(`Image too big to copy inside the text, linked instead (shows only on this computer): ${name}`)
        continue
      }
      total += blob.size
      img.setAttribute('src', await dataUrl(blob))
    } catch {
      warnings.push(`Image missing: ${name}`)
      img.remove()
    }
  }
  return { html: doc.body.innerHTML, warnings }
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

/**
 * Print a clean copy of the piece: it goes into .print-root, print.css shows only that, and the
 * browser's print dialog does the rest (Save as PDF). Returns the images that didn't load.
 */
async function printClean(p: Prepared, title: string): Promise<string[]> {
  document.querySelector('.print-root')?.remove()
  const root = document.createElement('div')
  root.className = 'print-root'
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const byline = [p.author, p.date].filter(Boolean).map(esc).join(' · ')
  root.innerHTML = `<h1 class="title">${esc(title)}</h1>${byline ? `<p class="byline">${byline}</p>` : ''}${toHtml(p.body)}`
  document.body.append(root)
  // Wait for the pictures, or the dialog shows empty boxes.
  const missing: string[] = []
  await Promise.race([
    Promise.all(
      [...root.querySelectorAll('img')].map(
        (img) =>
          new Promise<void>((done) => {
            const fail = () => {
              missing.push(`Image missing: ${img.getAttribute('alt') || decodeURIComponent(img.src.split('path=').pop() ?? img.src)}`)
              img.remove()
              done()
            }
            if (img.complete) return img.naturalWidth ? done() : fail()
            img.addEventListener('load', () => done(), { once: true })
            img.addEventListener('error', fail, { once: true })
          }),
      ),
    ),
    new Promise((r) => setTimeout(r, 5000)),
  ])
  const prevTitle = document.title
  document.title = title || prevTitle // the PDF's suggested file name
  document.body.classList.add('is-printing')
  const done = () => {
    document.body.classList.remove('is-printing')
    document.title = prevTitle
    root.remove()
  }
  window.addEventListener('afterprint', done, { once: true })
  window.print()
  // Some browsers return from print() before the dialog closes; afterprint cleans up then.
  return missing
}
