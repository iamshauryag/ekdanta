import type { HistoryItem } from '../editor/controller.ts'
import type { Status } from '../lib/api.ts'
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
        {p.tab === 'material' && <Material />}
        {p.tab === 'history' && <HistoryLog history={p.history} />}
        {p.tab === 'piece' && <Piece {...p} />}
      </div>
    </aside>
  )
}

function Material() {
  return (
    <>
      <div className="panel-head">Material</div>
      <p className="empty">No thinking yet. The Thinking Space (⌘T) arrives in the next version of this MVP.</p>
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
          <dd>{p.platform[0].toUpperCase() + p.platform.slice(1)}</dd>
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
