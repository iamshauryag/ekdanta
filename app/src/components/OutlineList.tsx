import type { Editor as TiptapEditor } from '@tiptap/core'
import { closeHistory, undo } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Heading } from '../editor/Editor.tsx'
import {
  SHORT_WORDS,
  blocksOfDoc,
  bodyEnd,
  canMove,
  isQuote,
  moveBlocks,
  movedIndex,
  opening,
  paragraphStep,
  posOf,
  rowsOf,
  sectionEnd,
  sectionStep,
  type Block,
  type Row,
} from '../editor/sections.ts'
import { binding, formatKey } from '../lib/keys.ts'

export type OutlineView = 'headings' | 'paragraphs'

// Long lists only draw the rows in view. Rows in the Paragraphs view are one line each.
const ROW_H = 30
const VIRTUAL_FROM = 200
// The one hint line, which every movable row is described by.
const HINT_ID = 'outline-move-hint'

function storedView(): OutlineView {
  try {
    return localStorage.getItem('ekdanta.outlineView') === 'paragraphs' ? 'paragraphs' : 'headings'
  } catch {
    return 'headings'
  }
}

const label = (r: Row | undefined) => (!r ? '' : `“${r.kind === 'heading' ? r.text : opening(r.text, 5)}”`)

/**
 * The Outline tab: the document's headings, or its paragraphs by their opening words. A click jumps
 * there; dragging a row (or ⌥↑ / ⌥↓ on it) moves that section or paragraph, as one undoable change.
 */
export function OutlineList({
  editor,
  outline,
  onHeading,
  onBeforeMove,
  notify,
}: {
  editor: TiptapEditor | null
  outline: Heading[]
  onHeading: (h: Heading) => void
  /** Keep a version of the text as it is, before a move changes it. */
  onBeforeMove: () => void
  notify: (text: string, undo?: () => void) => void
}) {
  const [view, setViewState] = useState<OutlineView>(storedView)
  const setView = (v: OutlineView) => {
    setViewState(v)
    try {
      localStorage.setItem('ekdanta.outlineView', v)
    } catch {
      /* a convenience */
    }
  }

  // The rows follow the document as it changes, at most once a frame.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!editor) return
    let frame = 0
    const on = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setVersion((v) => v + 1))
    }
    editor.on('update', on)
    return () => {
      editor.off('update', on)
      cancelAnimationFrame(frame)
    }
  }, [editor])
  const blocks = useMemo<Block[]>(() => (editor && !editor.isDestroyed ? blocksOfDoc(editor.state.doc) : []), [editor, version, outline])
  const all = useMemo(() => rowsOf(blocks), [blocks])
  const rows = view === 'headings' ? all.filter((r) => r.kind === 'heading') : all
  const end = bodyEnd(blocks)
  const focusAfter = useRef<number | null>(null)
  const top = Math.min(...rows.filter((r) => r.kind === 'heading').map((r) => r.level))

  // Without the page (the Markdown source is showing), the headings can still be jumped to.
  if (!editor) {
    const top = Math.min(...outline.map((h) => h.level))
    return (
      <>
        <div className="panel-head">
          Outline <em>· {outline.length} headings</em>
        </div>
        <nav className="outline">
          {outline.map((h, i) => (
            <button key={i} className={`outline-item level-${h.level - top}`} onClick={() => onHeading(h)}>
              {h.text}
            </button>
          ))}
        </nav>
      </>
    )
  }

  /** What moves with a row: a heading takes its section, a paragraph only itself. */
  const span = (r: Row): [number, number] => (r.kind === 'heading' ? [r.index, sectionEnd(blocks, r.index)] : [r.index, r.index + 1])

  const jump = (r: Row) => {
    const doc = editor.state.doc
    const node = doc.child(r.index)
    const pos = posOf(doc, r.index)
    // A heading: the end of its text, as before. A paragraph: its start, ready to read on.
    const at = r.kind === 'heading' ? pos + node.nodeSize - 1 : pos + 1
    editor
      .chain()
      .focus()
      .setTextSelection(TextSelection.near(doc.resolve(at)).from)
      .scrollIntoView()
      .run()
  }

  const move = (r: Row, target: number) => {
    const [start, stop] = span(r)
    const tr = moveBlocks(editor.state, start, stop, target)
    if (!tr) return
    // The words of the move's message come from the document as it was.
    const after = all.find((x) => x.index === target && x.index < end)
    const before = [...all].reverse().find((x) => x.index < target && (x.index < start || x.index >= stop))
    const what = r.kind === 'heading' ? label(r) : `paragraph ${label(r)}`
    const where = after ? `above ${label(after)}` : before ? `below ${label(before)}` : 'to the top'
    onBeforeMove()
    const at = movedIndex(start, stop, target)
    const pos = posOf(tr.doc, at)
    const node = tr.doc.child(at)
    tr.setSelection(TextSelection.near(tr.doc.resolve(r.kind === 'heading' ? pos + node.nodeSize - 1 : pos + 1)))
    closeHistory(tr) // a move is its own step: ⌘Z undoes exactly this
    editor.view.dispatch(tr.scrollIntoView())
    // Close it on the far side too, or typing in the next half-second joins the move's undo step.
    editor.view.dispatch(closeHistory(editor.state.tr))
    focusAfter.current = at
    const moved = editor.state.doc
    notify(`Moved ${what} ${where}`, () => {
      if (editor.state.doc === moved) undo(editor.state, editor.view.dispatch)
      else notify('The page has changed since. Press ⌘Z to step back.')
    })
  }

  return (
    <>
      <div className="panel-head outline-head">
        Outline
        <span className="seg seg-text outline-view" role="radiogroup" aria-label="Outline shows">
          <button role="radio" aria-checked={view === 'headings'} className={view === 'headings' ? 'is-on' : ''} onClick={() => setView('headings')}>
            Headings
          </button>
          <button role="radio" aria-checked={view === 'paragraphs'} className={view === 'paragraphs' ? 'is-on' : ''} onClick={() => setView('paragraphs')}>
            Paragraphs
          </button>
        </span>
        <span className="count">{view === 'headings' ? `${rows.length}` : `${rows.filter((r) => r.kind !== 'heading').length}`}</span>
      </div>
      {view === 'headings' && !rows.length && (
        <p className="empty">
          No headings yet. Start a line with #, type /heading, or press {formatKey(binding('h1')) || 'the Heading key'}.{' '}
          {all.length > 0 && (
            <>
              To see the shape of the piece now,{' '}
              <button className="link" onClick={() => setView('paragraphs')}>
                list its paragraphs
              </button>
              .
            </>
          )}
        </p>
      )}
      {view === 'paragraphs' && !rows.length && <p className="empty">No paragraphs yet. Each one you write appears here by its first words.</p>}
      {rows.length > 0 && (
        <Rows
          rows={rows}
          view={view}
          top={top}
          end={end}
          blocks={blocks}
          span={span}
          jump={jump}
          move={move}
          focusAfter={focusAfter}
          step={(r, dir) => (r.kind === 'heading' && view === 'headings' ? sectionStep(blocks, r.index, dir) : r.kind === 'heading' ? null : paragraphStep(all, r.index, dir))}
        />
      )}
      {rows.length > 1 && (
        <p className="outline-hint" id={HINT_ID}>
          Drag to move{view === 'headings' ? ' a section, with everything under it' : ''}, or ⌥↑ ⌥↓.
        </p>
      )}
    </>
  )
}

function Rows({
  rows,
  view,
  top,
  end,
  blocks,
  span,
  jump,
  move,
  focusAfter,
  step,
}: {
  rows: Row[]
  view: OutlineView
  top: number
  end: number
  blocks: Block[]
  span: (r: Row) => [number, number]
  jump: (r: Row) => void
  move: (r: Row, target: number) => void
  focusAfter: React.MutableRefObject<number | null>
  step: (r: Row, dir: -1 | 1) => number | null
}) {
  const ref = useRef<HTMLElement>(null)
  const [drag, setDrag] = useState<Row | null>(null)
  const [gap, setGap] = useState<number | null>(null) // drop before rows[gap]; rows.length is after the last

  // In the Paragraphs view a heading row is a signpost: it can't be dragged, but rows can go either side of it.
  const movable = (r: Row) => view === 'headings' || r.kind !== 'heading'
  // Where gap k puts a row: before rows[k]'s block, or after the last row.
  const targetOf = (k: number) => (k < rows.length ? rows[k].index : view === 'headings' ? end : rows[rows.length - 1].index + 1)
  const allowed = (r: Row, k: number) => {
    const [s, e] = span(r)
    return canMove(blocks, s, e, targetOf(k))
  }

  // A long list draws only what's in view of the panel's scroll.
  const virtual = view === 'paragraphs' && rows.length > VIRTUAL_FROM
  const [win, setWin] = useState({ from: 0, to: VIRTUAL_FROM })
  useLayoutEffect(() => {
    if (!virtual) return
    const box = ref.current?.closest('.panel-body')
    if (!box || !ref.current) return
    const update = () => {
      const offset = ref.current!.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      const from = Math.max(0, Math.floor((box.scrollTop - offset) / ROW_H) - 10)
      const to = Math.min(rows.length, Math.ceil((box.scrollTop - offset + box.clientHeight) / ROW_H) + 10)
      setWin((w) => (w.from === from && w.to === to ? w : { from, to }))
    }
    update()
    box.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      box.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [virtual, rows.length])

  // After a move, the moved row keeps the keyboard focus, so ⌥↑ can be pressed again.
  useEffect(() => {
    const at = focusAfter.current
    if (at === null || !ref.current) return
    const k = rows.findIndex((r) => r.index === at)
    if (k < 0) return
    focusAfter.current = null
    const box = ref.current.closest('.panel-body')
    if (virtual && box) {
      const offset = ref.current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      const y = offset + k * ROW_H
      if (y < box.scrollTop || y + ROW_H > box.scrollTop + box.clientHeight) box.scrollTop = y - box.clientHeight / 2
    }
    requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)
      el?.focus({ preventScroll: !!virtual })
      if (!virtual) el?.scrollIntoView({ block: 'nearest' })
    })
  })

  const from = virtual ? win.from : 0
  const to = virtual ? win.to : rows.length
  const shown = rows.slice(from, to)

  return (
    <nav
      ref={ref}
      className={`outline${view === 'paragraphs' ? ' is-paras' : ''}${drag ? ' is-dragging' : ''}`}
      aria-label={view === 'headings' ? 'Sections' : 'Paragraphs'}
      style={virtual ? { paddingTop: from * ROW_H, paddingBottom: (rows.length - to) * ROW_H } : undefined}
      onDragOver={(e) => {
        if (!drag) return
        // Which gap between rows the pointer is nearest to.
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-k]')
        let k = rows.length
        if (row) {
          const r = row.getBoundingClientRect()
          k = Number(row.dataset.k) + (e.clientY > r.top + r.height / 2 ? 1 : 0)
        } else if (virtual && ref.current) {
          // A long list's padding stands in for the rows above and below what's drawn: land at that end.
          k = e.clientY < ref.current.getBoundingClientRect().top + from * ROW_H ? from : to
        }
        if (allowed(drag, k)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setGap(k)
        } else {
          e.dataTransfer.dropEffect = 'none'
          setGap(null)
        }
      }}
      onDragLeave={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node)) setGap(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (drag && gap !== null && allowed(drag, gap)) move(drag, targetOf(gap))
        setDrag(null)
        setGap(null)
      }}
    >
      {shown.map((r, i) => {
        const k = from + i
        const heading = r.kind === 'heading'
        const quote = !heading && isQuote(r)
        const short = !heading && !quote && r.words < SHORT_WORDS
        const [s, e] = drag ? span(drag) : [-1, -1]
        const inDrag = r.index >= s && r.index < e
        return (
          <button
            key={r.index}
            data-k={k}
            data-index={r.index}
            className={[
              'outline-item',
              heading ? `level-${r.level - top}` : 'is-para',
              view === 'paragraphs' && heading ? 'is-signpost' : '',
              inDrag ? 'is-moving' : '',
              gap === k ? 'drop-before' : '',
              gap === rows.length && k === rows.length - 1 ? 'drop-after' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={virtual ? { height: ROW_H } : undefined}
            draggable={movable(r)}
            title={heading ? r.text : r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text}
            aria-describedby={movable(r) && rows.length > 1 ? HINT_ID : undefined}
            onClick={() => jump(r)}
            onDragStart={(ev) => {
              ev.dataTransfer.effectAllowed = 'move'
              ev.dataTransfer.setData('application/x-ekdanta-outline', String(r.index))
              setDrag(r)
            }}
            onDragEnd={() => {
              setDrag(null)
              setGap(null)
            }}
            onKeyDown={(ev) => {
              if (!ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return
              ev.preventDefault()
              if (!movable(r)) return
              const target = step(r, ev.key === 'ArrowUp' ? -1 : 1)
              if (target !== null) move(r, target)
            }}
          >
            <span className="outline-text">{heading ? r.text : opening(r.text)}</span>
            {quote && <span className="outline-mark">(quote)</span>}
            {short && <span className="outline-mark">(short)</span>}
          </button>
        )
      })}
    </nav>
  )
}
