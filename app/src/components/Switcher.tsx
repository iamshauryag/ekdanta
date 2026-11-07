import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileEntry } from '../lib/api.ts'
import { duplicateTitles, fold, rankFiles, recentFiles } from '../lib/fuzzy.ts'
import { formatKey } from '../lib/keys.ts'
import { QuickPanel } from './QuickPanel.tsx'

interface Props {
  files: FileEntry[]
  current: string | null
  recent: string[]
  onOpen: (path: string) => void
  onCreate: (title: string) => void
  onClose: () => void
}

interface Row {
  file?: FileEntry
  positions?: number[]
  note?: string
}

/** Open a document by its title (⌘O). Nothing typed: the recent ones. A title that isn't there yet can be created. */
export function Switcher({ files, current, recent, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const q = query.trim()

  const dup = useMemo(() => duplicateTitles(files), [files])
  const rows: Row[] = useMemo(() => {
    if (!q) return recentFiles(recent, files, current).map((file) => ({ file }))
    return rankFiles(q, files, 50).map((r) => ({
      file: r.file,
      positions: r.field === 'title' ? r.positions : undefined,
      note: r.field === 'alias' ? `also ${r.alias}` : r.field === 'path' ? r.file.path : undefined,
    }))
  }, [q, files, recent, current])
  // "Create" unless a document already has exactly this title.
  const canCreate = !!q && !files.some((f) => fold(f.title.trim()) === fold(q))
  const all: Row[] = canCreate ? [...rows, {}] : rows

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const choose = (row: Row | undefined) => {
    if (row?.file) onOpen(row.file.path)
    else if (row && q) onCreate(q)
  }

  return (
    <QuickPanel label="Quick open" onClose={onClose}>
      <input
        className="qp-input"
        autoFocus
        placeholder="Open a document by title"
        value={query}
        aria-label="Document title"
        aria-controls="qp-list"
        aria-activedescendant={all.length ? `qp-row-${sel}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && all.length) setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length)
          else if (e.key === 'Enter' && e.shiftKey) q && onCreate(q)
          else if (e.key === 'Enter') choose(all[sel])
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      />
      <div className="qp-list" id="qp-list" role="listbox" ref={list}>
        {!q && rows.length > 0 && <div className="qp-section">Recent</div>}
        {all.map((row, i) => (
          <div
            key={row.file?.path ?? 'create'}
            id={`qp-row-${i}`}
            role="option"
            aria-selected={i === sel}
            className={`qp-row${i === sel ? ' is-sel' : ''}${row.file ? '' : ' is-create'}`}
            onMouseMove={() => i !== sel && setSel(i)}
            onClick={() => choose(row)}
          >
            {row.file ? (
              <>
                <span className="qp-label">{highlight(row.file.title, row.positions)}</span>
                {row.note ? <span className="qp-group">{row.note}</span> : dup.has(fold(row.file.title.trim())) && <span className="qp-group">{row.file.folder || 'Vault'}</span>}
                {row.file.path === current && <span className="qp-why">Open</span>}
              </>
            ) : (
              <>
                <span className="qp-label">
                  Create <b>“{q}”</b>
                </span>
                <kbd>{formatKey('Shift-Enter')}</kbd>
              </>
            )}
          </div>
        ))}
        {!all.length && <div className="qp-empty">{files.length ? 'No other documents yet' : 'No documents yet. Type a title to start one.'}</div>}
      </div>
      <div className="qp-foot">
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>{formatKey('Shift-Enter')}</kbd> create
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </QuickPanel>
  )
}

/** The title with the matched letters marked. */
function highlight(text: string, positions?: number[]): ReactNode {
  if (!positions?.length) return text
  const at = new Set(positions)
  const out: ReactNode[] = []
  let run = ''
  let marked = false
  const flush = (key: number) => {
    if (run) out.push(marked ? <mark key={key}>{run}</mark> : run)
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    if (at.has(i) !== marked) {
      flush(i)
      marked = at.has(i)
    }
    run += text[i]
  }
  flush(text.length)
  return out
}
