// The Assistant tab: a chat about the piece that's open, kept per document (server/assistant.ts).
// It knows the draft and, if the writer keeps it attached, the selection. It never edits: a change
// comes back as a proposal, shown here as a word diff and on the page with the help ladder's own
// review (Tab, ↵, ⌫, ⌘↵), and goes in only when the writer accepts it. One ⌘Z takes it back out.
// A whole-piece ask comes back as many small changes; one that goes beyond the ask is marked, can be taken
// with only the asked-for part, and is left out of Accept all. At help ceiling 6 the writer can also ask
// for a whole draft in their voice ("Draft it for me"): it comes as one proposal like any other.
import type { Editor as TiptapEditor } from '@tiptap/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Status } from '../lib/api.ts'
import { DRAFT_LEVEL, LEVEL_NAMES, MESSAGE_MAX, SELECTION_MAX, applyAll, formatProblem, rebase, relocate, type Proposal, type Turn } from '../lib/assistant.ts'
import { kindName, kinds } from '../lib/kinds.ts'
import { binding, formatKey } from '../lib/keys.ts'
import { computeHunks, helpOf, proposeOnPage, textMap } from '../editor/help.ts'
import { formatApplies } from '../editor/format.ts'
import MarkdownIt from 'markdown-it'
import { formats, plainOf, safeMarkdown } from '../lib/rich.ts'
import { readAsk } from '../lib/scope.ts'
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
  /** Open the voice profile for this kind. */
  onVoice?: () => void
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
  // The position just after a text offset: at the very end, after the last character, inside its block.
  const endOf = (offset: number) => (offset > 0 && offset >= map.text.length ? map.pos(map.text.length - 1) + 1 : map.pos(offset))
  // Where text goes on an empty page: inside its first block.
  const startOf = (offset: number) => {
    if (map.text.length) return map.pos(offset)
    let at = 1
    doc.descendants((node, pos) => {
      if (node.isTextblock) {
        at = pos + 1
        return false
      }
      return at === 1
    })
    return at
  }
  return { ...map, offsetOf, endOf, startOf }
}

const SHOWN_CARDS = 6

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
  const [busy, setBusy] = useState<{ text: string; again: boolean } | null>(null) // the ask being answered
  const [problem, setProblem] = useState<{ message: string; fix?: string } | null>(null)
  const [selection, setSelection] = useState<{ text: string; start: number } | null>(null)
  const [detached, setDetached] = useState<string | null>(null) // the selection the writer took off
  const [stale, setStale] = useState<Set<string>>(new Set())
  const [refused, setRefused] = useState<Set<string>>(new Set()) // formatting the page found it can't apply as proposed
  const [showing, setShowing] = useState<string | null>(null) // proposals on the page now
  const [empty, setEmpty] = useState(true) // the page has no text: "Draft it for me" can show
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
    const update = () => {
      setSelection(selectionOf(ed))
      setEmpty(!ed.isDestroyed && !ed.state.doc.textContent.trim())
    }
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

  // A card never offers formatting the page would refuse: each one is tried on a copy of the page as it is.
  useEffect(() => {
    const ed = p.editor
    if (!ed || ed.isDestroyed) return
    const page = pageText(ed)
    const bad: string[] = []
    for (const t of turns) {
      if (t.drafted) continue
      for (const x of t.proposals ?? []) {
        const key = `${t.id}:${x.id}`
        if (x.state || refused.has(key) || !formats(x.find, x.replace)) continue
        const at = relocate(page.text, x)
        if (!at) continue
        const from = page.startOf(at.start)
        const to = at.end > at.start ? page.endOf(at.end) : page.startOf(at.end)
        if (!formatApplies(ed.state.tr, from, to, safeMarkdown(x.find, x.replace))) bad.push(key)
      }
    }
    if (bad.length) setRefused((s) => new Set([...s, ...bad]))
  }, [turns, p.editor, refused])

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
    /** Ask; or, with `allowOnce` (the id of a turn that went past the ceiling), have the server ask that turn's question again at level 5. */
    async (message: string, allowOnce?: string, draft?: boolean) => {
      const ed = p.editor
      if (!p.doc || !ed || busy || (!message.trim() && !allowOnce)) return
      const ctl = new AbortController()
      abort.current = ctl
      setBusy({ text: message.trim(), again: !!allowOnce })
      setProblem(null)
      if (!allowOnce) setInput('')
      // What was typed goes back in the box when the ask doesn't land.
      const restore = () => !allowOnce && setInput(message)
      try {
        const body = allowOnce
          ? { doc: p.doc, allowOnce, text: pageText(ed).text, platform: p.platform }
          : { doc: p.doc, message, text: pageText(ed).text, platform: p.platform, selection: attached, ...(draft ? { draft: true } : {}) }
        const r = await call<Reply>('POST', '/api/assistant', body, ctl.signal)
        if (r.kind === 'answer') setTurns((t) => [...t.map((x) => (x.id === allowOnce ? { ...x, allowSpent: true } : x)), ...r.turns])
        else if (r.kind === 'error') {
          setProblem({ message: r.message, fix: r.fix })
          restore()
        }
      } catch (e) {
        if (!ctl.signal.aborted) setProblem({ message: (e as Error).message })
        restore()
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
    setRefused(new Set())
    box.current?.focus()
  }

  const decided = (turn: Turn, ids: string[], state: NonNullable<Proposal['state']>) => {
    setTurns((all) => all.map((t) => (t.id === turn.id ? { ...t, proposals: t.proposals?.map((x) => (ids.includes(x.id) ? { ...x, state } : x)) } : t)))
    setShowing(null)
    for (const id of ids) call('POST', '/api/assistant/outcome', { doc: p.doc, turn: turn.id, proposal: id, state }).catch(() => {})
  }

  /** Show proposals on the page as one diff, or accept them straight away. With `narrow`, only the asked-for part of each. */
  const apply = (turn: Turn, list: Proposal[], accept: boolean, narrow = false) => {
    const ed = p.editor
    if (!ed || !list.length) return
    let refusedCount = 0
    const refusedAll = (n: number) => refusedCount === n
    const page = pageText(ed)
    if (turn.drafted && p.ceiling < DRAFT_LEVEL) return p.notify('Whole drafts are off at your help ceiling now')
    // A draft replaces the whole page, so it only goes in while the page is as it was when it was written.
    const found = list.map((x) => ({
      // Only what was asked is plain text, never formatting.
      x: narrow && x.narrow !== undefined ? { ...x, replace: x.narrow, format: false } : x,
      at: turn.drafted ? (page.text === x.find ? { start: 0, end: x.find.length } : null) : relocate(page.text, x),
    }))
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
    const ask = askOf(turn)
    const ids = list.map((x) => x.id)
    const before = page.text
    const ok = proposeOnPage({
      from: page.startOf(span.start),
      to: span.end > span.start ? page.endOf(span.end) : page.startOf(span.end),
      text: span.result,
      original: span.original,
      // Each change as itself, so the page applies exactly what was proposed, formatting as formatting.
      parts: found.map((f, index) => ({ start: f.at!.start - span.start, end: f.at!.end - span.start, replace: f.x.replace, format: !!f.x.format, index })),
      onRefused: (indexes) => {
        refusedCount = indexes.length
        setRefused(
          (s) =>
            new Set([
              ...s,
              ...indexes
                .map((i) => found[i]?.x.id)
                .filter((id): id is string => !!id)
                .map((id) => `${turn.id}:${id}`),
            ]),
        )
        p.notify(indexes.length === found.length ? 'That formatting can’t go in exactly as proposed · ask again' : 'Some formatting can’t go in exactly as proposed, so it was left out')
      },
      level: Math.max(3, Math.min(5, turn.level ?? 5)) as 3 | 4 | 5,
      instruction: `${turn.drafted ? 'Assistant draft' : 'Assistant'}: ${short(ask, 120)}`,
      accept,
      drafted: turn.drafted,
      onDone: (outcome) => {
        decided(turn, ids, narrow && outcome === 'accepted' ? 'partly accepted' : outcome)
        // The proposals still waiting move with the text, so the next one is found where it now is.
        const now = pageText(ed).text
        if (now !== before) setTurns((all) => all.map((t) => (t.proposals?.some((x) => !x.state) ? { ...t, proposals: rebase(before, now, t.proposals) } : t)))
      },
    })
    if (!ok) return refusedAll(found.length) ? undefined : p.notify('Nothing to change there any more')
    if (accept) p.notify(turn.drafted ? 'Draft added' : list.length === 1 ? 'Change made' : `${list.length} changes made`, () => ed.chain().focus().undo().run())
    else setShowing(turn.id + ids.join())
  }

  /** What the writer asked, for an answer: their message before it. */
  const askOf = (turn: Turn) => [...turns].reverse().find((t) => t.role === 'writer' && t.at <= turn.at)?.text ?? ''

  const kind = p.platform ? kindName(kinds(), p.platform) : 'piece'
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
            {p.ceiling >= DRAFT_LEVEL && empty && (
              <p className="as-draft-offer">
                <button className="btn primary" onClick={() => send(`Draft this ${kind} for me`, undefined, true)}>
                  Draft it for me
                </button>
                <span className="muted">A whole first draft in your voice, from your title, brief and past {kind} pieces. You review it before anything goes in.</span>
              </p>
            )}
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
              turn={recheck(t, askOf(t), refused)}
              last={i === turns.length - 1}
              ceiling={p.ceiling}
              kind={kind}
              onPiece={p.onPiece}
              onVoice={p.onVoice}
              stale={stale}
              showing={showing}
              busy={!!busy}
              onOpenDoc={p.onOpenDoc}
              onApply={(list, accept, narrow) => apply(t, list, accept, narrow)}
              onReject={(list) =>
                decided(
                  t,
                  list.map((x) => x.id),
                  'rejected',
                )
              }
              onAllowOnce={() => send('', t.id)}
            />
          ),
        )}
        {busy && (
          <>
            {!busy.again && (
              <div className="as-writer">
                <div className="as-bubble">{busy.text}</div>
              </div>
            )}
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
          {p.ceiling >= DRAFT_LEVEL && empty && turns.length > 0 && !busy && (
            <button type="button" className="link as-draft-link" onClick={() => send(input.trim() || `Draft this ${kind} for me`, undefined, true)} title="Write a whole first draft in your voice">
              Draft it for me
            </button>
          )}
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
  kind: string
  stale: Set<string>
  showing: string | null
  busy: boolean
  onOpenDoc: (path: string) => void
  onPiece: () => void
  onVoice?: () => void
  onApply: (list: Proposal[], accept: boolean, narrow?: boolean) => void
  onReject: (list: Proposal[]) => void
  onAllowOnce: () => void
}) {
  const t = p.turn
  const [all, setAll] = useState(false)
  const open = (t.proposals ?? []).filter((x: Shown) => !x.state && !x.refused && !p.stale.has(x.id))
  // Changes that go beyond the ask wait for the writer to decide on each.
  const clean = open.filter((x) => !x.beyond)
  const overCeiling = (t.dropped ?? []).filter((d) => d.reason === 'over the help ceiling').length
  const otherDropped = (t.dropped ?? []).length - overCeiling
  const needsMore = !!t.needs && t.needs <= 5 && t.needs > (t.level ?? 5)
  const draftOff = t.drafted && p.ceiling < DRAFT_LEVEL
  const cards = t.proposals ?? []
  const shown = all ? cards : cards.slice(0, SHOWN_CARDS)
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
      {clean.length > 1 && (
        <div className="as-all">
          <button className="link" onClick={() => p.onApply(clean, true)}>
            Accept all {clean.length}
          </button>
          <span className="muted">·</span>
          <button className="link" onClick={() => p.onApply(clean, false)}>
            Review all on the page
          </button>
        </div>
      )}
      {shown.map((x) => (
        <ProposalCard
          key={x.id}
          p={x}
          drafted={!!t.drafted}
          off={!!draftOff}
          stale={p.stale.has(x.id)}
          showing={!!p.showing?.includes(x.id) && p.showing.startsWith(t.id)}
          onAccept={(narrow) => p.onApply([x], true, narrow)}
          onShow={() => p.onApply([x], false)}
          onReject={() => p.onReject([x])}
        />
      ))}
      {cards.length > shown.length && (
        <button className="link as-show-all" onClick={() => setAll(true)}>
          Show all {cards.length} changes
        </button>
      )}
      {!!t.notices?.length && (
        <ul className="as-notices">
          {t.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {draftOff && <div className="muted as-meta">Whole drafts are off at your help ceiling now ({p.ceiling}), so this draft can’t go in.</div>}
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
      {t.allowOnceFor && <div className="muted as-meta">Asked again with Passage help, this once</div>}
      {p.last && (overCeiling > 0 || needsMore) && !t.allowSpent && !t.allowOnceFor && p.ceiling >= 2 && p.ceiling < 5 && !p.busy && (
        <button className="link as-once" onClick={p.onAllowOnce} title="Ask the same again with full help, this once. The ceiling stays as it is.">
          Allow once: ask again with Passage help
        </button>
      )}
      {p.last && t.needs === DRAFT_LEVEL && p.ceiling < DRAFT_LEVEL && (
        <button className="link as-once" onClick={p.onPiece} title="Whole drafts are opt-in: set the help ceiling to 6">
          Change the help ceiling
        </button>
      )}
      {t.drafted && t.noVoice && p.onVoice && (
        <button className="link as-once" onClick={p.onVoice}>
          Build your {p.kind} voice profile
        </button>
      )}
      {(t.looked ?? 0) > (t.notes?.length ?? 0) && <div className="muted as-meta">Looked through {t.looked} of your notes</div>}
    </div>
  )
}

/** The last few words before a change, or the first few after it: enough to see where it is. */
const around = (s: string | undefined, side: 'before' | 'after') => {
  if (!s) return ''
  const line = side === 'before' ? (s.split('\n').pop() ?? '') : (s.split('\n')[0] ?? '')
  const w = line.match(/\S+\s*|\s+/g) ?? []
  return side === 'before' ? w.slice(-3).join('') : w.slice(0, 3).join('')
}

/** A proposal as the tab shows it: why it can't go in as formatting, when it can't. */
type Shown = Proposal & { refused?: string }

/**
 * An answer's proposals checked again on the page, not taken from the chat file as saved: whether each
 * formats (only what the model added counts), whether that formatting is allowed at the level it was asked
 * at and by what was asked, and whether it goes beyond the ask.
 */
function recheck(turn: Turn, ask: string, refused: Set<string>): Turn & { proposals?: Shown[] } {
  if (!turn.proposals?.length || turn.drafted) return turn
  const read = readAsk(ask)
  return {
    ...turn,
    proposals: turn.proposals.map((x): Shown => {
      const format = formats(x.find, x.replace)
      const { format: _saved, ...rest } = x
      if (!format) return rest
      const problem = formatProblem(x.find, x.replace, turn.level ?? 5, read)
      const note = 'Changes the formatting too, which you didn’t ask for.'
      const beyond = !read.formatting && !x.beyond?.includes(note) ? [x.beyond, note].filter(Boolean).join(' ') : x.beyond
      return {
        ...rest,
        format: true,
        ...(beyond ? { beyond } : {}),
        ...(problem
          ? { refused: problem === 'over the help ceiling' ? 'over your help ceiling' : 'formatting the assistant can’t add' }
          : refused.has(`${turn.id}:${x.id}`)
            ? { refused: 'can’t go in exactly as proposed' }
            : {}),
      }
    }),
  }
}

let previewer: MarkdownIt | null = null
/** A formatting change as it will look: bold as bold, a list as a list. No raw HTML, no images, and links that go nowhere. */
function preview(md: string) {
  if (!previewer) {
    previewer = new MarkdownIt('commonmark', { html: false, linkify: false }).enable(['strikethrough'])
    previewer.renderer.rules.image = () => ''
    previewer.renderer.rules.link_open = () => '<a>'
  }
  return previewer.render(md)
}

function ProposalCard(p: { p: Shown; drafted: boolean; off: boolean; stale: boolean; showing: boolean; onAccept: (narrow?: boolean) => void; onShow: () => void; onReject: () => void }) {
  const fmt = !!p.p.format
  // The writer's own text stays text: only what the model added is read as Markdown.
  const md = fmt ? safeMarkdown(p.p.find, p.p.replace) : ''
  const hunks = computeHunks(p.p.find, fmt ? plainOf(md) : p.p.replace)
  const state = p.stale ? 'text changed since' : (p.p.state ?? (p.p.refused ? `can’t apply: ${p.p.refused}` : undefined))
  const small = !p.drafted && !fmt && p.p.find.length + p.p.replace.length < 160
  // A formatting change that keeps the words shows only how it will look.
  const words = !fmt || hunks.some((h) => h.kind === 'chg' && h.del.replace(/\s+/g, ' ').trim() !== h.ins.replace(/\s+/g, ' ').trim())
  return (
    <div className={`as-card${state ? ' is-done' : ''}${p.p.beyond && !state ? ' is-beyond' : ''}${p.drafted ? ' is-draft' : ''}`}>
      {fmt && <div className="as-rich" title="How it will look on the page" dangerouslySetInnerHTML={{ __html: preview(md) }} />}
      {words && (
        <div className="as-diff">
          {small && <span className="as-ctx">{around(p.p.before, 'before')}</span>}
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
          {small && <span className="as-ctx">{around(p.p.after, 'after')}</span>}
        </div>
      )}
      {p.p.why && <div className="as-why">{p.p.why}</div>}
      {p.p.beyond && !state && <div className="as-beyond">{p.p.beyond}</div>}
      <div className="as-actions">
        {state ? (
          <span className={`as-state is-${state.replace(/\s/g, '-')}`}>{state}</span>
        ) : p.off ? null : p.showing ? (
          <span className="muted">On the page · Tab, ↵ and ⌫ decide each change</span>
        ) : (
          <>
            {p.p.narrow !== undefined && (
              <button className="btn primary" onClick={() => p.onAccept(true)} title="Make only the change you asked for">
                Accept only what I asked
              </button>
            )}
            <button className={p.p.narrow !== undefined || p.p.beyond ? 'btn' : 'btn primary'} onClick={() => p.onAccept()}>
              {p.p.beyond ? 'Accept as is' : p.drafted ? 'Accept draft' : 'Accept'}
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
