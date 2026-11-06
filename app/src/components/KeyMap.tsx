import { useEffect, useState } from 'react'
import { COMMANDS, binding, defaultKey, eventToKey, formatKey, normalize, reserved, usedBy, type Command, type Group } from '../lib/keys.ts'
import { helpMod } from '../editor/help.ts'

const GROUPS: Group[] = ['Text', 'Blocks', 'Editing', 'Navigate', 'App']

interface Pending {
  id: string
  key: string
  clash?: Command
  why?: string
}

/** Keyboard shortcuts, remappable as in VS Code or Notion: click one, press the new keys. */
export function KeyMap({ overrides, onChange }: { overrides: Record<string, string>; onChange: (keys: Record<string, string>) => void }) {
  const [recording, setRecording] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [query, setQuery] = useState('')

  /** Set a command's key, keeping only what differs from the defaults. */
  const assign = (changes: Record<string, string>) => {
    const next = { ...overrides }
    for (const [id, key] of Object.entries(changes)) {
      if (normalize(key) === normalize(defaultKey(id))) delete next[id]
      else next[id] = key
    }
    onChange(next)
  }

  useEffect(() => {
    if (!recording) return
    // Ahead of every other key handler, so the keys being recorded don't also do something.
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null)
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        assign({ [recording]: '' })
        return setRecording(null)
      }
      const key = eventToKey(e)
      if (!key) return // a modifier on its own: wait for the rest
      setRecording(null)
      const clash = usedBy(key, recording)
      const why = reserved(key)
      if (clash || why) setPending({ id: recording, key, clash, why })
      else assign({ [recording]: key })
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides])

  const q = query.trim().toLowerCase()
  const shown = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || formatKey(binding(c.id)).toLowerCase().includes(q))
  const changed = Object.keys(overrides).length

  return (
    <div className="keymap">
      <div className="keymap-tools">
        <input className="keymap-search" placeholder="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search shortcuts" />
        {changed > 0 && (
          <button className="link" onClick={() => onChange({})}>
            Reset all ({changed})
          </button>
        )}
      </div>
      {GROUPS.map((g) => {
        const rows = shown.filter((c) => c.group === g)
        if (!rows.length) return null
        return (
          <div key={g} className="keymap-group">
            <div className="keymap-group-name">{g}</div>
            {rows.map((c) => {
              const key = binding(c.id)
              const warn = key ? reserved(key) : undefined
              const isRec = recording === c.id
              const p = pending?.id === c.id ? pending : null
              return (
                <div key={c.id} className="keymap-row">
                  <span className="keymap-label">
                    {c.label}
                    {warn && !p && <small className="keymap-warn">Won’t work: {warn}</small>}
                    {p && (
                      <small className="keymap-warn">
                        {formatKey(p.key)} {p.clash ? `is already ${p.clash.label}.` : `won’t reach Ekdanta: ${p.why}.`}{' '}
                        <button
                          className="link"
                          onClick={() => {
                            // Swap: the other command takes this one's old key.
                            assign(p.clash ? { [c.id]: p.key, [p.clash.id]: key } : { [c.id]: p.key })
                            setPending(null)
                          }}
                        >
                          {p.clash ? 'Swap' : 'Use anyway'}
                        </button>{' '}
                        <button className="link muted" onClick={() => setPending(null)}>
                          Cancel
                        </button>
                      </small>
                    )}
                  </span>
                  <span className="keymap-actions">
                    {c.id in overrides && (
                      <button className="keymap-reset" title={`Back to ${formatKey(defaultKey(c.id)) || 'none'}`} onClick={() => assign({ [c.id]: defaultKey(c.id) })}>
                        ↺
                      </button>
                    )}
                    <button
                      className={`keymap-key${isRec ? ' is-rec' : ''}${!key ? ' is-none' : ''}${warn ? ' is-warn' : ''}`}
                      title={isRec ? 'Press the new keys · Esc to cancel · ⌫ to remove' : 'Click to change'}
                      onClick={() => {
                        setPending(null)
                        setRecording(isRec ? null : c.id)
                      }}
                    >
                      {isRec ? 'Press keys…' : key ? formatKey(key) : 'Add'}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="keymap-group">
        <div className="keymap-group-name">Help ladder · fixed</div>
        {[
          [`${helpMod}1 – ${helpMod}5`, 'Recall, Nudge, Word, Sentence, Passage'],
          ['Esc', 'Dismiss a suggestion'],
          ['Tab · ↵ · ⌫', 'Step through a diff, accept, reject'],
          ['⌘↵ · ⌘⌫', 'Accept all, reject all'],
          ['/ · [[', 'Block menu, link to a page'],
        ].map(([k, what]) => (
          <div key={k} className="keymap-row">
            <span className="keymap-label">{what}</span>
            <span className="keymap-key is-fixed">{k}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
