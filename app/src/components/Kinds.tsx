import { useState } from 'react'
import { DEFAULT_KINDS, newKind, type Kind } from '../lib/kinds.ts'

interface Props {
  kinds: Kind[]
  onChange: (kinds: Kind[]) => void
}

/** Settings · Kinds: the kinds of writing, each with its folder, typical length and how it should read. */
export function Kinds({ kinds, onChange }: Props) {
  const [draft, setDraft] = useState('')
  const [removed, setRemoved] = useState<{ kind: Kind; at: number } | null>(null)
  const missing = DEFAULT_KINDS.filter((d) => !kinds.some((k) => k.id === d.id))
  const taken = kinds.some((k) => k.name.toLowerCase() === draft.trim().toLowerCase())

  const edit = (id: string, patch: Partial<Kind>) => onChange(kinds.map((k) => (k.id === id ? { ...k, ...patch } : k)))
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const kind = !taken && newKind(draft, kinds)
    if (!kind) return
    onChange([...kinds, kind])
    setDraft('')
    setRemoved(null)
  }
  const remove = (kind: Kind) => {
    setRemoved({ kind, at: kinds.indexOf(kind) })
    onChange(kinds.filter((k) => k !== kind))
  }
  const undo = () => {
    if (!removed) return
    onChange([...kinds.slice(0, removed.at), removed.kind, ...kinds.slice(removed.at)])
    setRemoved(null)
  }
  const move = (i: number, by: number) => {
    const next = [...kinds]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onChange(next)
  }

  return (
    <>
      <form className="kind-add" onSubmit={add}>
        <input className="kind-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a kind: YT script, Letter, Speech…" aria-label="New kind of writing" maxLength={40} />
        <button className="btn" disabled={!draft.trim() || taken} title={taken ? 'You already have this kind' : undefined}>
          Add
        </button>
      </form>
      {removed && (
        <p className="sheet-note kind-removed">
          Removed {removed.kind.name}. Its pieces keep their kind, and come back with it if you add it again.{' '}
          <button className="link-btn" onClick={undo}>
            Undo
          </button>
        </p>
      )}

      <ul className="kinds">
        {kinds.map((k, i) => (
          <li key={k.id} className="kind">
            <div className="kind-head">
              <input
                className="kind-input kind-name"
                defaultValue={k.name}
                aria-label="Name"
                maxLength={40}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== k.name && edit(k.id, { name: e.target.value.trim() })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <label className="kind-words" title="A typical length, shown beside the word count">
                ~
                <input
                  className="kind-input"
                  type="number"
                  min={1}
                  max={50000}
                  defaultValue={k.words}
                  aria-label="Typical length in words"
                  onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== k.words && edit(k.id, { words: Math.round(Number(e.target.value)) })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                words
              </label>
              <span className="kind-tools">
                <button className="icon-btn small" title="Move up" aria-label={`Move ${k.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon-btn small" title="Move down" aria-label={`Move ${k.name} down`} disabled={i === kinds.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="icon-btn small" title="Remove" aria-label={`Remove ${k.name}`} disabled={kinds.length === 1} onClick={() => remove(k)}>
                  ✕
                </button>
              </span>
            </div>
            <textarea
              className="kind-input kind-guidance"
              defaultValue={k.guidance}
              rows={2}
              maxLength={400}
              placeholder="How it should read, for the help levels: a hook in the first ten seconds, spoken rhythm, short lines…"
              aria-label={`How a ${k.name} should read`}
              onBlur={(e) => e.target.value.trim() !== k.guidance && edit(k.id, { guidance: e.target.value.trim() })}
            />
            <small className="kind-folder">
              New pieces go in <code>{k.folder}/</code>
            </small>
          </li>
        ))}
      </ul>

      {missing.length > 0 && (
        <button className="link-btn" onClick={() => onChange([...kinds, ...missing])}>
          Bring back {missing.map((m) => m.name).join(', ')}
        </button>
      )}
    </>
  )
}
