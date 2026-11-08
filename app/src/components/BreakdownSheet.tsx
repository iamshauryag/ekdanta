// Break it down: a long piece into shorter posts for other platforms. The writer picks what to make,
// sees a plan first (which of their passages each post draws on, highlighted in the piece, and its
// angle), changes it, then creates linked drafts. The piece is saved first and never changed.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api.ts'
import { findPassage, fit, quotedBody, type Format, type FormatInfo, type Options, type PlannedPost, type Target, type Unit, type CreateReply } from '../lib/breakdown.ts'
import './breakdown.css'

interface Props {
  path: string
  /** Finish any save in progress, so the plan reads everything typed. */
  flush: () => Promise<void>
  onOpenDoc: (path: string) => void
  /** New posts were written (and maybe a kind added): the sidebar and settings should look again. */
  onCreated: () => void
  onClose: () => void
}

/** A post in the plan, as the writer has it now. */
interface Draft extends PlannedPost {
  useHook: boolean
  adapt: boolean
}

const CHOICE_KEY = 'ekdanta.breakdown.choice'
const loadChoice = (): Record<string, number> => {
  try {
    const raw = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null')
    if (raw && typeof raw === 'object') return raw as Record<string, number>
  } catch {
    /* only a convenience */
  }
  return { linkedin: 1, 'x-post': 3 }
}
const saveChoice = (c: Record<string, number>) => {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(c))
  } catch {
    /* only a convenience */
  }
}

/** The format as the shared lib measures it, from what the server said about it. */
const asFormat = (f: FormatInfo): Format => ({
  id: f.id,
  label: f.label,
  shape: f.shape,
  measure: f.measure,
  limit: f.limit,
  hard: f.hard,
  parts: f.parts,
  kinds: [],
})

const n = (x: number) => x.toLocaleString()

export function BreakdownSheet({ path, flush, onOpenDoc, onCreated, onClose }: Props) {
  const sheet = useRef<HTMLDivElement>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, number>>(loadChoice)
  const [busy, setBusy] = useState<string | null>(null)
  const [units, setUnits] = useState<Unit[] | null>(null)
  const [posts, setPosts] = useState<Draft[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [by, setBy] = useState<'model' | 'sections'>('sections')
  const [active, setActive] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [done, setDone] = useState<CreateReply | null>(null)
  const nextId = useRef(100)

  useEffect(() => {
    let live = true
    flush()
      .then(() => api.breakdownOptions(path))
      .then((o) => live && setOptions(o))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
    }
  }, [path, flush])

  useEffect(() => {
    sheet.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const formats = useMemo(() => new Map((options?.formats ?? []).map((f) => [f.id, f])), [options])
  const builtIn = options?.formats.filter((f) => !f.id.startsWith('kind:')) ?? []
  const ownKinds = options?.formats.filter((f) => f.id.startsWith('kind:')) ?? []
  const targets: Target[] = Object.entries(choice)
    .filter(([id, c]) => c > 0 && formats.has(id))
    .map(([format, count]) => ({ format, count }))
  const total = targets.reduce((s, t) => s + t.count, 0)

  const setCount = (id: string, c: number) => {
    const next = { ...choice, [id]: Math.max(0, Math.min(10, c)) }
    setChoice(next)
    saveChoice(next)
  }

  const plan = async () => {
    setBusy(options?.allows.plan === 'model' ? 'Reading your piece and picking passages…' : 'Laying out your sections…')
    setError(null)
    try {
      await flush()
      const r = await api.breakdownPlan(path, targets)
      if (r.kind === 'plan') {
        setUnits(r.units)
        setBy(r.by)
        setNotes(r.notes)
        setPosts(r.posts.map((p) => ({ ...p, useHook: false, adapt: false })))
        setActive(r.posts[0]?.id ?? null)
      } else setError(r.message)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    setBusy(`Making ${posts.length === 1 ? 'the draft' : `${posts.length} drafts`}…`)
    setError(null)
    try {
      const r = await api.breakdownCreate(
        path,
        posts.map((p) => ({ format: p.format, angle: p.angle, hook: p.hook, useHook: p.useHook, adapt: p.adapt, passages: p.passages.map((q) => q.text) })),
      )
      setDone(r)
      onCreated()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const change = (id: string, patch: Partial<Draft>) => setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  // Select words in the piece, then add them to the post you're working on.
  const onSelect = useCallback(() => {
    const text = window.getSelection()?.toString() ?? ''
    setPicked(text.trim() && units && findPassage(units, text) ? text : null)
  }, [units])
  const addPicked = () => {
    if (!units || !picked || !active) return
    const found = findPassage(units, picked)
    const post = posts.find((p) => p.id === active)
    if (found && post && !post.passages.some((q) => q.text === found.text)) change(active, { passages: [...post.passages, found] })
    setPicked(null)
    window.getSelection()?.removeAllRanges()
  }

  const allows = options?.allows
  const wide = !!units && !done

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`sheet bd-sheet${wide ? ' is-wide' : ''}`} role="dialog" aria-label="Break it down" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <div className="bd-head">
            <h2>Break it down</h2>
            <span className="muted">{options?.title ?? ''}</span>
          </div>
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose} disabled={!!busy}>
            ✕
          </button>
        </header>

        {!options && !error && <p className="sheet-body empty">Reading the piece…</p>}

        {options && !units && !done && (
          <div className="sheet-body bd-body">
            {options.allows.plan === 'off' || options.short ? (
              <p className="bd-message">{options.allows.plan === 'off' ? options.note : options.short}</p>
            ) : (
              <>
                <p className="sheet-note">Turn this piece into shorter posts. You'll see a plan first: which of your passages each post draws on. Nothing in the piece changes.</p>
                <h3>What to make</h3>
                <div className="bd-formats">
                  {builtIn.map((f) => (
                    <FormatRow key={f.id} f={f} count={choice[f.id] ?? 0} onCount={(c) => setCount(f.id, c)} />
                  ))}
                </div>
                {ownKinds.length > 0 && (
                  <details className="bd-more" open={ownKinds.some((f) => (choice[f.id] ?? 0) > 0)}>
                    <summary>Your other kinds</summary>
                    <div className="bd-formats">
                      {ownKinds.map((f) => (
                        <FormatRow key={f.id} f={f} count={choice[f.id] ?? 0} onCount={(c) => setCount(f.id, c)} />
                      ))}
                    </div>
                  </details>
                )}
                <p className="bd-level">{options.note}</p>
              </>
            )}
            {error && (
              <p className="bd-error" role="alert">
                {error}
              </p>
            )}
            <div className="bd-actions">
              {options.allows.plan !== 'off' && !options.short && (
                <button className="btn primary" disabled={!total || !!busy} onClick={plan}>
                  {busy ?? `Plan ${total === 1 ? 'the post' : `${total} posts`}`}
                </button>
              )}
              <button className="btn" onClick={onClose} disabled={!!busy}>
                {options.short || options.allows.plan === 'off' ? 'Close' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {options && units && !done && (
          <div className="bd-plan">
            <div className="bd-posts" aria-label="The plan">
              <p className="sheet-note">
                {by === 'model' ? 'The model picked these passages from your piece.' : 'Planned from your own sections, in order.'} Drop or add passages (select words in the piece on the right),
                change the platform, or remove a post.
              </p>
              {notes.map((t) => (
                <p key={t} className="bd-note">
                  {t}
                </p>
              ))}
              {posts.map((p, i) => (
                <PostCard
                  key={p.id}
                  post={p}
                  index={i}
                  active={p.id === active}
                  info={formats.get(p.format)}
                  formats={options.formats}
                  allows={allows!}
                  onActive={() => setActive(p.id)}
                  onChange={(patch) => change(p.id, patch)}
                  onRemove={() => {
                    setPosts((ps) => ps.filter((x) => x.id !== p.id))
                    if (active === p.id) setActive(null)
                  }}
                />
              ))}
              <AddPost
                formats={options.formats}
                onAdd={(format) => {
                  const id = `n${nextId.current++}`
                  setPosts((ps) => [...ps, { id, format, angle: '', passages: [], useHook: false, adapt: false }])
                  setActive(id)
                }}
              />
            </div>
            <div className="bd-source" aria-label="Your piece" onMouseUp={onSelect} onKeyUp={onSelect}>
              <Source units={units} posts={posts} active={active} />
              {picked && active && (
                <div className="bd-pick" role="toolbar">
                  <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={addPicked}>
                    Add to post {posts.findIndex((p) => p.id === active) + 1}
                  </button>
                </div>
              )}
            </div>
            <footer className="bd-foot">
              {error && (
                <span className="bd-error" role="alert">
                  {error}
                </span>
              )}
              <button className="btn" disabled={!!busy} onClick={() => setUnits(null)}>
                Back
              </button>
              <button className="btn primary" disabled={!posts.length || !!busy} onClick={create}>
                {busy ?? `Create ${posts.length === 1 ? 'the draft' : `${posts.length} drafts`}`}
              </button>
            </footer>
          </div>
        )}

        {done && (
          <div className="sheet-body bd-body">
            <h3>{done.created.length === 1 ? 'One new draft' : `${done.created.length} new drafts`}, linked to this piece</h3>
            <ul className="bd-done">
              {done.created.map((c) => (
                <li key={c.path}>
                  <button
                    className="link"
                    onClick={() => {
                      onOpenDoc(c.path)
                      onClose()
                    }}
                  >
                    {c.title}
                  </button>
                  <span className={`muted${c.over ? ' bd-over' : ''}`}>
                    {' '}
                    · {n(c.length)} / {n(c.limit)} {c.unit}
                    {c.wording.startsWith('adapted') ? ' · adapted by the model: review it' : ''}
                  </span>
                  <div className="muted bd-path">{c.path}</div>
                </li>
              ))}
            </ul>
            {done.notes.map((t) => (
              <p key={t} className="bd-note">
                {t}
              </p>
            ))}
            <div className="bd-actions">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FormatRow({ f, count, onCount }: { f: FormatInfo; count: number; onCount: (c: number) => void }) {
  const limit = f.shape === 'thread' ? `${n(f.limit)} characters a post` : f.hard ? `up to ${n(f.limit)} ${f.unit}` : `about ${n(f.limit)} ${f.unit}`
  const habit = f.habit.pieces ? `your ${f.label}s run about ${n(f.habit.length)} ${f.unit}` : ''
  const voice = !f.adds && f.habit.pieces && !f.habit.voice ? 'no voice profile yet' : ''
  const where = f.adds ? `adds the kind ${f.kind}, filed in ${f.folder}/` : `in ${f.folder}/`
  return (
    <div className={`bd-format${count ? ' is-on' : ''}`}>
      <label>
        <input type="checkbox" checked={count > 0} onChange={(e) => onCount(e.target.checked ? 1 : 0)} />
        <b>{f.label}</b>
      </label>
      <span className="bd-count" aria-label={`How many ${f.label}s`}>
        <button className="icon-btn small" aria-label="Fewer" disabled={count <= 0} onClick={() => onCount(count - 1)}>
          −
        </button>
        <span>{count}</span>
        <button className="icon-btn small" aria-label="More" disabled={count >= 10} onClick={() => onCount(count + 1)}>
          +
        </button>
      </span>
      <small className="muted">{[limit, habit, voice, where].filter(Boolean).join(' · ')}</small>
    </div>
  )
}

function PostCard(p: {
  post: Draft
  index: number
  active: boolean
  info: FormatInfo | undefined
  formats: FormatInfo[]
  allows: Options['allows']
  onActive: () => void
  onChange: (patch: Partial<Draft>) => void
  onRemove: () => void
}) {
  const { post, info } = p
  const f = info ? asFormat(info) : null
  const body = f
    ? quotedBody(
        f,
        post.passages.map((q) => q.text),
        post.useHook ? post.hook : undefined,
      )
    : ''
  const now = f ? fit(f, body) : null
  return (
    <section className={`bd-post${p.active ? ' is-active' : ''}`} onFocusCapture={p.onActive} onMouseDown={p.onActive} aria-label={`Post ${p.index + 1}`}>
      <div className="bd-post-head">
        <span className="bd-num">{p.index + 1}</span>
        <select value={post.format} aria-label="Platform" onChange={(e) => p.onChange({ format: e.target.value, hook: undefined, useHook: false })}>
          {p.formats.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        {now && info && (
          <span className={`bd-len${now.over ? ' bd-over' : ''}`} title={now.over ? 'Over the limit: trim when you write it' : undefined}>
            {info.shape === 'thread' ? `${now.parts} part${now.parts === 1 ? '' : 's'} · longest ${n(now.length)} / ${n(now.limit)}` : `${n(now.length)} / ${n(now.limit)} ${info.unit}`}
          </span>
        )}
        <button className="icon-btn small" aria-label={`Remove post ${p.index + 1}`} title="Remove this post" onClick={p.onRemove}>
          ✕
        </button>
      </div>
      <input className="bd-angle" value={post.angle} placeholder="Angle: what this post is about (optional)" aria-label="Angle" onChange={(e) => p.onChange({ angle: e.target.value })} />
      {post.passages.length ? (
        <ul className="bd-passages">
          {post.passages.map((q, i) => (
            <li key={i}>
              <blockquote>{q.text}</blockquote>
              <button className="icon-btn small" aria-label="Drop this passage" title="Drop this passage" onClick={() => p.onChange({ passages: post.passages.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted bd-hint">No passages yet: select words in your piece and add them.</p>
      )}
      {post.hook && p.allows.opening && (
        <label className="bd-check">
          <input type="checkbox" checked={post.useHook} onChange={(e) => p.onChange({ useHook: e.target.checked })} />
          <span>
            Start with the suggested line: <q>{post.hook}</q>
          </span>
        </label>
      )}
      {p.allows.adapt !== 'none' && post.passages.length > 0 && (
        <label className="bd-check">
          <input type="checkbox" checked={post.adapt} onChange={(e) => p.onChange({ adapt: e.target.checked })} />
          <span>
            {p.allows.adapt === 'whole' ? 'Let the model draft it from these passages' : `Let the model adapt the wording for ${info?.label ?? 'this platform'}`}
            <small className="muted"> · the draft will say it was adapted</small>
          </span>
        </label>
      )}
    </section>
  )
}

function AddPost({ formats, onAdd }: { formats: FormatInfo[]; onAdd: (format: string) => void }) {
  const [format, setFormat] = useState(formats[0]?.id ?? '')
  return (
    <div className="bd-add">
      <select value={format} aria-label="Platform for the new post" onChange={(e) => setFormat(e.target.value)}>
        {formats.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => onAdd(format)}>
        Add a post
      </button>
    </div>
  )
}

/** The piece, paragraph by paragraph, with every planned passage highlighted (the post you're on, more strongly). */
function Source({ units, posts, active }: { units: Unit[]; posts: Draft[]; active: string | null }) {
  return (
    <div className="bd-piece">
      {units.map((u, i) => {
        const spans: { start: number; end: number; on: boolean; label: number }[] = []
        posts.forEach((p, pi) => {
          for (const q of p.passages) {
            if (q.unit !== u.id) continue
            const start = u.text.indexOf(q.text)
            if (start >= 0) spans.push({ start, end: start + q.text.length, on: p.id === active, label: pi + 1 })
          }
        })
        spans.sort((a, b) => a.start - b.start || Number(b.on) - Number(a.on))
        const out: ReactNode[] = []
        let at = 0
        for (const s of spans) {
          if (s.start < at) continue // overlapping passages: the first one shows
          if (s.start > at) out.push(u.text.slice(at, s.start))
          out.push(
            <mark key={s.start} className={s.on ? 'is-on' : ''} title={`Post ${s.label}`}>
              {u.text.slice(s.start, s.end)}
            </mark>,
          )
          at = s.end
        }
        out.push(u.text.slice(at))
        return (
          <div key={u.id}>
            {u.heading && units[i - 1]?.heading !== u.heading && <h4>{u.heading}</h4>}
            <p>{out}</p>
          </div>
        )
      })}
    </div>
  )
}
