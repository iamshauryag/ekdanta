import type { HistoryItem } from '../editor/controller.ts'
import { useEffect, useState } from 'react'
import type { Status, Thinking, VoiceSummary } from '../lib/api.ts'
import { Icon } from './Icon.tsx'
import { helpMod } from '../editor/help.ts'

export type PanelTab = 'material' | 'history' | 'piece'

const TYPICAL: Record<string, number> = { essay: 1200, linkedin: 200, email: 150, text: 40, blog: 900 }
const LEVEL: Record<number, string> = { 1: 'Recall', 2: 'Nudge', 3: 'Word', 4: 'Sentence', 5: 'Passage' }

interface Props {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  onClose: () => void
  history: HistoryItem[]
  words: number
  platform: string
  ceiling: number
  onCeiling: (n: number) => void
  recallDot: boolean
  onRecallDot: (b: boolean) => void
  status: Status | null
  path: string | null
  exemplar: boolean
  onExemplar: () => void
  voice: VoiceSummary | undefined
  onVoice: () => void
  thinking: Thinking | null
  covered: string[]
  nearest: string | null
  onThinking: () => void
  onClearHistory: () => void
}

export function Panel(p: Props) {
  const tabs: { id: PanelTab; icon: string; key: string; label: string }[] = [
    { id: 'material', icon: 'material', key: '⌘⌥1', label: 'Material' },
    { id: 'history', icon: 'history', key: '⌘⌥2', label: 'History' },
    { id: 'piece', icon: 'piece', key: '⌘⌥3', label: 'Piece' },
  ]
  return (
    <aside className="panel" aria-label="Right panel">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} title={t.label} className={`panel-tab${p.tab === t.id ? ' is-on' : ''}`} onClick={() => p.onTab(t.id)}>
            <Icon name={t.icon} />
            <span>{t.key}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="panel-tab" title="Hide panel (⌘\)" onClick={p.onClose}>
          <Icon name="panel" />
          <span>⌘\</span>
        </button>
      </div>
      <div className="panel-body">
        {p.tab === 'material' && <Material thinking={p.thinking} covered={p.covered} nearest={p.nearest} onOpen={p.onThinking} />}
        {p.tab === 'history' && <HistoryLog history={p.history} />}
        {p.tab === 'piece' && <Piece {...p} />}
      </div>
    </aside>
  )
}

/** This piece's Thinking Space fragments, grouped by cluster, with the ones the draft covers ticked. */
function Material({ thinking, covered, nearest, onOpen }: { thinking: Thinking | null; covered: string[]; nearest: string | null; onOpen: () => void }) {
  const frags = (thinking?.canvas.nodes ?? []).filter((n) => n.type === 'text' && n.text?.trim())
  const byId = new Map(frags.map((n) => [n.id, n]))
  const clusters = (thinking?.side.clusters ?? []).map((c) => ({ ...c, ids: c.ids.filter((id) => byId.has(id)) })).filter((c) => c.ids.length)
  const inCluster = new Set(clusters.flatMap((c) => c.ids))
  const rest = frags.filter((n) => !inCluster.has(n.id)).map((n) => n.id)
  const groups = [...clusters, ...(rest.length ? [{ id: '_rest', label: clusters.length ? 'unclustered' : 'fragments', ids: rest, mine: false }] : [])]
  // Only the group for the paragraph being written is open; the others fold to one line.
  const focusGroup = groups.find((g) => nearest && g.ids.includes(nearest))?.id ?? groups.find((g) => g.ids.some((id) => !covered.includes(id)))?.id
  const [open, setOpen] = useState<string | undefined>(focusGroup)
  useEffect(() => setOpen(focusGroup), [focusGroup])
  const used = frags.filter((n) => covered.includes(n.id)).length

  return (
    <>
      <div className="panel-head">
        Thinking <em>· {frags.length} fragments</em>
        {frags.length > 0 && <span className="count">{used} used</span>}
      </div>
      {!frags.length && <p className="empty">No thinking yet. ⌥T opens the Thinking Space for this piece.</p>}
      {groups.map((g) => {
        const isOpen = open === g.id
        return (
          <div key={g.id} className={`mat-group${isOpen ? ' is-open' : ''}`}>
            <button className="mat-head" onClick={() => setOpen(isOpen ? undefined : g.id)} aria-expanded={isOpen}>
              <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.5 4.75 6 7.25l2.5-2.5" />
              </svg>
              <span className={g.mine ? 'mine' : 'label'}>{g.label}</span>
              <span className="muted">
                {g.ids.filter((id) => covered.includes(id)).length}/{g.ids.length}
              </span>
              {g.id === focusGroup && nearest && g.ids.includes(nearest) && <span className="here">this paragraph</span>}
            </button>
            {isOpen &&
              g.ids.map((id) => {
                const n = byId.get(id)!
                const done = covered.includes(id)
                return (
                  <div
                    key={id}
                    className={`mat-frag${done ? ' is-done' : ''}${id === nearest ? ' is-near' : ''}`}
                    draggable
                    title="Drag into the page to use it"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', n.text!.trim())
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <span className="tick" aria-label={done ? 'In the draft' : 'Not used yet'} />
                    {n.text}
                  </div>
                )
              })}
          </div>
        )
      })}
      <button className="btn mat-open" onClick={onOpen}>
        Open Thinking Space <kbd>⌥T</kbd>
      </button>
    </>
  )
}

function HistoryLog({ history }: { history: HistoryItem[] }) {
  const items = [...history].reverse()
  return (
    <>
      <div className="panel-head">
        History <em>· this document</em>
        <span className="count">{history.length} items</span>
      </div>
      {!items.length && <p className="empty">Nothing yet. Press 1–5 with ⌘ (or ⌥) while writing; every request and what you did with it shows up here.</p>}
      {items.map((h, i) => (
        <div key={i} className="help-item">
          <div className="help-item-head">
            <span className="level">
              {helpMod}
              {h.level} · {LEVEL[h.level]}
            </span>
            <span className="muted">{new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          {h.instruction && <p className="instr">“{h.instruction}”</p>}
          {h.detail && <p className={h.level === 2 ? 'nudge-text' : 'detail'}>{h.detail}</p>}
          {h.sources && (
            <div className="chips">
              {h.sources.map((s, k) => (
                <span key={k} className="chip">
                  ↳ {s.folder ? s.folder + ' / ' : ''}
                  {s.title}
                </span>
              ))}
            </div>
          )}
          <div className={`outcome is-${h.outcome.replace(/\s/g, '-')}`}>{h.outcome}</div>
        </div>
      ))}
    </>
  )
}

function Piece(p: Props) {
  const typical = TYPICAL[p.platform] ?? 1000
  const s = p.status
  return (
    <>
      <div className="panel-head">
        Piece <em>· facts</em>
      </div>
      <dl className="facts">
        <div>
          <dt>Platform</dt>
          <dd>{p.platform === 'linkedin' ? 'LinkedIn' : p.platform[0].toUpperCase() + p.platform.slice(1)}</dd>
        </div>
        <div className="col">
          <dt>Length</dt>
          <dd>
            <b>{p.words.toLocaleString()}</b> <span className="muted">/ ~{typical.toLocaleString()} typical</span>
          </dd>
          <div className="bar">
            <i style={{ width: `${Math.min(100, (p.words / typical) * 100)}%` }} />
          </div>
        </div>
        <div className="col">
          <dt>Help ceiling</dt>
          <dd>
            <div className="seg" role="radiogroup" aria-label="Help ceiling">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <button key={n} role="radio" aria-checked={p.ceiling === n} className={p.ceiling === n ? 'is-on' : ''} onClick={() => p.onCeiling(n)}>
                  {n}
                </button>
              ))}
            </div>
          </dd>
        </div>
        <div>
          <dt>Recall dot</dt>
          <dd>
            <label className="toggle">
              <input type="checkbox" checked={p.recallDot} onChange={(e) => p.onRecallDot(e.target.checked)} /> Show when Recall has something
            </label>
          </dd>
        </div>
        {p.voice && (
          <div>
            <dt>Voice</dt>
            <dd>
              <button className="link" onClick={p.onVoice}>
                {!p.voice.exists ? 'Not built yet' : p.voice.upToDate ? 'Up to date' : 'Out of date'} · view
              </button>
            </dd>
          </div>
        )}
        <div>
          <dt>Exemplar</dt>
          <dd>
            <button className={`star-toggle${p.exemplar ? ' is-on' : ''}`} onClick={p.onExemplar} title={`${p.exemplar ? 'Un-star' : 'Star'} (⌥⇧8)`}>
              <Icon name="star" />
              {p.exemplar ? 'Sounds like you' : 'Mark as sounding like you'}
            </button>
          </dd>
        </div>
        <div className="col">
          <dt>File</dt>
          <dd className="path">{p.path}</dd>
        </div>
      </dl>
      <div className="panel-head" style={{ marginTop: 22 }}>
        Models
      </div>
      {s ? (
        <dl className="facts">
          <div>
            <dt>{helpMod}1 Recall</dt>
            <dd>{s.embedder.startsWith('builtin') ? 'Built in · bge-small' : `Ollama · ${s.models.embed}`}</dd>
          </div>
          <div>
            <dt>{helpMod}3 Word</dt>
            <dd>{providerName(s.fast, s, true)}</dd>
          </div>
          <div>
            <dt>{`${helpMod}2 ${helpMod}4 ${helpMod}5`}</dt>
            <dd>{providerName(s.strong, s)}</dd>
          </div>
          <div className="col">
            <dt>Vault</dt>
            <dd className="path">{s.vault}</dd>
          </div>
        </dl>
      ) : (
        <p className="empty">Checking…</p>
      )}
    </>
  )
}

function providerName(p: string | null, s: Status, fast = false) {
  if (p === 'claude-cli') return `Claude CLI · ${fast ? s.models.claudeFast : s.models.claude}`
  if (p === 'anthropic-api') return 'Anthropic API'
  if (p === 'ollama') return `Local · ${s.models.ollama}`
  return 'None available'
}
