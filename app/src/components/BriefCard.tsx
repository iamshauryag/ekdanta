// The pinned brief, as the first card in the Piece tab: one line until opened, the whole brief when
// opened, and a paste box to pin or edit it. It's shown only once a brief is pinned (or being pinned).
import { useEffect, useRef, useState } from 'react'
import { BRIEF_MAX_CHARS, briefPlaceholder, cutBrief, firstLine, normalizeBrief } from '../lib/brief.ts'
import { Markdown } from '../lib/markdown.tsx'
import { helpMod } from '../editor/help.ts'

interface Props {
  /** The pinned brief, '' for none. */
  text: string
  platform: string
  editing: boolean
  onEditing: (on: boolean) => void
  /** Save the brief ('' unpins). Rejects with a message the card shows. */
  onSave: (text: string) => Promise<void>
  onUnpin: () => void
}

export function BriefCard({ text, platform, editing, onEditing, onSave, onUnpin }: Props) {
  const [open, setOpen] = useState(false)
  if (editing) return <BriefEditor text={text} platform={platform} onCancel={() => onEditing(false)} onSave={onSave} />
  if (!text.trim()) return null
  const cut = cutBrief(text)
  return (
    <section className={`brief-card${open ? ' is-open' : ''}`} aria-label="Pinned brief">
      <button className="brief-head" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Fold the brief' : 'Show the whole brief'}>
        <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 4.75 6 7.25l2.5-2.5" />
        </svg>
        <span className="brief-label">Brief</span>
        {/* Open, the brief itself shows its first line. */}
        {!open && <span className="brief-line">{firstLine(text)}</span>}
      </button>
      {open && (
        <div className="brief-body">
          <Markdown className="md brief-md" text={normalizeBrief(text)} />
          {cut.truncated && (
            <p className="brief-note">
              {helpMod}2 uses the first {cut.words.toLocaleString()} of {cut.total.toLocaleString()} words.
            </p>
          )}
          <div className="brief-actions">
            <button className="link" onClick={() => onEditing(true)}>
              Edit
            </button>
            <button className="link muted" onClick={onUnpin}>
              Unpin
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function BriefEditor({ text, platform, onCancel, onSave }: { text: string; platform: string; onCancel: () => void; onSave: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])
  const tooLong = draft.length > BRIEF_MAX_CHARS
  const cut = cutBrief(draft)
  const save = async () => {
    if (saving || tooLong) return
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }
  return (
    <section className="brief-card is-editing" aria-label="Pin a brief">
      <div className="brief-head static">
        <span className="brief-label">Brief</span>
        <span className="brief-hint">Stays beside the draft, never in it. {helpMod}2 Nudge reads it.</span>
      </div>
      <textarea
        ref={box}
        className="brief-input"
        value={draft}
        placeholder={briefPlaceholder(platform)}
        aria-label="Brief"
        rows={7}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      {tooLong ? (
        <p className="brief-note is-error">Too long to pin: the most is {BRIEF_MAX_CHARS.toLocaleString()} characters.</p>
      ) : (
        cut.truncated && (
          <p className="brief-note">
            Long: {helpMod}2 will use the first {cut.words.toLocaleString()} words.
          </p>
        )
      )}
      {error && <p className="brief-note is-error">{error}</p>}
      <div className="brief-actions">
        <button className="btn primary" disabled={saving || tooLong || (!text && !draft.trim())} onClick={save}>
          {text ? 'Save' : 'Pin'}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
