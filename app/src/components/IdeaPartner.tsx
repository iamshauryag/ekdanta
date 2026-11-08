import { useEffect, useRef, useState } from 'react'
import { api, type IndexState, type PartnerAsk, type PartnerIdea, type PartnerResult, type PartnerSource } from '../lib/api.ts'
import { kindName, kinds } from '../lib/kinds.ts'
import './ideas.css'

interface Props {
  ceiling: number
  /** The writer's notes, for "Angles on a note". */
  notes: { path: string; title: string }[]
  onOpenDoc: (path: string) => void
  /** Start a piece from a partner idea (it is kept on the way). */
  onStart: (idea: PartnerIdea, kind: string) => Promise<void>
  /** An idea was kept: the list reads ideas.md again. */
  onKept: () => void
}

interface Turn {
  id: number
  label: string
  req: PartnerAsk
  result: PartnerResult | null
  error?: string
}

/** What the writer did with each idea in this brainstorm. */
type Fate = 'kept' | 'discarded' | 'started'

// The brainstorm outlives the page: a writer who follows a source chip to a note and comes back finds it where it was.
let memory: { turns: Turn[]; fates: Record<string, Fate>; open: boolean } = { turns: [], fates: {}, open: false }

const QUICK: { label: string; req: PartnerAsk }[] = [
  { label: 'What could I write this week?', req: { scope: 'recent', ask: 'What could I write this week?' } },
  { label: 'Ideas from my highlights', req: { scope: 'highlights' } },
]

const sourceName = (s: PartnerSource) => (s.type === 'idea' ? 'Your idea' : s.title || s.doc.replace(/\.md$/, '').split('/').pop())

/**
 * The idea partner: the writer asks for post ideas ("about hiring", "what could I write this week?",
 * "angles on this note") and gets a few, each grounded in their own notes and showing which. Nothing
 * runs until they ask, and nothing is written until they keep an idea or start a post from one.
 */
export function IdeaPartner({ ceiling, notes, onOpenDoc, onStart, onKept }: Props) {
  const [open, setOpen] = useState(memory.open)
  const [turns, setTurns] = useState<Turn[]>(memory.turns)
  const [fates, setFates] = useState<Record<string, Fate>>(memory.fates)
  const [ask, setAsk] = useState('')
  const [platform, setPlatform] = useState('')
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState('')
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState<IndexState | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // At 0 the partner is off. At 1 an ask shows the writer's own material, and its answer carries a
  // one-use allowance the server keeps: Allow once spends it on one batch of ideas.
  const off = ceiling < 1
  const allKinds = kinds()

  useEffect(() => {
    memory = { turns, fates, open }
  }, [turns, fates, open])

  useEffect(() => {
    if (!running) return
    const poll = () => api.sparkState().then(setIndex, () => {})
    poll()
    const t = window.setInterval(poll, 700)
    return () => window.clearInterval(t)
  }, [running])

  const show = () => {
    setOpen(true)
    window.setTimeout(() => input.current?.focus(), 0)
  }

  /** Titles shown so far this time: follow-ups know them, and none is proposed twice. */
  const shownTitles = () => turns.flatMap((t) => t.result?.ideas.map((i) => i.title) ?? [])

  const run = async (req: PartnerAsk, label: string, allowToken?: string) => {
    if (running) return
    const id = Date.now()
    const history = turns
      .slice(0, 4)
      .reverse()
      .filter((t) => t.result)
      .map((t) => ({ ask: t.label, titles: t.result!.ideas.map((i) => i.title) }))
    const full: PartnerAsk = { ...req, platform: platform || undefined, history, avoid: shownTitles(), ...(allowToken ? { allowToken } : {}) }
    setTurns((ts) => [{ id, label, req, result: null }, ...ts])
    setRunning(true)
    try {
      const result = await api.ideaPartner(full)
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, result } : t)))
    } catch (e) {
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, error: (e as Error).message } : t)))
    } finally {
      setRunning(false)
      setIndex(null)
    }
  }

  const askNow = () => {
    if (picking) {
      const hit = notes.find((n) => n.title === note || n.path === note)
      if (!hit) return
      run({ scope: 'note', doc: hit.path, ask: ask.trim() || undefined }, `Angles on “${hit.title || hit.path}”${ask.trim() ? `: ${ask.trim()}` : ''}`)
      return
    }
    const a = ask.trim()
    if (!a) return
    run({ scope: 'ask', ask: a }, a)
    setAsk('')
  }

  const setFate = (key: string, fate: Fate) => setFates((f) => ({ ...f, [key]: fate }))

  if (!open)
    return (
      <div className="ip-closed">
        <button className="btn" onClick={show}>
          Brainstorm post ideas
        </button>
        <span className="muted">from your notes, past posts and highlights</span>
      </div>
    )

  const canAsk = picking ? notes.some((n) => n.title === note || n.path === note) : !!ask.trim()

  return (
    <section className="ip" aria-label="Idea partner">
      <header className="ip-head">
        <b>Idea partner</b>
        <span className="muted">· post ideas from your own material, when you ask</span>
        <button className="icon-btn ip-close" aria-label="Close the idea partner" title="Close" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>

      <div className="ip-quick">
        {QUICK.map((q) => (
          <button key={q.label} className="ip-chip" disabled={running || off} onClick={() => run(q.req, q.label)}>
            {q.label}
          </button>
        ))}
        <button className={`ip-chip${picking ? ' is-on' : ''}`} aria-pressed={picking} disabled={off} onClick={() => setPicking((p) => !p)}>
          Angles on a note…
        </button>
      </div>

      <form
        className="ip-ask"
        onSubmit={(e) => {
          e.preventDefault()
          if (!off) askNow()
        }}
      >
        {picking && (
          <>
            <input className="sp-input ip-note" list="ip-notes" placeholder="Which note?" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note to find angles in" />
            <datalist id="ip-notes">
              {notes.map((n) => (
                <option key={n.path} value={n.title || n.path}>
                  {n.path}
                </option>
              ))}
            </datalist>
          </>
        )}
        <input
          ref={input}
          className="sp-input ip-input"
          placeholder={picking ? 'Anything to aim for? (optional)' : 'Ask for ideas: “post ideas about hiring”, “a newsletter on slow writing”…'}
          value={ask}
          maxLength={500}
          onChange={(e) => setAsk(e.target.value)}
          aria-label="Ask the idea partner"
        />
        <label className="sp-suits">
          <span className="muted">For</span>
          <select className="sp-select" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Kind of writing">
            <option value="">Any kind</option>
            {allKinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        {!off && (
          <button className="btn primary" type="submit" disabled={!canAsk || running}>
            Ask
          </button>
        )}
      </form>

      {ceiling < 2 && (
        <div className="sp-off">
          <p>
            {off
              ? 'The idea partner is off at help ceiling 0. Raise the ceiling in the Piece panel to use it.'
              : 'At help ceiling 1 the idea partner shows what you’ve written on a topic. Asking a model for ideas is help level 2: raise the ceiling in the Piece panel, or allow it once under an answer.'}
          </p>
        </div>
      )}

      {running && (
        <div className="sp-wait" role="status">
          <span className="sp-spinner" aria-hidden="true" />
          {index?.building ? (
            <span>
              Reading your notes for the first time · {index.docs} {index.docs === 1 ? 'note' : 'notes'} so far
              {index.docs === 0 && ' (the first time, this downloads a 33 MB embedding model)'}
            </span>
          ) : (
            <span>Looking through your notes for ideas…</span>
          )}
        </div>
      )}

      <div className="ip-turns">
        {turns.map((t, n) => (
          <div key={t.id} className="ip-turn">
            <p className="ip-you">
              <span className="muted">You asked</span> {t.label}
            </p>
            {t.error && <p className="voice-error">{t.error}</p>}
            {t.result && (
              <>
                {t.result.reply && <p className="ip-reply">{t.result.reply}</p>}
                {t.result.note && <p className="muted sp-note">{t.result.note}</p>}
                {t.result.message && <p className="sp-empty">{t.result.message}</p>}
                {t.result.ideas.map((idea) => (
                  <IdeaCard
                    key={idea.key}
                    idea={idea}
                    fate={fates[idea.key]}
                    defaultKind={platform || idea.platforms[0] || allKinds[0]?.id || 'essay'}
                    onOpenDoc={onOpenDoc}
                    onFate={(f) => setFate(idea.key, f)}
                    onKept={onKept}
                    onStart={onStart}
                    onEdit={(next) =>
                      setTurns((ts) => ts.map((x) => (x.id !== t.id || !x.result ? x : { ...x, result: { ...x.result, ideas: x.result.ideas.map((i) => (i.key === idea.key ? next : i)) } })))
                    }
                  />
                ))}
                {t.result.mode === 'material' && t.result.material.length > 0 && <Material items={t.result.material} onOpenDoc={onOpenDoc} />}
                {t.result.canAllowOnce && t.result.allowToken && (
                  <button
                    className="btn ip-more"
                    disabled={running}
                    title="Asks a model for one batch of ideas, past your help ceiling"
                    onClick={() => {
                      const token = t.result!.allowToken
                      // Spent on the server with this click; the button goes so it isn't offered twice.
                      setTurns((ts) => ts.map((x) => (x.id === t.id && x.result ? { ...x, result: { ...x.result, allowToken: undefined } } : x)))
                      run(t.req, `${t.label} (allowed once)`, token)
                    }}
                  >
                    Allow once: ask for ideas
                  </button>
                )}
                {n === 0 && t.result.mode === 'ideas' && ceiling >= 2 && (
                  <button className="btn ip-more" disabled={running} onClick={() => run(t.req, `More like “${t.label}”`)}>
                    More ideas
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function Chips({ sources, onOpenDoc }: { sources: PartnerSource[]; onOpenDoc: (path: string) => void }) {
  return (
    <span className="ip-chips">
      {[...new Map(sources.map((s) => [s.type === 'idea' ? s.id : s.doc, s])).values()].map((s) =>
        s.type === 'idea' ? (
          <span key={s.id} className="ip-src is-idea" title={s.text}>
            Your idea
          </span>
        ) : (
          <button key={s.id} className="ip-src" title={`${s.doc}${s.type === 'highlight' ? ' · a highlight' : ''}`} onClick={() => onOpenDoc(s.doc)}>
            {s.type === 'highlight' ? '❝ ' : ''}
            {sourceName(s)}
          </button>
        ),
      )}
    </span>
  )
}

/** Without a model (or below the ceiling): the writer's own passages on it, each opening its note. */
function Material({ items, onOpenDoc }: { items: PartnerSource[]; onOpenDoc: (path: string) => void }) {
  return (
    <div className="sp-sources ip-material">
      <h3 className="sp-pairs-head">What you have on this</h3>
      {items
        .filter((s) => s.type !== 'idea')
        .slice(0, 8)
        .map((s) => (
          <blockquote key={s.id} className="sp-quote">
            <p>{s.text}</p>
            <footer>
              <button className="link sp-doc" title={s.doc} onClick={() => onOpenDoc(s.doc)}>
                [[{sourceName(s)}]]
              </button>
              {s.folder && <span className="muted"> · {s.folder}</span>}
            </footer>
          </blockquote>
        ))}
    </div>
  )
}

function IdeaCard({
  idea,
  fate,
  defaultKind,
  onOpenDoc,
  onFate,
  onKept,
  onStart,
  onEdit,
}: {
  idea: PartnerIdea
  fate?: Fate
  defaultKind: string
  onOpenDoc: (path: string) => void
  onFate: (f: Fate) => void
  onKept: () => void
  onStart: (idea: PartnerIdea, kind: string) => Promise<void>
  onEdit: (idea: PartnerIdea) => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState(defaultKind)
  const [draft, setDraft] = useState({ title: idea.title, hook: idea.hook ?? '', angle: idea.angle })
  const allKinds = kinds()

  if (fate === 'discarded') return null

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const keep = () =>
    act(async () => {
      const r = await api.keepIdea(idea)
      onFate('kept')
      onKept()
      if (!r.added) setError('Already in your ideas today.')
    })
  const discard = () =>
    act(async () => {
      await api.discardIdea(idea.title)
      onFate('discarded')
    })
  const start = () =>
    act(async () => {
      await onStart(idea, kind)
      onFate('started')
      onKept()
    })
  const saveEdit = () => {
    const title = draft.title.trim()
    if (!title) return
    onEdit({ ...idea, title, angle: draft.angle.trim() || title, ...(draft.hook.trim() ? { hook: draft.hook.trim() } : { hook: undefined }) })
    setEditing(false)
  }

  return (
    <article className={`sp-card ip-card${fate ? ' is-kept' : ''}`} aria-busy={busy}>
      {editing ? (
        <div className="ip-edit">
          <input className="sp-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Working title" />
          {idea.hook !== undefined && <input className="sp-input" value={draft.hook} onChange={(e) => setDraft({ ...draft, hook: e.target.value })} aria-label="Hook" placeholder="Hook" />}
          <textarea className="sp-input" rows={2} value={draft.angle} onChange={(e) => setDraft({ ...draft, angle: e.target.value })} aria-label="Angle" />
          <span className="ip-edit-act">
            <button className="btn primary" onClick={saveEdit}>
              Done
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <>
          <h3 className="sp-card-title">{idea.title}</h3>
          {idea.hook && (
            <p className="ip-hook">
              <span className="ip-label">Hook</span> {idea.hook}
            </p>
          )}
          <p className="sp-angle">{idea.angle}</p>
        </>
      )}
      <p className="ip-meta">
        {idea.platforms.length > 0 && <span className="ip-kinds">{idea.platforms.map((p) => kindName(allKinds, p)).join(' · ')}</span>}
        <span className="muted">from</span>
        <Chips sources={idea.sources} onOpenDoc={onOpenDoc} />
      </p>
      <details className="ip-passages">
        <summary>Show the passages</summary>
        <div className="sp-sources">
          {idea.sources.map((s) => (
            <blockquote key={s.id} className="sp-quote">
              <p>{s.text}</p>
              <footer className="muted">{s.type === 'idea' ? 'Your idea, in Ideas' : `${sourceName(s)}${s.folder ? ` · ${s.folder}` : ''}`}</footer>
            </blockquote>
          ))}
        </div>
      </details>
      {error && <p className="ideas-error">{error}</p>}
      <div className="sp-actions">
        {fate === 'kept' && <span className="muted sp-kept">Kept in Ideas</span>}
        {fate === 'started' && <span className="muted sp-kept">Kept and started</span>}
        {!fate && !editing && (
          <>
            <button className="btn" disabled={busy} onClick={keep}>
              Keep
            </button>
            <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn" disabled={busy} onClick={discard} title="Don’t suggest this again">
              Discard
            </button>
          </>
        )}
        {fate !== 'started' && !editing && (
          <span className="sp-start">
            <select className="sp-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of post">
              {allKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
            <button className="btn primary" disabled={busy} onClick={start}>
              Start a post
            </button>
          </span>
        )}
      </div>
    </article>
  )
}
