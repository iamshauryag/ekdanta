import { useEffect, useRef, useState } from 'react'
import { binding, formatKey } from '../lib/keys.ts'
import { Icon } from './Icon.tsx'

export interface MoreItem {
  /** The command it runs, for its shortcut. */
  id: string
  label: string
  run: () => void
}

/**
 * The rail's one "⋯ More" button: a short menu of things that don't need a button of their own
 * (All commands, Quick open, Search). Later features add their entries to `items`, not to the rail.
 */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) box.current?.querySelector<HTMLElement>('.rail-btn')?.focus()
  }

  return (
    <div className="more-wrap" ref={box}>
      <button className={`rail-btn${open ? ' is-on' : ''}`} title="More" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div
          className="menu more-menu"
          role="menu"
          aria-label="More"
          onKeyDown={(e) => {
            const all = [...(box.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
            const i = all.indexOf(document.activeElement as HTMLElement)
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
            else if (e.key === 'Escape') close(true)
            else if (e.key === 'Tab') close(false)
            else return
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              onClick={() => {
                close(false)
                item.run()
              }}
            >
              {item.label}
              {binding(item.id) && <kbd>{formatKey(binding(item.id))}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
