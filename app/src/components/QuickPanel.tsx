import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The box the palette and quick open sit in. While it's up it owns the keyboard: Esc closes it
 * wherever focus has got to, and Tab keeps the caret in its input rather than wandering off to the
 * page behind (where Esc would no longer reach it). Clicking a row doesn't take focus from the input.
 */
export function QuickPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close.current()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        box.current?.querySelector('input')?.focus()
      }
    }
    // Capture: before the page, the panel or the window's own shortcuts see the key.
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  return (
    <div className="qp-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qp" role="dialog" aria-modal="true" aria-label={label} ref={box} onMouseDown={(e) => !(e.target as Element).closest('input') && e.preventDefault()}>
        {children}
      </div>
    </div>
  )
}
