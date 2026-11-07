import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { BIG, deltaLabel, splitDoc, wordDiff, type DiffPart, type VersionRow } from '../lib/versions.ts'

interface Props {
  doc: string
  row: VersionRow
  /** The document as it is now, front matter included (unsaved typing too). */
  current: () => string
  onRestore: (content: string) => Promise<void>
  onNamed: () => void
  onClose: () => void
}

/** A version, read-only, over the page: what restoring it would change, or its plain text. */
export function VersionPreview({ doc, row, current, onRestore, onNamed, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'diff' | 'plain'>(() => {
    try {
      return localStorage.getItem('ekdanta.versionMode') === 'plain' ? 'plain' : 'diff'
    } catch {
      return 'diff'
    }
  })
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [naming, setNaming] = useState(false)
  const [now] = useState(current) // the text it's compared with, as it was when the preview opened
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  // Keys go to the preview, not the page under it; remember what to give focus back to on the way out.
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    box.current?.focus()
  }, [])

  /** Close and put focus back on whatever opened the preview, so the keyboard doesn't land on the page body. */
  const close = useCallback(() => {
    const back = opener.current
    if (back && back.isConnected) back.focus()
    onClose()
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    api
      .version(doc, row.id)
      .then((c) => !cancelled && setContent(c))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [doc, row.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || naming) return
      // Esc in a text field (the list's name box, say) belongs to that field, not to the preview.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, naming])

  const setPref = (m: 'diff' | 'plain') => {
    setMode(m)
    try {
      localStorage.setItem('ekdanta.versionMode', m)
    } catch {
      /* a convenience */
    }
  }

  const big = content !== null && (content.length > BIG || now.length > BIG)
  const parts = useMemo(() => {
    if (content === null || big) return null
    const a = splitDoc(now)
    const b = splitDoc(content)
    // The front matter is shown as it was, not as a diff: restoring keeps the properties the page has now,
    // so green and struck text there would promise a change that never happens.
    return { front: a.front === b.front ? null : b.front, body: wordDiff(a.body, b.body), same: now === content }
  }, [content, now, big])
  const showDiff = mode === 'diff' && !big

  const copy = async () => {
    if (content === null) return
    try {
      await navigator.clipboard.writeText(splitDoc(content).body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Couldn’t copy · select the text and copy it instead')
    }
  }

  const restore = async () => {
    if (content === null) return
    setBusy(true)
    try {
      await onRestore(content)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const when = new Date(row.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <div className="vh-preview" role="dialog" aria-label={`Version from ${when}`} tabIndex={-1} ref={box}>
      <div className="vh-bar">
        <div className="vh-title">
          {naming ? (
            <input
              className="vh-rename"
              autoFocus
              defaultValue={row.name ?? ''}
              maxLength={80}
              placeholder="Name this version"
              aria-label="Version name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  e.currentTarget.value = row.name ?? ''
                  e.currentTarget.blur()
                }
              }}
              onBlur={async (e) => {
                setNaming(false)
                if (e.target.value.trim() !== (row.name ?? '')) {
                  await api.nameVersion(doc, row.id, e.target.value).catch((err) => setError((err as Error).message))
                  onNamed()
                }
              }}
            />
          ) : (
            <button className="vh-title-name" title="Name this version (named versions are kept for good)" onClick={() => setNaming(true)}>
              {row.name ? <b>{row.name}</b> : <span className="muted">Name…</span>}
            </button>
          )}
          <span className="muted">
            {when} · {row.reason} · {deltaLabel(row.added, row.removed)}
          </span>
        </div>
        {!big && (
          <div className="seg seg-text" role="radiogroup" aria-label="Show">
            <button role="radio" aria-checked={mode === 'diff'} className={mode === 'diff' ? 'is-on' : ''} onClick={() => setPref('diff')}>
              Diff
            </button>
            <button role="radio" aria-checked={mode === 'plain'} className={mode === 'plain' ? 'is-on' : ''} onClick={() => setPref('plain')}>
              Plain
            </button>
          </div>
        )}
        <div className="vh-actions">
          <button className="btn primary" disabled={content === null || busy} onClick={restore}>
            {busy ? 'Restoring…' : 'Restore this version'}
          </button>
          <button className="btn" disabled={content === null} onClick={copy}>
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
      <div className="vh-scroll">
        {error && <p className="voice-error vh-note">{error}</p>}
        {content === null && !error && <p className="empty vh-note">Loading…</p>}
        {content !== null && (
          <>
            {big && <p className="vh-note">This version is over 1 MB, so it’s shown as plain text.</p>}
            {showDiff && parts && (
              <p className="vh-note">
                {parts.same ? (
                  'Same as the page now.'
                ) : (
                  <>
                    What restoring would do: <span className="vd-add">added back</span> <span className="vd-drop">taken out</span>.
                  </>
                )}
              </p>
            )}
            {showDiff && parts?.front != null && (
              <div className="vh-front">
                <div className="vh-front-label">Properties as they were then · restoring keeps the ones the page has now</div>
                {parts.front.trim() ? parts.front.trimEnd() : 'This version had none.'}
              </div>
            )}
            <div className="vh-text">{showDiff && parts ? <Diff parts={parts.body} /> : splitDoc(content).body}</div>
          </>
        )}
      </div>
    </div>
  )
}

function Diff({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.kind === 'ins' ? 'vd-add' : p.kind === 'del' ? 'vd-drop' : undefined}>
          {p.text}
        </span>
      ))}
    </>
  )
}
