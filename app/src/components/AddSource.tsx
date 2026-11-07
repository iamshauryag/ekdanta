import { useEffect, useRef, useState } from 'react'
import { api, type SourceCandidate, type Touched } from '../lib/api.ts'
import { CREATOR_LABELS, SOURCE_TYPES, STATUS_LABELS, TYPE_LABELS, isWebUrl, lookupKind, youtubeId, type SourceFields, type SourceStatus, type SourceType } from '../lib/brain.ts'

/** A small modal: Esc or a click outside closes it, and focus comes back to where it was. */
/** Open dialogs, innermost last: only that one answers Tab and Esc. */
const openDialogs: HTMLElement[] = []
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0)

/**
 * A modal dialog. Tab and Shift-Tab go round inside it, focus that wanders out (a click on the
 * dialog's padding, say) is brought back, and Esc closes it from wherever focus is.
 */
export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const el = box.current
    if (!el) return
    const before = document.activeElement as HTMLElement | null
    openDialogs.push(el)
    const top = () => openDialogs[openDialogs.length - 1] === el
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') ?? focusables(el)[0] ?? el).focus()
    const onKey = (e: KeyboardEvent) => {
      if (!top() || e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close.current()
      } else if (e.key === 'Tab') {
        const items = focusables(el)
        if (!items.length) return e.preventDefault()
        const at = document.activeElement as HTMLElement | null
        const i = at ? items.indexOf(at) : -1
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          items[items.length - 1].focus()
        } else if (!e.shiftKey && (i === -1 || i === items.length - 1)) {
          e.preventDefault()
          items[0].focus()
        }
      }
    }
    const onFocus = (e: FocusEvent) => {
      if (top() && !el.contains(e.target as Node)) (focusables(el)[0] ?? el).focus()
    }
    // On the document, so Esc works even when focus has left the dialog for the page behind it.
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
      openDialogs.splice(openDialogs.indexOf(el), 1)
      before?.focus?.()
    }
  }, [])
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label} ref={box} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const EMPTY: SourceFields = { type: 'book', title: '', author: '', url: '', isbn: '', year: '', status: '', rating: '', started: '', finished: '', tags: '' }

/**
 * Add a source to the Brain. Details are typed by hand, or looked up from a pasted link, ISBN or
 * title — only when the writer presses Look up, which says it goes online.
 */
export function AddSource({ onClose, onSaved }: { onClose: () => void; onSaved: (r: { path: string; existed: boolean; touched?: Touched[] }) => void }) {
  const [f, setF] = useState<SourceFields>(EMPTY)
  const [paste, setPaste] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SourceFields>) => setF((x) => ({ ...x, ...patch }))

  const kind = lookupKind(paste)
  const pastedUrl = kind === 'url' ? (/^https?:/i.test(paste.trim()) ? paste.trim() : `https://${paste.trim()}`) : ''

  const pick = (c: SourceCandidate) => {
    setF((x) => ({ ...x, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v)), type: c.type }))
    setCandidates(null)
  }

  const look = async () => {
    setLookupError(null)
    setCandidates(null)
    if (kind === 'refused') return setLookupError('Only web addresses (http or https) can be looked up.')
    if (kind === 'empty') return
    setLooking(true)
    try {
      const { candidates } = await api.lookupSource(paste)
      if (!candidates.length) setLookupError(kind === 'title' ? 'Nothing found by that title. Type the details below.' : 'No details found. Type them below.')
      else if (candidates.length === 1) pick(candidates[0])
      else setCandidates(candidates)
      if (pastedUrl && !candidates.length) set({ url: pastedUrl })
    } catch (e) {
      setLookupError((e as Error).message)
      if (pastedUrl) set({ url: pastedUrl })
    } finally {
      setLooking(false)
    }
  }

  const save = async (fields: SourceFields = f) => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await api.addSource(fields))
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  const urlBad = !!f.url?.trim() && !isWebUrl(f.url)
  const canSave = !saving && !urlBad && (!!f.title.trim() || !!f.url?.trim())

  return (
    <Dialog label="Add a source" onClose={onClose}>
      <h2>Add a source</h2>
      <div className="lookup">
        <div className="field">
          <label htmlFor="brain-lookup">Link, ISBN or title</label>
          <div className="lookup-row">
            <input
              id="brain-lookup"
              autoFocus
              value={paste}
              placeholder="https://youtu.be/…, 978…, or a book title"
              onChange={(e) => {
                setPaste(e.target.value)
                setLookupError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  look()
                }
              }}
            />
            <button className="btn" disabled={looking || kind === 'empty'} onClick={look}>
              {looking ? 'Looking up…' : 'Look up'}
            </button>
          </div>
          <small className="muted">Looks up details online (YouTube, Open Library, or the page itself). Or just type them below.</small>
        </div>
        {lookupError && (
          <p className="brain-error">
            {lookupError}
            {pastedUrl && kind === 'url' && !f.title.trim() && (
              <>
                {' '}
                <button className="link" onClick={() => save({ ...f, type: youtubeId(pastedUrl) ? 'video' : f.type === 'book' ? 'article' : f.type, url: pastedUrl })}>
                  Save it with just the link
                </button>
              </>
            )}
          </p>
        )}
        {candidates && (
          <ul className="candidates" aria-label="Matches">
            {candidates.map((c, i) => (
              <li key={i}>
                <button onClick={() => pick(c)}>
                  <span className="t">{c.title}</span>
                  <span className="muted">
                    {[c.author, c.year].filter(Boolean).join(' · ')}
                    {c.isbn ? ` · ISBN ${c.isbn}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field">
        <span>Type</span>
        <div className="seg seg-text" role="radiogroup" aria-label="Type">
          {SOURCE_TYPES.map((t) => (
            <button key={t} role="radio" aria-checked={f.type === t} className={f.type === t ? 'is-on' : ''} onClick={() => set({ type: t as SourceType })}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Title</span>
        <input value={f.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{CREATOR_LABELS[f.type]}</span>
          <input value={f.author} placeholder={f.type === 'book' ? 'Last, First' : ''} onChange={(e) => set({ author: e.target.value })} />
        </label>
        <label className="field narrow">
          <span>Year</span>
          <input value={f.year} inputMode="numeric" maxLength={4} onChange={(e) => set({ year: e.target.value.replace(/\D/g, '') })} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Link</span>
          <input value={f.url} placeholder="https://" aria-invalid={urlBad} onChange={(e) => set({ url: e.target.value })} />
        </label>
        {f.type === 'book' && (
          <label className="field narrow">
            <span>ISBN</span>
            <input value={f.isbn} onChange={(e) => set({ isbn: e.target.value })} />
          </label>
        )}
      </div>
      {urlBad && <p className="brain-error">A link must start with http:// or https://</p>}
      <div className="field-row">
        <div className="field">
          <span>Status</span>
          <div className="seg seg-text" role="radiogroup" aria-label="Status">
            {(['', 'want', 'reading', 'done'] as const).map((st) => (
              <button
                key={st || 'none'}
                role="radio"
                aria-checked={f.status === st}
                className={f.status === st ? 'is-on' : ''}
                onClick={() =>
                  set({
                    status: st as SourceStatus | '',
                    started: st === 'reading' && !f.started ? today() : f.started,
                    finished: st === 'done' && !f.finished ? today() : st === 'done' ? f.finished : '',
                  })
                }
              >
                {st ? STATUS_LABELS[st] : 'None'}
              </button>
            ))}
          </div>
        </div>
        <div className="field narrow">
          <span>Rating</span>
          <div className="stars" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={f.rating === String(n)}
                aria-label={`${n} of 5`}
                className={+(f.rating || 0) >= n ? 'is-on' : ''}
                onClick={() => set({ rating: f.rating === String(n) ? '' : String(n) })}
              >
                ★
              </button>
            ))}
          </div>
        </div>
      </div>
      {(f.status === 'reading' || f.status === 'done') && (
        <div className="field-row">
          <label className="field">
            <span>Started</span>
            <input type="date" value={f.started} onChange={(e) => set({ started: e.target.value })} />
          </label>
          {f.status === 'done' && (
            <label className="field">
              <span>Finished</span>
              <input type="date" value={f.finished} onChange={(e) => set({ finished: e.target.value })} />
            </label>
          )}
        </div>
      )}
      <label className="field">
        <span>Tags</span>
        <input value={f.tags} placeholder="writing, craft" onChange={(e) => set({ tags: e.target.value })} />
      </label>
      {error && <p className="brain-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!canSave} onClick={() => save()}>
          {saving ? 'Saving…' : 'Add to Brain'}
        </button>
      </div>
    </Dialog>
  )
}
