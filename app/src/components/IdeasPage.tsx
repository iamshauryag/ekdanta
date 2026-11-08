import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type IdeaRow, type PartnerIdea } from '../lib/api.ts'
import { binding, formatKey } from '../lib/keys.ts'
import { kinds } from '../lib/kinds.ts'
import { IdeaPartner } from './IdeaPartner.tsx'

interface Props {
  /** Changes whenever an idea was captured elsewhere, so the list reads ideas.md again. */
  version: number
  onCapture: (text: string) => Promise<void>
  onStart: (text: string, kind: string) => Promise<void>
  /** Start a post from an idea the partner proposed (it's kept on the way). */
  onStartIdea: (idea: PartnerIdea, kind: string) => Promise<void>
  onOpenDoc: (path: string) => void
  /** The help ceiling: the idea partner holds to it. */
  ceiling: number
  /** The writer's notes, for the partner's "Angles on a note". */
  notes: { path: string; title: string }[]
}

/** Past this many characters an idea shows its start, with a way to read the rest. */
const LONG = 180

/**
 * Every idea in ideas.md, newest first. A star marks the ones worth coming back to (kept by the app,
 * not in the file); "Start as…" begins a piece of a chosen kind from the idea, with a pinned brief and
 * the notes it came from in its Thinking Space. Above the list, the idea partner brainstorms new ones
 * from the writer's own material when they ask.
 */
export function IdeasPage({ version, onCapture, onStart, onStartIdea, onOpenDoc, ceiling, notes }: Props) {
  const [data, setData] = useState<{ exists: boolean; ideas: IdeaRow[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyStarred, setOnlyStarred] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    () =>
      api
        .ideas()
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e: Error) => setError(e.message)),
    [],
  )
  useEffect(() => {
    load()
  }, [load, version])
  // ideas.md may have changed on a phone or in another editor while the app was in the background.
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  const star = async (idea: IdeaRow) => {
    const next = !idea.starred
    setData((d) => d && { ...d, ideas: d.ideas.map((i) => (i.text === idea.text ? { ...i, starred: next } : i)) })
    try {
      await api.starIdea(idea.text, next)
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  const add = async () => {
    if (busy || !draft.trim()) return
    setBusy(true)
    try {
      await onCapture(draft)
      setDraft('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ideas = data?.ideas ?? []
  const starred = ideas.filter((i) => i.starred).length
  const shown = onlyStarred && starred ? ideas.filter((i) => i.starred) : ideas
  const key = binding('captureIdea') ? formatKey(binding('captureIdea')) : ''

  return (
    <div className="page ideas-page">
      <div className="doc-meta">
        <span>Ideas</span>
        {data && <span className="muted">· {ideas.length === 1 ? '1 idea' : `${ideas.length} ideas`}</span>}
        <span className="muted path">ideas.md</span>
      </div>
      <h1 className="doc-title static">Ideas</h1>

      <div className="ideas-add">
        <input
          value={draft}
          placeholder="Add an idea"
          aria-label="Add an idea"
          spellCheck
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              add()
            }
          }}
        />
        {starred > 0 && (
          <div className="seg seg-text" role="radiogroup" aria-label="Show">
            <button role="radio" aria-checked={!onlyStarred} className={!onlyStarred ? 'is-on' : ''} onClick={() => setOnlyStarred(false)}>
              All
            </button>
            <button role="radio" aria-checked={onlyStarred} className={onlyStarred ? 'is-on' : ''} onClick={() => setOnlyStarred(true)}>
              ★ {starred}
            </button>
          </div>
        )}
      </div>
      <IdeaPartner ceiling={ceiling} notes={notes} onOpenDoc={onOpenDoc} onStart={onStartIdea} onKept={load} />

      {error && (
        <p className="ideas-error" role="alert">
          {error}
        </p>
      )}

      {data && !ideas.length && (
        <p className="empty ideas-empty">
          No ideas yet. {key ? <>Press {key} anywhere to catch one in a line. </> : null}They're kept in ideas.md at the top of your vault, a plain list you can add to from your phone too.
        </p>
      )}

      <ul className="ideas-list">
        {shown.map((idea) => (
          <IdeaItem key={idea.text} idea={idea} onStar={() => star(idea)} onStart={(kind) => onStart(idea.text, kind)} onOpenDoc={onOpenDoc} />
        ))}
      </ul>
    </div>
  )
}

function IdeaItem({ idea, onStar, onStart, onOpenDoc }: { idea: IdeaRow; onStar: () => void; onStart: (kind: string) => Promise<void>; onOpenDoc: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // A partner idea shows its title and angle; any idea with [[links]] shows them as chips instead.
  const text = idea.title ? idea.title : (idea.shown ?? idea.text)
  const long = text.length > LONG
  // Cut at a word, not mid-word.
  const short = long ? text.slice(0, text.lastIndexOf(' ', LONG) > LONG / 2 ? text.lastIndexOf(' ', LONG) : LONG).trimEnd() + '…' : text
  // The kinds it suits come first in Start as….
  const suits = idea.platforms ?? []
  const menuKinds = [...kinds()].sort((a, b) => (suits.includes(a.id) ? suits.indexOf(a.id) : 99) - (suits.includes(b.id) ? suits.indexOf(b.id) : 99))

  useEffect(() => {
    if (!menu) return
    box.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])

  const start = async (kind: string) => {
    setMenu(false)
    setBusy(true)
    try {
      await onStart(kind)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`idea${idea.starred ? ' is-starred' : ''}`}>
      <button className="idea-star" aria-pressed={idea.starred} title={idea.starred ? 'Un-star' : 'Star'} aria-label={idea.starred ? 'Un-star' : 'Star'} onClick={onStar}>
        {idea.starred ? '★' : '☆'}
      </button>
      <div className="idea-body">
        <span className="idea-text">{open || !long ? text : short}</span>
        {long && (
          <button className="idea-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
        {idea.date && <span className="idea-date">{idea.date}</span>}
        {idea.title && idea.angle && idea.angle !== idea.title && <span className="idea-angle">{idea.angle}</span>}
        {idea.sources && idea.sources.length > 0 && (
          <span className="idea-sources">
            {idea.sources.map((s) =>
              s.path ? (
                <button key={s.name} className="ip-src" title={s.path} onClick={() => onOpenDoc(s.path!)}>
                  {s.name.split('/').pop()}
                </button>
              ) : (
                <span key={s.name} className="ip-src is-missing" title="This note is no longer in your vault">
                  {s.name.split('/').pop()}
                </span>
              ),
            )}
          </span>
        )}
      </div>
      <div className="idea-act" ref={box}>
        {idea.started ? (
          <button className="idea-started" title={`Open ${idea.started.title}`} onClick={() => onOpenDoc(idea.started!.path)}>
            Started → <span>{idea.started.title}</span>
          </button>
        ) : (
          <button className="idea-start" aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu((m) => !m)}>
            {busy ? 'Starting…' : 'Start as…'}
          </button>
        )}
        {menu && (
          <div
            className="menu idea-menu"
            role="menu"
            aria-label="Start as"
            onKeyDown={(e) => {
              const all = [...(box.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
              const i = all.indexOf(document.activeElement as HTMLElement)
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
              else if (e.key === 'Escape') {
                setMenu(false)
                box.current?.querySelector<HTMLElement>('.idea-start')?.focus()
              } else if (e.key === 'Tab') setMenu(false)
              else return
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            {menuKinds.map((k) => (
              <button key={k.id} role="menuitem" className={suits.includes(k.id) ? 'is-suggested' : undefined} onClick={() => start(k.id)}>
                {k.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}
