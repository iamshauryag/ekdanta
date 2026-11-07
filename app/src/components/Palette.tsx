import { useEffect, useMemo, useRef, useState } from 'react'
import { COMMANDS, binding, formatKey, type Command } from '../lib/keys.ts'
import { orderCommands } from '../lib/fuzzy.ts'
import { QuickPanel } from './QuickPanel.tsx'

interface Props {
  /** Why a command can't run right now ("No document open"), or undefined if it can. */
  whyNot: (id: string) => string | undefined
  run: (id: string) => void
  recent: string[]
  onClose: () => void
}

/** Every command, by name (⌘⇧P). Recently used ones come first; those that can't run here are greyed with the reason. */
export function Palette({ whyNot, run, recent, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  // Not the palette itself: it's already open.
  const rows = useMemo(
    () =>
      orderCommands(
        COMMANDS.filter((c) => c.id !== 'palette'),
        recent,
        (c) => `${c.label} ${c.group}`,
        query,
      ),
    [recent, query],
  )
  const recentCount = query.trim() ? 0 : rows.filter((c) => recent.includes(c.id)).length
  const enabled = rows.map((c) => !whyNot(c.id))

  // The first command that can run is chosen as the list changes.
  useEffect(() => {
    const first = enabled.indexOf(true)
    setSel(first < 0 ? 0 : first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const move = (delta: number) => {
    if (!enabled.some(Boolean)) return
    let i = sel
    do i = (i + delta + rows.length) % rows.length
    while (!enabled[i])
    setSel(i)
  }
  const choose = (c: Command | undefined) => {
    if (!c || whyNot(c.id)) return
    run(c.id)
  }

  return (
    <QuickPanel label="All commands" onClose={onClose}>
      <input
        className="qp-input"
        autoFocus
        placeholder="Type a command"
        value={query}
        aria-label="Command"
        aria-controls="qp-list"
        aria-activedescendant={rows[sel] ? 'qp-' + rows[sel].id : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') move(e.key === 'ArrowDown' ? 1 : -1)
          else if (e.key === 'Enter') choose(rows[sel])
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      />
      <div className="qp-list" id="qp-list" role="listbox" ref={list}>
        {rows.map((c, i) => {
          const why = whyNot(c.id)
          const key = binding(c.id)
          return (
            <div key={c.id}>
              {recentCount > 0 && i === 0 && <div className="qp-section">Recently used</div>}
              {recentCount > 0 && i === recentCount && <div className="qp-section">All commands</div>}
              <div
                id={'qp-' + c.id}
                role="option"
                aria-selected={i === sel}
                aria-disabled={!!why}
                className={`qp-row${i === sel ? ' is-sel' : ''}${why ? ' is-off' : ''}`}
                onMouseMove={() => !why && i !== sel && setSel(i)}
                onClick={() => choose(c)}
              >
                <span className="qp-label">{c.label}</span>
                <span className="qp-group">{c.group}</span>
                {why ? <span className="qp-why">{why}</span> : key ? <kbd>{formatKey(key)}</kbd> : null}
              </div>
            </div>
          )
        })}
        {!rows.length && <div className="qp-empty">No command by that name</div>}
      </div>
    </QuickPanel>
  )
}
