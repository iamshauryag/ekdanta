import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, type CanvasEdge, type CanvasNode, type Cluster, type ThinkingSide } from '../lib/api.ts'

interface Props {
  doc: string
  title: string
  onClose: () => void
}

type View = 'loose' | 'clusters'
type Point = { x: number; y: number }

const newId = () => Math.random().toString(36).slice(2, 10)
const pair = (a: string, b: string) => [a, b].sort().join('|')
const PAUSE_MS = 2500 // links and Recall chips are looked for after a pause like this

/**
 * The Thinking Space: fragments typed anywhere on a quiet canvas, before or alongside drafting.
 * Fragments are the writer's words at full strength; everything the AI adds is secondary.
 */
export function ThinkingSpace({ doc, title, onClose }: Props) {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<CanvasEdge[]>([])
  const [side, setSide] = useState<ThinkingSide>({})
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [view, setView] = useState<View>('loose')
  const [hideLinks, setHideLinks] = useState(false)
  const [grouping, setGrouping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const clickAt = useRef<Point | null>(null) // where a click into a fragment should put the caret
  const state = useRef({ nodes, edges, side })
  state.current = { nodes, edges, side }

  const texts = nodes.filter((n) => n.type === 'text')
  const frags = texts.filter((n) => n.text?.trim())

  // ---- Loading and saving --------------------------------------------------------------

  useEffect(() => {
    api.thinking(doc).then(({ canvas, side }) => {
      setNodes(canvas.nodes)
      setEdges(canvas.edges)
      setSide(side)
      setLoaded(true)
      // An empty canvas starts with a caret, ready to type.
      if (!canvas.nodes.some((n) => n.type === 'text')) addFragment({ x: 120, y: 96 })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  const save = useCallback(() => {
    const { nodes, edges, side } = state.current
    const kept = nodes.filter((n) => n.type !== 'text' || n.text?.trim())
    const ids = new Set(kept.map((n) => n.id))
    return api.saveThinking(doc, { canvas: { nodes: kept, edges: edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)) }, side })
  }, [doc])

  useEffect(() => {
    if (!loaded) return
    const t = window.setTimeout(save, 600)
    return () => window.clearTimeout(t)
  }, [nodes, edges, side, loaded, save])

  const close = useCallback(async () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    await new Promise((r) => setTimeout(r)) // let the blur commit the fragment being typed
    await save()
    onClose()
  }, [save, onClose])

  // ---- Fragments ------------------------------------------------------------------------

  function addFragment(at: Point) {
    const node: CanvasNode = { id: newId(), type: 'text', text: '', x: Math.round(at.x), y: Math.round(at.y), width: 220, height: 30 }
    setNodes((ns) => [...ns, node])
    setEditing(node.id)
    return node
  }

  const commit = (id: string, el: HTMLElement, opts: { next?: boolean } = {}) => {
    const text = el.innerText.replace(/\n{3,}/g, '\n\n').trim()
    const node = state.current.nodes.find((n) => n.id === id)
    if (!node) return
    if (!text) {
      setNodes((ns) => ns.filter((n) => n.id !== id))
      setEdges((es) => es.filter((e) => e.fromNode !== id && e.toNode !== id))
    } else {
      const size = { width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight) }
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, text, ...size } : n)))
    }
    if (opts.next) addFragment({ x: node.x, y: node.y + (text ? el.offsetHeight : 0) + 22 })
  }

  const remove = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id))
    setEdges((es) => es.filter((e) => e.fromNode !== id && e.toNode !== id))
    setEditing(null)
  }

  /** A press on a fragment: a drag moves it, a click starts editing where you clicked. */
  const onFragDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (editing === node.id || e.button !== 0) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    let moved = false
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - start.x
      const dy = m.clientY - start.y
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, x: Math.max(0, node.x + dx), y: Math.max(0, node.y + dy) } : n)))
    }
    const onUp = (u: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!moved) {
        clickAt.current = { x: u.clientX, y: u.clientY }
        setEditing(node.id)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onCanvasDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('ts-links')) return
    const box = canvasRef.current!.getBoundingClientRect()
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur()
    addFragment({ x: e.clientX - box.left - 2, y: e.clientY - box.top - 14 })
  }

  // ---- Links and Recall chips, after a pause --------------------------------------------

  const sig = frags.map((n) => n.id + ':' + n.text).join('\n')
  useEffect(() => {
    if (!loaded || sig === side.linkedSig || frags.length === 0) return
    const t = window.setTimeout(async () => {
      const current = frags.map((n) => ({ id: n.id, text: n.text! }))
      const known = state.current.side.recall ?? {}
      const fresh = current.filter((f) => known[f.id]?.text !== f.text)
      const skip = [...(state.current.side.dismissed ?? []), ...state.current.edges.map((e) => pair(e.fromNode, e.toNode))]
      try {
        const [{ links }, { chips }] = await Promise.all([
          current.length >= 3 ? api.thinkingLinks(current, skip) : Promise.resolve({ links: [] }),
          fresh.length
            ? api.thinkingRecall(
                doc,
                fresh,
                // Notes already shown on another fragment aren't repeated.
                Object.entries(known).flatMap(([id, r]) => (r.hit && !fresh.some((f) => f.id === id) ? [r.hit.doc] : [])),
              )
            : Promise.resolve({ chips: {} as Record<string, null> }),
        ])
        if (links.length) setEdges((es) => [...es, ...links.map((l) => ({ id: newId(), fromNode: l.from, toNode: l.to, label: l.label }))])
        setSide((s) => ({
          ...s,
          linkedSig: sig,
          recall: { ...s.recall, ...Object.fromEntries(fresh.map((f) => [f.id, { text: f.text, hit: chips[f.id] ?? null }])) },
        }))
      } catch {
        /* no model, or it's busy: the canvas works as a plain board */
      }
    }, PAUSE_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, loaded])

  const dismissLink = (e: CanvasEdge) => {
    setEdges((es) => es.filter((x) => x.id !== e.id))
    setSide((s) => ({ ...s, dismissed: [...(s.dismissed ?? []), pair(e.fromNode, e.toNode)] }))
  }

  // ---- Clusters -------------------------------------------------------------------------

  const group = async () => {
    setGrouping(true)
    setError(null)
    try {
      const { clusters } = await api.thinkingClusters(frags.map((n) => ({ id: n.id, text: n.text! })))
      // Labels the writer renamed survive regrouping when their theme is still there.
      const mine = (side.clusters ?? []).filter((c) => c.mine)
      setSide((s) => ({
        ...s,
        clusters: clusters.map((c) => {
          const kept = mine.find((m) => m.ids.some((id) => c.ids.includes(id)))
          return { id: newId(), label: kept?.label ?? c.label, mine: !!kept, ids: c.ids }
        }),
      }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGrouping(false)
    }
  }

  const rename = (id: string, label: string) =>
    setSide((s) => ({ ...s, clusters: s.clusters?.map((c) => (c.id === id ? { ...c, label, mine: true } : c)) }))

  // ---- Keys -----------------------------------------------------------------------------

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'KeyT' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if (e.key === 'Alt') setHideLinks(true)
      else if (e.key === 'Escape' && !editing) close()
    }
    const up = (e: KeyboardEvent) => e.key === 'Alt' && setHideLinks(false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', () => setHideLinks(false))
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up)
    }
  }, [close, editing])

  const byId = new Map(texts.map((n) => [n.id, n]))
  const extent = texts.reduce((m, n) => ({ w: Math.max(m.w, n.x + n.width + 320), h: Math.max(m.h, n.y + n.height + 240) }), { w: 0, h: 0 })
  const shown = edges.filter((e) => byId.get(e.fromNode)?.text && byId.get(e.toNode)?.text)
  const clustered = new Set((side.clusters ?? []).flatMap((c) => c.ids))
  const unclustered = frags.filter((n) => !clustered.has(n.id))

  return (
    <div className="ts" role="dialog" aria-label="Thinking Space">
      <header className="ts-head">
        <span className="ts-title">
          <b>Thinking</b> · {title || 'Untitled'}
        </span>
        <div className="seg seg-text ts-views" role="radiogroup" aria-label="View">
          {(['loose', 'clusters'] as View[]).map((v) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'is-on' : ''} onClick={() => setView(v)}>
              {v === 'loose' ? 'Loose' : 'Clusters'}
            </button>
          ))}
        </div>
        <span />
      </header>

      {view === 'loose' ? (
        <div className="ts-scroll">
          <div
            className={`ts-canvas${hideLinks ? ' hide-links' : ''}`}
            ref={canvasRef}
            onPointerDown={onCanvasDown}
            style={{ minWidth: extent.w || undefined, minHeight: extent.h || undefined }}
          >
            <svg className="ts-links" width="100%" height="100%" aria-hidden="true">
              {shown.map((e) => {
                const g = geometry(byId.get(e.fromNode)!, byId.get(e.toNode)!, texts)
                return <path key={e.id} d={g.d} />
              })}
            </svg>
            {shown.map((e) => {
              const g = geometry(byId.get(e.fromNode)!, byId.get(e.toNode)!, texts)
              return (
                <button key={e.id} className={`ts-link-label${g.side ? ' is-side' : ''}`} style={{ left: g.mid.x, top: g.mid.y }} title="Not related? Click to remove" onClick={() => dismissLink(e)}>
                  {e.label}
                </button>
              )
            })}
            {texts.map((n) => (
              <Fragment
                key={n.id}
                node={n}
                editing={editing === n.id}
                chip={side.recall?.[n.id]?.text === n.text ? side.recall?.[n.id]?.hit ?? null : null}
                clickAt={clickAt}
                onDown={onFragDown}
                onCommit={commit}
                onRemove={remove}
                onDone={() => setEditing((cur) => (cur === n.id ? null : cur))}
              />
            ))}
            {frags.length === 0 && <p className="ts-hint">Type anything. Return starts a new fragment; click anywhere to put one there.</p>}
          </div>
        </div>
      ) : (
        <div className="ts-scroll">
          <div className="ts-clusters">
            {!side.clusters?.length ? (
              <div className="ts-empty">
                <p>Gather your fragments into a few themes. Nothing is moved or rewritten.</p>
                <button className="btn" disabled={grouping || frags.length < 2} onClick={group}>
                  {grouping ? 'Grouping…' : 'Group fragments'}
                </button>
                {error && <p className="voice-error">{error}</p>}
              </div>
            ) : (
              <>
                <div className="ts-regions">
                  {side.clusters.map((c) => (
                    <Region key={c.id} cluster={c} frags={c.ids.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n?.text)} onRename={rename} />
                  ))}
                </div>
                {unclustered.length > 0 && <Region cluster={{ id: '', label: 'unclustered', ids: [] }} frags={unclustered} />}
              </>
            )}
          </div>
        </div>
      )}

      <footer className="ts-foot">
        <span className="muted">
          {frags.length} fragment{frags.length === 1 ? '' : 's'}
          {view === 'loose' && shown.length > 0 && (
            <>
              {' '}
              · {shown.length} link{shown.length === 1 ? '' : 's'} suggested · hold <kbd>⌥</kbd> to hide them
            </>
          )}
          {view === 'clusters' && !!side.clusters?.length && (
            <>
              {' '}
              · {side.clusters.length} clusters · {unclustered.length} unclustered ·{' '}
              <button className="link" disabled={grouping} onClick={group}>
                {grouping ? 'grouping…' : 'regroup'}
              </button>
            </>
          )}
        </span>
        <button className="btn primary" onClick={close}>
          Start drafting → <kbd>⌥T</kbd>
        </button>
      </footer>
    </div>
  )
}

interface FragmentProps {
  node: CanvasNode
  editing: boolean
  chip: { doc: string; title: string; folder: string } | null
  clickAt: React.MutableRefObject<Point | null>
  onDown: (e: React.PointerEvent, n: CanvasNode) => void
  onCommit: (id: string, el: HTMLElement, opts?: { next?: boolean }) => void
  onRemove: (id: string) => void
  onDone: () => void
}

function Fragment({ node, editing, chip, clickAt, onDown, onCommit, onRemove, onDone }: FragmentProps) {
  const ref = useRef<HTMLDivElement>(null)
  // The text lives in the DOM while it's being typed; React only sets it when it isn't.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !editing && el.innerText !== (node.text ?? '')) el.innerText = node.text ?? ''
  }, [node.text, editing])
  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    el.focus()
    const at = clickAt.current
    clickAt.current = null
    const range = at ? caretRangeAt(at) : null
    const sel = getSelection()
    if (range && el.contains(range.startContainer)) {
      sel?.removeAllRanges()
      sel?.addRange(range)
    } else {
      sel?.selectAllChildren(el)
      sel?.collapseToEnd()
    }
  }, [editing, clickAt])

  return (
    <div className="ts-frag-wrap" style={{ left: node.x, top: node.y }}>
      <div
        ref={ref}
        className={`ts-frag${editing ? ' is-editing' : ''}`}
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={editing}
        onPointerDown={(e) => onDown(e, node)}
        onKeyDown={(e) => {
          const el = e.currentTarget
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onCommit(node.id, el, { next: true })
          } else if (e.key === 'Escape') {
            e.preventDefault()
            el.blur()
          } else if (e.key === 'Backspace' && !el.innerText.trim()) {
            e.preventDefault()
            onRemove(node.id)
          }
        }}
        onBlur={(e) => {
          onCommit(node.id, e.currentTarget)
          onDone()
        }}
      />
      {chip && !editing && (
        <span className="ts-chip" title={`From your notes: ${chip.folder ? chip.folder + ' / ' : ''}${chip.title}`}>
          ↳ {chip.folder ? folderName(chip.folder) + ' / ' : ''}
          {chip.title}
        </span>
      )}
    </div>
  )
}

function Region({ cluster, frags, onRename }: { cluster: Cluster; frags: CanvasNode[]; onRename?: (id: string, label: string) => void }) {
  return (
    <section className={`ts-region${onRename ? '' : ' is-loose'}`}>
      <h4
        className={cluster.mine ? 'mine' : ''}
        contentEditable={onRename ? 'plaintext-only' : false}
        suppressContentEditableWarning
        title={onRename ? 'Click to rename' : undefined}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        onBlur={(e) => {
          // textContent, not innerText: the label is shown in capitals, but that's only styling.
          const label = (e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (label && label !== cluster.label) onRename?.(cluster.id, label)
          else e.currentTarget.textContent = cluster.label
        }}
      >
        {cluster.label}
      </h4>
      <div className="ts-region-frags">
        {frags.map((n) => (
          <p key={n.id}>{n.text}</p>
        ))}
      </div>
    </section>
  )
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * A soft curve between two fragments, from edge to edge, and a spot for its label that
 * doesn't sit on anyone's words.
 */
function geometry(a: CanvasNode, b: CanvasNode, all: Rect[]) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const others = all.filter((r) => r !== a && r !== b)
  // Fragments in the same column (typed one under another, say): a curve between them would
  // run through the text, so it bows out to the right like a bracket, with its label beside it.
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  if (overlapX > 0) {
    const x = Math.max(a.x + a.width, b.x + b.width, ...others.filter((r) => between(r, a, b)).map((r) => r.x + r.width)) + 10
    const bulge = 26 + Math.min(30, Math.abs(cb.y - ca.y) / 6)
    const my = (ca.y + cb.y) / 2
    return { d: `M${x},${ca.y} Q${x + bulge * 2},${my} ${x},${cb.y}`, mid: { x: x + bulge + 4, y: my }, side: true }
  }
  const p0 = exitPoint(a, cb, 8)
  const p1 = exitPoint(b, ca, 8)
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1
  const bend = Math.min(40, len * 0.18)
  const c = { x: (p0.x + p1.x) / 2 - (dy / len) * bend, y: (p0.y + p1.y) / 2 + (dx / len) * bend }
  const at = (t: number) => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t ** 2 * p1.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t ** 2 * p1.y,
  })
  const clear = (p: { x: number; y: number }) => !others.some((r) => p.x > r.x - 36 && p.x < r.x + r.width + 36 && p.y > r.y - 10 && p.y < r.y + r.height + 10)
  const mid = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74].map(at).find(clear) ?? at(0.5)
  return { d: `M${p0.x},${p0.y} Q${c.x},${c.y} ${p1.x},${p1.y}`, mid, side: false }
}

/** Does r sit vertically between a and b, in roughly the same column? */
function between(r: Rect, a: Rect, b: Rect) {
  const top = Math.min(a.y, b.y)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return r.y >= top && r.y + r.height <= bottom && r.x < Math.max(a.x + a.width, b.x + b.width) && r.x + r.width > Math.min(a.x, b.x)
}

/** Where the line from a box's centre toward `to` leaves the box, plus a small gap. */
function exitPoint(n: CanvasNode, to: Point, gap: number) {
  const cx = n.x + n.width / 2
  const cy = n.y + n.height / 2
  const dx = to.x - cx
  const dy = to.y - cy
  const sx = dx ? (n.width / 2 + gap) / Math.abs(dx) : Infinity
  const sy = dy ? (n.height / 2 + gap) / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy, 1)
  return { x: Math.round(cx + dx * s), y: Math.round(cy + dy * s) }
}

function caretRangeAt(p: Point): Range | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(p.x, p.y)
    if (!pos) return null
    const r = document.createRange()
    r.setStart(pos.offsetNode, pos.offset)
    return r
  }
  return doc.caretRangeFromPoint?.(p.x, p.y) ?? null
}

const folderName = (f: string) => {
  const last = f.split('/').pop()!
  return last[0].toUpperCase() + last.slice(1)
}
