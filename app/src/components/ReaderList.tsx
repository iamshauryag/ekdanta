// "Read as…" in the Piece tab: pick a reader, read the selection or the whole piece, and get back a short list of
// the questions that reader would ask, each tied to a phrase. Nothing is written into the page; "Show me"
// selects the phrase so the writer can fix it themselves (or press the Sentence key on it).
import type { Editor as TiptapEditor } from '@tiptap/core'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { READERS, WHO_MAX, cleanWho, lastReader, lengthProblem, locate, readerLabel, rememberReader, type Reader, type ReaderQuestion } from '../lib/reader.ts'
import { textMap, textOf } from '../editor/help.ts'

/** The latest list for one document. Kept for the session only. */
export interface Reading {
  doc: string
  reader: string
  /** Where the text read began, as an offset into the piece's text, so "Show me" finds the phrase there first. */
  near: number
  items: ReaderQuestion[]
}

interface Props {
  editor: TiptapEditor | null
  doc: string
  platform: string
  open: boolean
  onOpen: (open: boolean) => void
  /** Asks the card to put the caret on its Read button (from the command). */
  focusTick: number
  reading: Reading | null
  onReading: (r: Reading | null) => void
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** What Read will read: the selection if there is one, else the whole piece, with where it begins. */
function scopeOf(editor: TiptapEditor) {
  const { doc, selection } = editor.state
  if (selection.empty) return { text: textOf(doc, 0, doc.content.size), selection: false, near: 0 }
  const before = textOf(doc, 0, selection.from)
  return { text: textOf(doc, selection.from, selection.to), selection: true, near: before.length }
}

export function ReaderList(p: Props) {
  const [reader, setReader] = useState<Reader>(() => lastReader(storage(), p.platform))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  const runRef = useRef<HTMLButtonElement>(null)
  const whoRef = useRef<HTMLInputElement>(null)
  const ask = useRef(0)

  // Each kind of writing remembers its own reader.
  useEffect(() => {
    setReader(lastReader(storage(), p.platform))
    setMessage(null)
  }, [p.platform])
  useEffect(() => setMessage(null), [p.doc])

  // Edits and selection changes: re-check which quoted passages are still there, and what Read will read.
  useEffect(() => {
    if (!p.editor || !p.open) return
    const bump = () => setVersion((v) => v + 1)
    p.editor.on('update', bump)
    p.editor.on('selectionUpdate', bump)
    return () => {
      p.editor?.off('update', bump)
      p.editor?.off('selectionUpdate', bump)
    }
  }, [p.editor, p.open])

  useEffect(() => {
    if (!p.focusTick || !p.open) return
    ;(reader.id === 'other' && !cleanWho(reader.who) ? whoRef.current : runRef.current)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusTick, p.open])

  const pick = (r: Reader) => {
    setReader(r)
    rememberReader(storage(), p.platform, r)
    if (r.id === 'other') requestAnimationFrame(() => whoRef.current?.focus())
  }

  const run = async () => {
    const ed = p.editor
    if (!ed || busy) return
    const scope = scopeOf(ed)
    const problem = lengthProblem(scope.text, scope.selection)
    if (problem) return setMessage(problem)
    if (reader.id === 'other' && !cleanWho(reader.who)) {
      whoRef.current?.focus()
      return setMessage('Say who the reader is first')
    }
    rememberReader(storage(), p.platform, reader)
    const id = ++ask.current
    const doc = p.doc
    setBusy(true)
    setMessage(null)
    try {
      const r = await api.readAs({ doc, platform: p.platform, reader, text: scope.text, selection: scope.selection })
      if (id !== ask.current) return
      if (r.kind === 'questions') p.onReading({ doc, reader: readerLabel(reader), near: scope.near, items: r.items })
      else setMessage(r.message)
    } catch (e) {
      if (id === ask.current) setMessage((e as Error).message)
    } finally {
      if (id === ask.current) setBusy(false)
    }
  }

  // A different document, or the card closing, abandons a reading in flight.
  useEffect(() => {
    ask.current++
    setBusy(false)
  }, [p.doc])

  const reading = p.reading?.doc === p.doc ? p.reading : null
  const map = p.editor && reading ? textMap(p.editor.state.doc, 0, p.editor.state.doc.content.size) : null
  const where = (q: ReaderQuestion) => (map ? locate(map.text, q.quote, reading?.near) : null)

  const show = (q: ReaderQuestion) => {
    const ed = p.editor
    const hit = where(q)
    if (!ed || !map || !hit) return
    const from = map.pos(hit.index)
    const to = map.pos(hit.index + hit.quote.length - 1) + 1
    ed.chain().focus().setTextSelection({ from, to }).scrollIntoView().run()
  }

  const dismiss = (q: ReaderQuestion) => {
    if (!reading) return
    const items = reading.items.filter((i) => i !== q)
    p.onReading(items.length ? { ...reading, items } : null)
  }

  const selected = p.editor && !p.editor.state.selection.empty
  const n = reading?.items.length ?? 0

  return (
    <section className={`reader-card${p.open ? ' is-open' : ''}`} aria-label="Read as">
      <button className="reader-toggle" aria-expanded={p.open} onClick={() => p.onOpen(!p.open)}>
        <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 4.75 6 7.25l2.5-2.5" />
        </svg>
        <span className="reader-title">Read as…</span>
        {!p.open && reading && (
          <span className="muted">
            {reading.reader} · {n} {n === 1 ? 'question' : 'questions'}
          </span>
        )}
      </button>
      {p.open && (
        <div className="reader-body">
          <p className="reader-hint">The questions a real reader would ask. Nothing in your draft changes.</p>
          <div className="reader-who" role="radiogroup" aria-label="Reader">
            {[...READERS.map((r) => ({ id: r.id, label: r.label })), { id: 'other' as const, label: 'Someone else…' }].map((r) => (
              <button
                key={r.id}
                role="radio"
                aria-checked={reader.id === r.id}
                className={reader.id === r.id ? 'is-on' : ''}
                onClick={() => pick(r.id === 'other' ? { id: 'other', who: reader.id === 'other' ? reader.who : '' } : { id: r.id })}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reader.id === 'other' && (
            <input
              ref={whoRef}
              className="reader-input"
              value={reader.who ?? ''}
              maxLength={WHO_MAX}
              placeholder="e.g. a client I’ve never met"
              aria-label="Who is reading"
              onChange={(e) => setReader({ id: 'other', who: e.target.value })}
              onBlur={() => rememberReader(storage(), p.platform, reader)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  run()
                }
              }}
            />
          )}
          <div className="reader-run">
            <button ref={runRef} className="btn" disabled={busy || !p.editor} onClick={run}>
              {busy ? `Reading as ${readerLabel(reader)}…` : selected ? 'Read the selection' : 'Read the whole piece'}
            </button>
          </div>
          {message && <p className="reader-message">{message}</p>}
          {reading && (
            <ol className="reader-list" aria-label={`Questions from ${reading.reader}`}>
              {reading.items.map((q, i) => {
                // Without a text map there is nothing to check the passage against (the Markdown
                // view, the Ideas page): the passage hasn't changed, it just can't be shown.
                const here = map ? !!where(q) : null
                return (
                  <li key={i} className={`reader-item${here === false ? ' is-gone' : ''}`}>
                    <q className="reader-quote">{q.quote}</q>
                    {here === false && <span className="reader-changed">Passage changed</span>}
                    <p className="reader-question">{q.question}</p>
                    <div className="reader-actions">
                      {here && (
                        <button className="link" onClick={() => show(q)}>
                          Show me
                        </button>
                      )}
                      <button className="link muted" onClick={() => dismiss(q)}>
                        Dismiss
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
