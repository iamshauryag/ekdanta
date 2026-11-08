// The Assistant tab: a chat about the piece that's open, kept per document (server/assistant.ts).
// It knows the draft and, if the writer keeps it attached, the selection. It never edits: a change
// comes back as a proposal, shown here as a word diff and on the page with the help ladder's own
// review (Tab, ↵, ⌫, ⌘↵), and goes in only when the writer accepts it. One ⌘Z takes it back out.
import type { Editor as TiptapEditor } from '@tiptap/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Status } from '../lib/api.ts'
import { LEVEL_NAMES, MESSAGE_MAX, SELECTION_MAX, applyAll, relocate, type Proposal, type Turn } from '../lib/assistant.ts'
import { kindName, kinds } from '../lib/kinds.ts'
import { binding, formatKey } from '../lib/keys.ts'
import { computeHunks, helpOf, proposeOnPage, textMap } from '../editor/help.ts'
import './assistant.css'

interface Props {
  active: boolean
  editor: TiptapEditor | null
  /** The piece the chat is about; null when none is open (or it's a source in the Brain). */
  doc: string | null
  platform: string
  ceiling: number
  status: Status | null
  onOpenDoc: (path: string) => void
  /** Open the Piece tab, where the help ceiling is. */
  onPiece: () => void
  notify: (text: string, undo?: () => void) => void
}

type Reply = { kind: 'answer'; turns: Turn[] } | { kind: 'error'; message: string; fix?: string } | { kind: 'stopped' }

/** The page's text, and the offset in it of a document position. */
function pageText(editor: TiptapEditor) {
  const doc = editor.state.doc
  const map = textMap(doc, 0, doc.content.size)
  const offsetOf = (pos: number) => {
    let lo = 0
    let hi = map.text.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (map.pos(mid) < pos) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return { ...map, offsetOf }
}

function selectionOf(editor: TiptapEditor | null): { text: string; start: number } | null {
  if (!editor || editor.isDestroyed) return null
  const sel = editor.state.selection
  if (sel.empty) return null
  const page = pageText(editor)
  const start = page.offsetOf(sel.from)
  const text = page.text.slice(start, page.offsetOf(sel.to))
  return text.trim() ? { text, start } : null
}

async function call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal })
  const data = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(data.error || `The server answered ${r.status}`)
  return data
}

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)

export function AssistantTab(p: Props) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // the ask being answered
  const [problem, setProblem] = useState<{ message: string; fix?: string } | null>(null)
  const [selection, setSelection] = useState<{ text: string; start: number } | null>(null)
  const [detached, setDetached] = useState<string | null>(null) // the selection the writer took off
  const [stale, setStale] = useState<Set<string>>(new Set())
  const [showing, setShowing] = useState<string | null>(null) // proposals on the page now
  const abort = useRef<AbortController | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)

  // The conversation for this piece.
  useEffect(() => {
    if (!p.doc) return
    let live = true
    call<{ turns: Turn[] }>('GET', `/api/assistant?doc=${encodeURIComponent(p.doc)}`)
      .then((r) => live && setTurns(r.turns))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [p.doc])

  // What's selected on the page, as an attached chip.
  useEffect(() => {
    const ed = p.editor
    if (!ed) return setSelection(null)
    const update = () => setSelection(selectionOf(ed))
    // A change shown on the page that went away unaccepted (typed over, dismissed) can be shown again.
    const shown = () => {
      const h = helpOf(ed.state)
      if (h?.kind !== 'diff' || h.source !== 'assistant') setShowing(null)
    }
    update()
    ed.on('selectionUpdate', update)
    ed.on('update', update)
    ed.on('transaction', shown)
    return () => {
      ed.off('selectionUpdate', update)
      ed.off('update', update)
      ed.off('transaction', shown)
    }
  }, [p.editor])

  // The shortcut puts the caret in the ask box.
  useEffect(() => {
    const focus = () => box.current?.focus()
    window.addEventListener('ekdanta:assistant', focus)
    return () => window.removeEventListener('ekdanta:assistant', focus)
  }, [])

  useEffect(() => {
    if (p.active) end.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, busy, p.active])

  const attached = selection && selection.text !== detached && selection.text.length <= SELECTION_MAX ? selection : null

  const send = useCallback(
    async (message: string, allowOnce = false) => {
      const ed = p.editor
      if (!p.doc || !ed || busy || !message.trim()) return
      const ctl = new AbortController()
      abort.current = ctl
      setBusy(message.trim())
      setProblem(null)
      setInput('')
      try {
        const r = await call<Reply>('POST', '/api/assistant', { doc: p.doc, message, text: pageText(ed).text, platform: p.platform, selection: attached, allowOnce }, ctl.signal)
        if (r.kind === 'answer') setTurns((t) => [...t, ...r.turns])
        else if (r.kind === 'error') {
          setProblem({ message: r.message, fix: r.fix })
          setInput(message)
        }
      } catch (e) {
        if (ctl.signal.aborted) setInput(message)
        else {
          setProblem({ message: (e as Error).message })
          setInput(message)
        }
      } finally {
        if (abort.current === ctl) abort.current = null
        setBusy(null)
      }
    },
    [p.doc, p.editor, p.platform, busy, attached],
  )

  const stop = () => abort.current?.abort()

  const newChat = async () => {
    if (!p.doc) return
    stop()
    await call('DELETE', `/api/assistant?doc=${encodeURIComponent(p.doc)}`).catch(() => {})
    setTurns([])
    setProblem(null)
    setStale(new Set())
    box.current?.focus()
  }

  const decided = (turn: Turn, ids: string[], state: NonNullable<Proposal['state']>) => {
    setTurns((all) => all.map((t) => (t.id === turn.id ? { ...t, proposals: t.proposals?.map((x) => (ids.includes(x.id) ? { ...x, state } : x)) } : t)))
    setShowing(null)
    for (const id of ids) call('POST', '/api/assistant/outcome', { doc: p.doc, turn: turn.id, proposal: id, state }).catch(() => {})
  }

  /** Show proposals on the page as one diff, or accept them straight away. */
  const apply = (turn: Turn, list: Proposal[], accept: boolean) => {
    const ed = p.editor
    if (!ed || !list.length) return
    const page = pageText(ed)
    const found = list.map((x) => ({ x, at: relocate(page.text, x) }))
    const gone = found.filter((f) => !f.at).map((f) => f.x.id)
    if (gone.length) {
      setStale((s) => new Set([...s, ...gone]))
      return p.notify(gone.length === list.length ? 'That text has changed since · ask again' : 'Some of that text has changed since · review the others one by one')
    }
    const span = applyAll(
      page.text,
      found.map((f) => ({ start: f.at!.start, end: f.at!.end, replace: f.x.replace })),
    )
    if (!span) return p.notify('These changes overlap · review them one by one')
    const ask = [...turns].reverse().find((t) => t.role === 'writer' && t.at <= turn.at)?.text ?? ''
    const ids = list.map((x) => x.id)
    const ok = proposeOnPage({
      from: page.pos(span.start),
      to: page.pos(span.end),
      text: span.result,
      level: Math.max(3, Math.min(5, turn.level ?? 5)) as 3 | 4 | 5,
      instruction: `Assistant: ${short(ask, 120)}`,
      accept,
      onDone: (outcome) => decided(turn, ids, outcome),
    })
    if (!ok) return p.notify('Nothing to change there any more')
    if (accept) p.notify(list.length === 1 ? 'Change made' : `${list.length} changes made`, () => ed.chain().focus().undo().run())
    else setShowing(turn.id + ids.join())
  }

  const kind = kindName(kinds(), p.platform)
  const examples = [`Tighten this ${kind}`, 'Give me 3 hooks', 'What would a reader ask here?', 'Where does this drag?']
  const noModel = p.status && !p.status.strong && p.ceiling >= 2
  const key = binding('assistant') ? formatKey(binding('assistant')) : ''

  if (!p.doc) return <p className="empty">Open a piece to talk about it with the assistant.</p>
  if (!p.editor)
    return (
      <>
        <div className="panel-head">Assistant</div>
        <p className="empty">The assistant works with the page. Switch back from the Markdown view to use it.</p>
      </>
    )

  return (
    <div className="as">
      <div className="panel-head">
        Assistant <em>· this piece</em>
        {turns.length > 0 && (
          <button className="link as-new" onClick={newChat} title="Start a new conversation about this piece">
            New chat
          </button>
        )}
      </div>

      {p.ceiling === 0 ? (
        <div className="as-notice">
          <p>Help is off (help ceiling 0), so the assistant is too.</p>
          <button className="link" onClick={p.onPiece}>
            Change the help ceiling
          </button>
        </div>
      ) : noModel ? (
        <div className="as-notice">
          <p>No model is available, so the assistant can’t answer yet.</p>
          <p className="muted">Sign in to the Claude CLI (run claude once in a terminal), set ANTHROPIC_API_KEY before starting Ekdanta, or start Ollama with a model. Then reopen this tab.</p>
        </div>
      ) : null}

      <div className="as-log">
        {!turns.length && !busy && p.ceiling > 0 && !noModel && (
          <div className="as-empty">
            <p className="empty">Ask about this piece. It reads the draft and your selection, and can look through your notes. Nothing changes until you accept it.</p>
            <div className="as-examples">
              {examples.map((x) => (
                <button key={x} className="as-example" onClick={() => send(x)}>
                  {x}
                </button>
              ))}
            </div>
            {key && <p className="muted as-hint">Open this tab from anywhere with {key}</p>}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'writer' ? (
            <div key={t.id} className="as-writer">
              {t.selection && (
                <span className="as-chip is-quiet">
                  <span className="as-chip-text">Selection · {short(t.selection, 40)}</span>
                </span>
              )}
              <div className="as-bubble">{t.text}</div>
            </div>
          ) : (
            <AssistantTurn
              key={t.id}
              turn={t}
              last={i === turns.length - 1}
              ceiling={p.ceiling}
              stale={stale}
              showing={showing}
              busy={!!busy}
              onOpenDoc={p.onOpenDoc}
              onApply={(list, accept) => apply(t, list, accept)}
              onReject={(list) =>
                decided(
                  t,
                  list.map((x) => x.id),
                  'rejected',
                )
              }
              onAllowOnce={() => {
                const ask = turns[i - 1]
                if (ask?.role === 'writer') send(ask.text, true)
              }}
            />
          ),
        )}
        {busy && (
          <>
            <div className="as-writer">
              <div className="as-bubble">{busy}</div>
            </div>
            <div className="as-busy" role="status">
              <span className="as-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Reading your draft…
              <button className="link" onClick={stop}>
                Stop
              </button>
            </div>
          </>
        )}
        {problem && (
          <div className="as-notice is-error" role="alert">
            <p>{problem.message}</p>
            {problem.fix && <p className="muted">{problem.fix}</p>}
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="as-ask"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <div className="as-context">
          <span className="as-chip is-quiet" title="The assistant reads the whole piece">
            This {kind}
          </span>
          {attached && (
            <span className="as-chip" title={short(attached.text, 400)}>
              <span className="as-chip-text">Selection · {short(attached.text, 34)}</span>
              <button type="button" aria-label="Don’t send the selection" title="Don’t send the selection" onClick={() => setDetached(attached.text)}>
                ×
              </button>
            </span>
          )}
        </div>
        <textarea
          ref={box}
          value={input}
          maxLength={MESSAGE_MAX}
          rows={Math.min(6, Math.max(2, input.split('\n').length))}
          placeholder={attached ? 'Ask about the selection…' : 'Ask about this piece…'}
          aria-label="Ask the assistant"
          disabled={p.ceiling === 0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(input)
            }
          }}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="as-foot">
          <button type="button" className="link muted" onClick={p.onPiece} title="What the assistant may write follows the help ceiling, set in the Piece tab">
            Ceiling {p.ceiling} · {LEVEL_NAMES[p.ceiling] ?? ''}
          </button>
          {busy ? (
            <button type="button" className="btn" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!input.trim() || p.ceiling === 0}>
              Ask
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function AssistantTurn(p: {
  turn: Turn
  last: boolean
  ceiling: number
  stale: Set<string>
  showing: string | null
  busy: boolean
  onOpenDoc: (path: string) => void
  onApply: (list: Proposal[], accept: boolean) => void
  onReject: (list: Proposal[]) => void
  onAllowOnce: () => void
}) {
  const t = p.turn
  const open = (t.proposals ?? []).filter((x) => !x.state && !p.stale.has(x.id))
  const overCeiling = (t.dropped ?? []).filter((d) => d.reason === 'over the help ceiling').length
  const otherDropped = (t.dropped ?? []).length - overCeiling
  return (
    <div className="as-turn">
      <div className="as-text">{t.text}</div>
      {!!t.notes?.length && (
        <div className="as-notes">
          <span className="muted">From your notes</span>
          {t.notes.map((n) => (
            <button key={n.doc} className="as-chip" title={`Open ${n.title}`} onClick={() => p.onOpenDoc(n.doc)}>
              ↳ {n.folder ? `${n.folder} / ` : ''}
              {n.title}
            </button>
          ))}
        </div>
      )}
      {(t.proposals ?? []).map((x) => (
        <ProposalCard
          key={x.id}
          p={x}
          stale={p.stale.has(x.id)}
          showing={!!p.showing?.includes(x.id) && p.showing.startsWith(t.id)}
          onAccept={() => p.onApply([x], true)}
          onShow={() => p.onApply([x], false)}
          onReject={() => p.onReject([x])}
        />
      ))}
      {open.length > 1 && (
        <div className="as-all">
          <button className="link" onClick={() => p.onApply(open, true)}>
            Accept all {open.length}
          </button>
          <span className="muted">·</span>
          <button className="link" onClick={() => p.onApply(open, false)}>
            Review all on the page
          </button>
        </div>
      )}
      {(overCeiling > 0 || otherDropped > 0) && (
        <details className="as-more">
          <summary>{overCeiling > 0 ? `${overCeiling} change${overCeiling === 1 ? '' : 's'} went past your help ceiling` : `${otherDropped} change${otherDropped === 1 ? '' : 's'} left out`}</summary>
          <ul>
            {(t.dropped ?? []).map((d, i) => (
              <li key={i}>
                “{short(d.find, 50)}”: {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {p.last && overCeiling > 0 && p.ceiling >= 1 && p.ceiling < 5 && !p.busy && (
        <button className="link as-once" onClick={p.onAllowOnce} title="Ask the same again with full help, this once. The ceiling stays as it is.">
          Allow once: ask again with Passage help
        </button>
      )}
      {(t.looked ?? 0) > (t.notes?.length ?? 0) && <div className="muted as-meta">Looked through {t.looked} of your notes</div>}
    </div>
  )
}

function ProposalCard(p: { p: Proposal; stale: boolean; showing: boolean; onAccept: () => void; onShow: () => void; onReject: () => void }) {
  const hunks = computeHunks(p.p.find, p.p.replace)
  const state = p.stale ? 'text changed since' : p.p.state
  return (
    <div className={`as-card${state ? ' is-done' : ''}`}>
      <div className="as-diff">
        {hunks.map((h, i) =>
          h.kind === 'eq' ? (
            <span key={i}>{h.text}</span>
          ) : (
            <span key={i}>
              {h.del && <span className="vd-drop">{h.del}</span>}
              {h.ins && <span className="vd-add">{h.ins}</span>}
            </span>
          ),
        )}
      </div>
      {p.p.why && <div className="as-why">{p.p.why}</div>}
      <div className="as-actions">
        {state ? (
          <span className={`as-state is-${state.replace(/\s/g, '-')}`}>{state}</span>
        ) : p.showing ? (
          <span className="muted">On the page · Tab, ↵ and ⌫ decide each change</span>
        ) : (
          <>
            <button className="btn primary" onClick={p.onAccept}>
              Accept
            </button>
            <button className="btn" onClick={p.onShow}>
              Review on page
            </button>
            <button className="link muted" onClick={p.onReject}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}
