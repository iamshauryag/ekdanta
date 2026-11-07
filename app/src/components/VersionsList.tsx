import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { byDay, deltaLabel, type VersionRow } from '../lib/versions.ts'

interface Props {
  doc: string | null
  /** Changes whenever the versions may have changed (a save, a snapshot, a restore). */
  tick: number
  /** Changes when the writer asks to save a version from elsewhere (the palette): open the name field. */
  ask: number
  /** The version open in the preview. */
  open: string | null
  onSave: (name: string) => Promise<void>
  onOpen: (row: VersionRow) => void
}

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The open document's versions, by day, newest first. */
export function VersionsList({ doc, tick, ask, open, onSave, onOpen }: Props) {
  const [rows, setRows] = useState<VersionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const asked = useRef(ask)
  const saveBtn = useRef<HTMLButtonElement>(null)
  // Set when the name box is left by hand (saved, cancelled, Esc): focus goes back to the button it came from.
  const handBack = useRef(false)

  useEffect(() => {
    if (naming || !handBack.current) return
    handBack.current = false
    saveBtn.current?.focus()
  }, [naming])

  useEffect(() => {
    if (ask !== asked.current) {
      asked.current = ask
      setNaming(true)
    }
  }, [ask])

  useEffect(() => {
    if (!doc) return setRows([])
    let cancelled = false
    api
      .versions(doc)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setError(null)
      })
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [doc, tick])

  // A different document: a fresh list, and no half-typed name carried over.
  useEffect(() => {
    setRows(null)
    setNaming(false)
    setName('')
  }, [doc])

  const save = async () => {
    setBusy(true)
    try {
      await onSave(name.trim())
      handBack.current = true
      setNaming(false)
      setName('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const groups = byDay(rows ?? [])
  return (
    <>
      <div className="panel-head">
        Versions <em>· this document</em>
        {rows && <span className="count">{rows.length}</span>}
      </div>
      {naming ? (
        <form
          className="vh-namer"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) save()
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder="Name it (optional)"
            aria-label="Version name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                handBack.current = true
                setNaming(false)
                setName('')
              }
            }}
          />
          <button className="btn primary" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="link muted"
            onClick={() => {
              handBack.current = true
              setNaming(false)
              setName('')
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button ref={saveBtn} className="btn vh-save" onClick={() => setNaming(true)} disabled={!doc}>
          Save version…
        </button>
      )}
      {error && <p className="voice-error">{error}</p>}
      {rows && !rows.length && <p className="empty">No versions yet. Ekdanta keeps one as you write (every five minutes at most) and before big changes, like a rewrite you accept or a restore.</p>}
      {groups.map((g) => (
        <div key={g.label} className="vh-day">
          <div className="vh-day-label">{g.label}</div>
          {g.rows.map((r) => (
            <button key={r.id} className={`vh-row${open === r.id ? ' is-open' : ''}`} onClick={() => onOpen(r)} title="Preview this version">
              <span className="vh-time">{time(r.at)}</span>
              <span className="vh-main">
                {r.name && <b className="vh-name">{r.name}</b>}
                <span className="vh-delta">{deltaLabel(r.added, r.removed)}</span>
                <span className="vh-reason">{r.reason}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
