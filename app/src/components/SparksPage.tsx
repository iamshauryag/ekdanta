import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type IndexState, type SparkCard, type SparkResult, type SparkSeed } from '../lib/api.ts'
import { kindName, kinds } from '../lib/kinds.ts'

interface Props {
  /**
   * Whether the page is showing. It stays mounted while hidden, so a writer who follows a source
   * link to a note and comes back finds the same cards: a run can't be repeated, it's random.
   */
  open: boolean
  /** The open piece, for the "This piece" seed. */
  doc: string | null
  docTitle: string
  /** The open piece's kind, the default for Start a piece. */
  platform: string
  ceiling: number
  onOpenDoc: (path: string) => void
  /** A piece was started from a spark: open it, in its Thinking Space. */
  onStarted: (path: string) => void
  onClose: () => void
}

type SeedKind = 'piece' | 'topic' | 'scope' | 'surprise'
const SEEDS: { id: SeedKind; label: string }[] = [
  { id: 'piece', label: 'This piece' },
  { id: 'topic', label: 'A topic' },
  { id: 'scope', label: 'A tag or folder' },
  { id: 'surprise', label: 'Surprise me' },
]

/**
 * Sparks: ideas that connect the writer's notes, each citing the passages it came from. Nothing
 * runs until the writer asks, and nothing is written anywhere until they Keep or Start a piece.
 */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function SparksPage({ open, doc, docTitle, platform, ceiling, onOpenDoc, onStarted, onClose }: Props) {
  const [seed, setSeed] = useState<SeedKind>(doc ? 'piece' : 'surprise')
  const [topic, setTopic] = useState('')
  const [scope, setScope] = useState('')
  const [suits, setSuits] = useState('')
  const [options, setOptions] = useState<{ docs: number; folders: string[]; tags: string[] } | null>(null)
  // Why the notes couldn't be read (the Recall index failed to build, say): not "too few notes".
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState<IndexState | null>(null)
  const [result, setResult] = useState<SparkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kept, setKept] = useState<Record<string, string>>({}) // card key → where it was kept
  const [busy, setBusy] = useState<string | null>(null) // the card being acted on
  const [startKind, setStartKind] = useState<Record<string, string>>({})
  const [started, setStarted] = useState<Record<string, string>>({}) // card key → the piece started from it
  // A More like this that found nothing, said under the card it was asked from.
  const [moreNote, setMoreNote] = useState<{ key: string; text: string } | null>(null)
  // Below the help ceiling, Allow once means one run each time the page is opened.
  const [usedOnce, setUsedOnce] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const off = ceiling < 2

  const loadOptions = () => {
    setOptionsError(null)
    api
      .sparkOptions()
      .then(setOptions)
      .catch((e) => {
        setOptions(null)
        setOptionsError((e as Error).message || 'The Recall index could not be read.')
      })
  }

  // Each time the page opens: fresh folders and tags, focus inside it, and the once-allowance back.
  // On close, focus goes back where the writer was.
  useEffect(() => {
    if (!open) return
    loadOptions()
    setUsedOnce(false)
    if (!doc) setSeed((s) => (s === 'piece' ? 'surprise' : s)) // the piece it was opened over is closed now
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.focus()
    return () => {
      const back = returnTo.current
      if (back?.isConnected) back.focus()
    }
  }, [open])

  // While a run waits on the Recall index (or the embedding model's first download), say so.
  useEffect(() => {
    if (!running) return
    const poll = () => api.sparkState().then(setIndex, () => {})
    poll()
    const t = window.setInterval(poll, 700)
    return () => window.clearInterval(t)
  }, [running])

  // A sheet opened over Sparks (Settings) may leave the keyboard on nothing when it closes: Esc then
  // still closes Sparks, as long as no other dialog is showing.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.target !== document.body) return
      if ([...document.querySelectorAll('[role=dialog]')].some((d) => d !== root.current)) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Keys are handled on the page itself, not the window: Esc in a sheet opened over Sparks (Settings,
  // say) closes that sheet, not Sparks underneath. Tab stays inside the page while it's open.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('select')) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      const all = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null)
      if (!all.length) return
      const [first, lastEl] = [all[0], all[all.length - 1]]
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === root.current)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && at === lastEl) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const seedNow = (): SparkSeed | null => {
    if (seed === 'piece') return doc ? { kind: 'piece', doc } : null
    if (seed === 'topic') return topic.trim() ? { kind: 'topic', topic: topic.trim() } : null
    if (seed === 'scope') return !scope ? null : scope.startsWith('#') ? { kind: 'tag', tag: scope.slice(1) } : { kind: 'folder', folder: scope }
    return { kind: 'surprise' }
  }

  /**
   * Ask for sparks. A fresh run replaces the cards; More like this (`after` a card) adds its cards
   * just below that one, so the ones the writer hasn't acted on yet stay where they were.
   */
  const run = async (s: SparkSeed | null, after?: SparkCard) => {
    if (!s || running || (off && usedOnce)) return
    setRunning(true)
    setError(null)
    setMoreNote(null)
    try {
      const shown = result?.cards ?? []
      const r = await api.sparks({ seed: s, suits: suits || undefined, exclude: after ? shown.map((c) => c.key) : [] })
      if (off) setUsedOnce(true)
      if (!after || !result) {
        setResult(r)
        setKept({})
        setStarted({})
        if (optionsError) loadOptions() // the index built after all
        return
      }
      const fresh = r.cards.filter((c) => !shown.some((o) => o.key === c.key))
      if (!fresh.length) return setMoreNote({ key: after.key, text: r.message || r.note || 'Nothing more like this yet.' })
      const at = shown.findIndex((c) => c.key === after.key)
      setResult({ ...result, cards: [...shown.slice(0, at + 1), ...fresh, ...shown.slice(at + 1)], note: r.note ?? result.note })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
      setIndex(null)
    }
  }

  const act = async (card: SparkCard, what: () => Promise<void>) => {
    setBusy(card.key)
    setError(null)
    try {
      await what()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const keep = (card: SparkCard) =>
    act(card, async () => {
      const { path } = await api.keepSpark(card)
      setKept((k) => ({ ...k, [card.key]: path }))
    })
  const dismiss = (card: SparkCard) =>
    act(card, async () => {
      await api.dismissSpark(card.key)
      setResult((r) => r && { ...r, cards: r.cards.filter((c) => c.key !== card.key) })
    })
  const start = (card: SparkCard) =>
    act(card, async () => {
      const { path } = await api.startFromSpark(card, kindFor(card))
      setStarted((m) => ({ ...m, [card.key]: path }))
      onStarted(path)
    })
  const moreLike = (card: SparkCard) => run({ kind: 'like', ids: card.sources.map((s) => s.id) }, card)

  const allKinds = kinds()
  const kindFor = (card: SparkCard) => startKind[card.key] ?? card.suits ?? (suits || (allKinds.some((k) => k.id === platform) ? platform : allKinds[0]?.id) || 'essay')
  const ready = !!seedNow()
  const tooFew = options !== null && options.docs < 2 && !running
  const spent = off && usedOnce

  return (
    <div className="sp" role="dialog" aria-modal="true" aria-label="Sparks" ref={root} tabIndex={-1} hidden={!open} onKeyDown={onKeyDown}>
      <header className="sp-head">
        <span className="sp-title">
          <b>Sparks</b> · ideas that connect your notes
        </span>
        <button className="icon-btn sp-close" title="Close  Esc" aria-label="Close Sparks" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="sp-scroll">
        <div className="sp-body">
          <section className="sp-seed" aria-label="Start from">
            <div className="seg seg-text" role="radiogroup" aria-label="Start from">
              {SEEDS.map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={seed === s.id}
                  className={seed === s.id ? 'is-on' : ''}
                  disabled={s.id === 'piece' && !doc}
                  title={s.id === 'piece' ? (doc ? docTitle || 'Untitled' : 'No piece open') : s.id === 'surprise' ? 'Starts from the notes you changed most recently' : undefined}
                  onClick={() => setSeed(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="sp-seed-row">
              {seed === 'piece' && <span className="muted sp-seed-what">From “{docTitle || 'Untitled'}”</span>}
              {seed === 'surprise' && <span className="muted sp-seed-what">From the notes you changed most recently</span>}
              {seed === 'topic' && (
                <input
                  className="sp-input"
                  autoFocus
                  placeholder="A topic, in a few words"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !off && run(seedNow())}
                  aria-label="Topic"
                />
              )}
              {seed === 'scope' && (
                <select className="sp-select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Tag or folder">
                  <option value="">Pick a tag or folder…</option>
                  {!!options?.folders.length && (
                    <optgroup label="Folders">
                      {options.folders.map((f) => (
                        <option key={f} value={f}>
                          {f}/
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {!!options?.tags.length && (
                    <optgroup label="Tags">
                      {options.tags.map((t) => (
                        <option key={t} value={'#' + t}>
                          #{t}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
              <label className="sp-suits">
                <span className="muted">Suits</span>
                <select className="sp-select" value={suits} onChange={(e) => setSuits(e.target.value)} aria-label="Suits">
                  <option value="">Any kind</option>
                  {allKinds.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
              {!off && (
                <button className="btn primary" disabled={!ready || running || tooFew} onClick={() => run(seedNow())}>
                  Find sparks
                </button>
              )}
            </div>
            {off && (
              <div className="sp-off">
                <p>
                  Sparks are off at help ceiling {ceiling}. They read across your notes and ask a model for ideas, which is help level 2. Change the ceiling in the Piece panel, or allow this once.
                </p>
                <button className="btn" disabled={!ready || running || tooFew || spent} onClick={() => run(seedNow())}>
                  {spent ? 'Allowed once' : 'Allow once'}
                </button>
              </div>
            )}
          </section>

          {tooFew && <p className="sp-empty">Sparks needs at least two notes with text.</p>}
          {optionsError && !running && <p className="voice-error">Couldn't read your notes for Sparks: {optionsError}</p>}

          {running && (
            <div className="sp-wait" role="status">
              <span className="sp-spinner" aria-hidden="true" />
              {index?.building ? (
                <span>
                  Building the Recall index · {index.docs} {index.docs === 1 ? 'note' : 'notes'}, {index.paragraphs} paragraphs so far
                  {index.docs === 0 && ' (the first time, this downloads a 33 MB embedding model)'}
                </span>
              ) : (
                <span>Reading across your notes…</span>
              )}
            </div>
          )}

          {error && <p className="voice-error">{error}</p>}

          {result && !running && (
            <section className="sp-results" aria-label="Sparks">
              {result.message && <p className="sp-empty">{result.message}</p>}
              {result.note && <p className="muted sp-note">{result.note}</p>}
              {result.cards.length > 0 && result.cards.every((c) => !c.title) && <h3 className="sp-pairs-head">These passages seem related</h3>}
              {!result.message && result.cards.length === 0 && <p className="sp-empty">Nothing new here, try another seed.</p>}
              {result.cards.map((card) => (
                <article key={card.key} className={`sp-card${kept[card.key] ? ' is-kept' : ''}`} aria-busy={busy === card.key}>
                  {card.title && <h3 className="sp-card-title">{card.title}</h3>}
                  {card.angle && <p className="sp-angle">{card.angle}</p>}
                  {card.why && <p className="sp-why">{card.why}</p>}
                  <div className="sp-sources">
                    {card.sources.map((s) => (
                      <blockquote key={s.id} className="sp-quote">
                        <p>{s.text}</p>
                        <footer>
                          <button className="link sp-doc" title={s.doc} onClick={() => onOpenDoc(s.doc)}>
                            [[{s.title || s.doc.replace(/\.md$/, '').split('/').pop()}]]
                          </button>
                          {s.folder && <span className="muted"> · {s.folder}</span>}
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                  <div className="sp-actions">
                    {kept[card.key] ? (
                      <span className="muted sp-kept">
                        Kept in{' '}
                        <button className="link" onClick={() => onOpenDoc(kept[card.key])}>
                          {kept[card.key]}
                        </button>
                      </span>
                    ) : (
                      <>
                        <button className="btn" disabled={!!busy} onClick={() => keep(card)}>
                          Keep
                        </button>
                        <button className="btn" disabled={!!busy} onClick={() => dismiss(card)} title="Never show this one again">
                          Dismiss
                        </button>
                      </>
                    )}
                    {!spent && (
                      <button className="btn" disabled={!!busy || running} onClick={() => moreLike(card)} title={off ? 'Sparks are off at your help ceiling: this allows one more run' : undefined}>
                        {off ? 'Allow once: more like this' : 'More like this'}
                      </button>
                    )}
                    {started[card.key] ? (
                      <span className="muted sp-kept">
                        Started{' '}
                        <button className="link" onClick={() => onOpenDoc(started[card.key])}>
                          {started[card.key]}
                        </button>
                      </span>
                    ) : (
                      <span className="sp-start">
                        <select className="sp-select" value={kindFor(card)} onChange={(e) => setStartKind((m) => ({ ...m, [card.key]: e.target.value }))} aria-label="Kind of piece">
                          {allKinds.map((k) => (
                            <option key={k.id} value={k.id}>
                              {kindName(allKinds, k.id)}
                            </option>
                          ))}
                        </select>
                        <button className="btn primary" disabled={!!busy} onClick={() => start(card)}>
                          Start a piece
                        </button>
                      </span>
                    )}
                  </div>
                  {moreNote?.key === card.key && <p className="muted sp-note">{moreNote.text}</p>}
                </article>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
