// Bars above the page for a save that needs the writer: the file changed on disk under unsaved text
// (ConflictBar), and smaller notices (a deleted file, text kept from a save that never landed).
import { useEffect, useMemo, useRef } from 'react'
import { diffWords } from 'diff'

export function ConflictBar({ onTheirs, onMine, onCompare }: { onTheirs: () => void; onMine: () => void; onCompare: () => void }) {
  return (
    <div className="save-bar is-conflict" role="alert">
      <span>Changed on disk</span>
      <span className="save-bar-actions">
        <button onClick={onTheirs} title="Replace your unsaved text with the version on disk">
          Load theirs
        </button>
        <button onClick={onMine} title="Save your text over the version on disk">
          Keep mine
        </button>
        <button onClick={onCompare} title="See the two versions word by word">
          Compare
        </button>
      </span>
    </div>
  )
}

export function NoticeBar({ text, actions }: { text: string; actions: { label: string; title?: string; run: () => void }[] }) {
  return (
    <div className="save-bar" role="status">
      <span>{text}</span>
      <span className="save-bar-actions">
        {actions.map((a) => (
          <button key={a.label} onClick={a.run} title={a.title}>
            {a.label}
          </button>
        ))}
      </span>
    </div>
  )
}

export interface CompareLabels {
  theirs: string
  mine: string
  useTheirs: string
  useMine: string
}
const ON_DISK: CompareLabels = { theirs: 'Only on disk', mine: 'Only in yours', useTheirs: 'Load theirs', useMine: 'Keep mine' }

/**
 * Two versions word by word: the one on disk beside the writer's (or the page beside unsaved changes kept
 * in this browser). Read-only: the choice is made with the same two buttons.
 */
export function CompareModal({
  theirs,
  mine,
  labels = ON_DISK,
  onClose,
  onTheirs,
  onMine,
}: {
  theirs: string
  mine: string
  labels?: CompareLabels
  onClose: () => void
  onTheirs: () => void
  onMine: () => void
}) {
  const parts = useMemo(() => {
    // Front matter that's the same on both sides is left out: the writing is what differs.
    const fm = (t: string) => t.match(/^---\n[\s\S]*?\n---\n*/)?.[0] ?? ''
    const same = fm(theirs) === fm(mine) ? fm(theirs).length : 0
    return diffWords(theirs.slice(same), mine.slice(same))
  }, [theirs, mine])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet compare-sheet" role="dialog" aria-label="Compare versions" tabIndex={-1} ref={box}>
        <header className="sheet-head">
          <h2>Compare versions</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="compare-key">
          <del>{labels.theirs}</del> <ins>{labels.mine}</ins>
        </p>
        <div className="compare-text">{parts.map((p, i) => (p.removed ? <del key={i}>{p.value}</del> : p.added ? <ins key={i}>{p.value}</ins> : <span key={i}>{p.value}</span>))}</div>
        <footer className="compare-foot">
          <button className="btn" onClick={onTheirs}>
            {labels.useTheirs}
          </button>
          <button className="btn primary" onClick={onMine}>
            {labels.useMine}
          </button>
        </footer>
      </div>
    </div>
  )
}
