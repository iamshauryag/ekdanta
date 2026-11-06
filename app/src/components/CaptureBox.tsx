import { useEffect, useRef, useState } from 'react'
import { binding, matches } from '../lib/keys.ts'

interface Props {
  /** Save the idea; resolves once it's in ideas.md. */
  onCapture: (text: string) => Promise<void>
  onClose: () => void
}

/**
 * Capture idea: one line, Enter, and back to where the writer was. Nothing else on the page moves;
 * the caret goes back where it was when the box closes.
 */
export function CaptureBox({ onCapture, onClose }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // Where the writer was, to go back to: the page keeps its selection while it isn't focused.
  const back = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null)

  useEffect(() => {
    input.current?.focus()
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close()
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    onClose()
    const el = back.current
    if (el instanceof HTMLElement && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }

  async function submit() {
    if (busy) return
    if (!text.trim()) return close()
    setBusy(true)
    setError(null)
    try {
      await onCapture(text)
      close()
    } catch (e) {
      // The words stay in the box, so nothing is lost.
      setError(`Couldn't save it: ${(e as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <div className="capture" ref={box} role="dialog" aria-label="Capture idea">
      <input
        ref={input}
        className="capture-input"
        value={text}
        placeholder="An idea, in a line"
        aria-label="Idea"
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Typing stays in the box; the app's shortcuts still work, and Capture idea's own key closes it.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape' || matches(e.nativeEvent, binding('captureIdea'))) {
            e.preventDefault()
            e.nativeEvent.stopPropagation()
            return close()
          }
          if (!(e.metaKey || e.ctrlKey || e.altKey) || e.key === 'Enter') e.nativeEvent.stopPropagation()
        }}
      />
      <div className="capture-foot">
        {error ? (
          <span className="capture-error" role="alert">
            {error}
          </span>
        ) : (
          <span>Saved to the end of ideas.md</span>
        )}
        <span className="capture-keys">
          <kbd>↵</kbd> save <kbd>esc</kbd> cancel
        </span>
      </div>
    </div>
  )
}
