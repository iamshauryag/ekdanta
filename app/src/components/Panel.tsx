import type { HistoryItem } from '../editor/controller.ts'
import { findKind, kindName, kinds } from '../lib/kinds.ts'
import { useEffect, useState } from 'react'
import type { Status, Thinking, VoiceSummary } from '../lib/api.ts'
import type { Heading } from '../editor/Editor.tsx'
import { Icon } from './Icon.tsx'
import { binding, formatKey, titled } from '../lib/keys.ts'
import { helpMod } from '../editor/help.ts'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { OutlineList } from './OutlineList.tsx'
import type { VersionRow } from '../lib/versions.ts'
import { VersionsList } from './VersionsList.tsx'
import { BriefCard } from './BriefCard.tsx'
import { EDGE_LIMITS, EDGE_NAMES, showSuggestLink, type EdgeSlot } from '../lib/edge.ts'
import { ReaderList, type Reading } from './ReaderList.tsx'
import { AssistantTab } from './AssistantTab.tsx'

export type PanelTab = 'material' | 'outline' | 'history' | 'piece' | 'assistant'
/** The History tab's two halves: the document's versions, and the log of help asked for. */
export type HistorySeg = 'versions' | 'help'

/** What the Versions list needs from the app. */
export interface VersionsProps {
  tick: number
  ask: number
  open: string | null
  onSave: (name: string) => Promise<void>
  onOpen: (row: VersionRow) => void
}

/** What the Material tab can do to the Thinking Space without opening it. */
export interface Thoughts {
  add: (text: string) => void
  edit: (id: string, text: string) => void
  remove: (id: string) => void
  check: (id: string, done: boolean) => void
  cluster: () => Promise<void>
  ungroup: () => void
  renameGroup: (id: string, label: string) => void
}

const LEVEL: Record<number, string> = { 1: 'Recall', 2: 'Nudge', 3: 'Word', 4: 'Sentence', 5: 'Passage', 6: 'Whole draft, written by AI' }

interface Props {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  onClose: () => void
  history: HistoryItem[]
  words: number
  platform: string
  ceiling: number
  onCeiling: (n: number) => void
  /** An email's subject or a blog post's excerpt, with 'Suggest from my draft' beside it. */
  field: { slot: EdgeSlot; key: string; value: string; canSuggest: boolean; onChange: (v: string) => void } | null
  recallDot: boolean
  onRecallDot: (b: boolean) => void
  status: Status | null
  path: string | null
  exemplar: boolean
  /** Notes in the Brain can't be starred: they hold other people's words. */
  canStar?: boolean
  /** For a note in the Brain, what kind of source it is ("Book"): it has no kind, length or brief of its own. */
  source?: string
  onExemplar: () => void
  voice: VoiceSummary | undefined
  onVoice: () => void
  thinking: Thinking | null
  covered: string[]
  nearest: string | null
  onThinking: () => void
  outline: Heading[]
  onHeading: (h: Heading) => void
  /** The page: for moving sections from the Outline, and for Read as… to read (null while the Markdown source shows). */
  editor: TiptapEditor | null
  onBeforeMove: () => void
  notify: (text: string, undo?: () => void) => void
  thoughts: Thoughts
  onOpenDoc: (path: string) => void
  onClearHistory: () => void
  historySeg: HistorySeg
  onHistorySeg: (s: HistorySeg) => void
  versions: VersionsProps
  /** The pinned brief ('' for none), and the paste box for it. */
  brief: string
  briefEditing: boolean
  onBriefEditing: (on: boolean) => void
  onBriefSave: (text: string) => Promise<void>
  onBriefUnpin: () => void
  /** Read as…: whether its card is open, and the latest list (session only). */
  readerOpen: boolean
  onReaderOpen: (open: boolean) => void
  readerFocus: number
  reading: Reading | null
  onReading: (r: Reading | null) => void
}

export function Panel(p: Props) {
  const tabs: { id: PanelTab; icon: string; key: string; label: string }[] = [
    { id: 'material', icon: 'material', key: formatKey(binding('material')), label: 'Material' },
    { id: 'outline', icon: 'outline', key: formatKey(binding('outline')), label: 'Outline' },
    { id: 'history', icon: 'history', key: formatKey(binding('history')), label: 'History' },
    { id: 'piece', icon: 'piece', key: formatKey(binding('piece')), label: 'Piece' },
    { id: 'assistant', icon: 'assistant', key: formatKey(binding('assistant')), label: 'Assistant' },
  ]
  return (
    <aside className="panel" aria-label="Right panel">
      <div className="panel-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} title={`${t.label}  ${t.key}`} className={`panel-tab${p.tab === t.id ? ' is-on' : ''}`} onClick={() => p.onTab(t.id)}>
            <Icon name={t.icon} />
            <span>{t.key}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="panel-tab" title={titled('Hide panel', 'panel')} onClick={p.onClose}>
          <Icon name="panel" />
          <span>{formatKey(binding('panel'))}</span>
        </button>
      </div>
      <div className="panel-body">
        {p.tab === 'material' && <Material thinking={p.thinking} covered={p.covered} nearest={p.nearest} onOpen={p.onThinking} thoughts={p.thoughts} onOpenDoc={p.onOpenDoc} />}
        {p.tab === 'outline' && <OutlineList editor={p.editor} outline={p.outline} onHeading={p.onHeading} onBeforeMove={p.onBeforeMove} notify={p.notify} />}
        {p.tab === 'history' && (
          <>
            <div className="seg seg-text vh-seg" role="tablist" aria-label="History">
              {(
                [
                  ['versions', 'Versions'],
                  ['help', 'Help log'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={p.historySeg === id} className={p.historySeg === id ? 'is-on' : ''} onClick={() => p.onHistorySeg(id)}>
                  {label}
                </button>
              ))}
            </div>
            {p.historySeg === 'versions' ? <VersionsList doc={p.path} {...p.versions} /> : <HistoryLog key={p.path ?? ''} history={p.history} onClear={p.onClearHistory} />}
          </>
        )}
        {p.tab === 'piece' && <Piece {...p} />}
        {/* Kept mounted while another tab shows, so an answer being written isn't lost by looking elsewhere. */}
        <div className="as-host" hidden={p.tab !== 'assistant'}>
          <AssistantTab
            key={p.path ?? ''}
            active={p.tab === 'assistant'}
            editor={p.editor}
            doc={p.source ? null : p.path}
            platform={p.platform}
            ceiling={p.ceiling}
            status={p.status}
            onOpenDoc={p.onOpenDoc}
            onPiece={() => p.onTab('piece')}
            onVoice={p.onVoice}
            notify={p.notify}
          />
        </div>
      </div>
    </aside>
  )
}

/** This piece's Thinking Space fragments, grouped by cluster, with the ones the draft covers ticked. */
function Material({
  thinking,
  covered: auto,
  nearest,
  onOpen,
  thoughts,
  onOpenDoc,
}: {
  thinking: Thinking | null
  covered: string[]
  nearest: string | null
  onOpen: () => void
  thoughts: Thoughts
  onOpenDoc: (path: string) => void
}) {
  const [thought, setThought] = useState('')
  const [editing, setEditing] = useState<string | null>(null) // a fragment or a group label
  const [grouping, setGrouping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const frags = (thinking?.canvas.nodes ?? []).filter((n) => n.type === 'text' && n.text?.trim())
  const byId = new Map(frags.map((n) => [n.id, n]))
  // What the draft covers, as the writer has corrected it.
  const checked = thinking?.side.checked ?? {}
  const covered = frags.filter((n) => checked[n.id] ?? auto.includes(n.id)).map((n) => n.id)
  const recall = thinking?.side.recall ?? {}
  const clusters = (thinking?.side.clusters ?? []).map((c) => ({ ...c, ids: c.ids.filter((id) => byId.has(id)) })).filter((c) => c.ids.length)
  const inCluster = new Set(clusters.flatMap((c) => c.ids))
  const rest = frags.filter((n) => !inCluster.has(n.id)).map((n) => n.id)
  const groups = [...clusters, ...(rest.length ? [{ id: '_rest', label: clusters.length ? 'unclustered' : 'fragments', ids: rest, mine: false }] : [])]
  // Only the group for the paragraph being written is open; the others fold to one line.
  const focusGroup = groups.find((g) => nearest && g.ids.includes(nearest))?.id ?? groups.find((g) => g.ids.some((id) => !covered.includes(id)))?.id
  const [open, setOpen] = useState<string | undefined>(focusGroup)
  useEffect(() => {
    if (focusGroup) setOpen(focusGroup) // ticking off a group's last fragment leaves it open
  }, [focusGroup])
  // A new thought lands in the open list, so it can be seen going in.
  const addTo = clusters.length ? '_rest' : groups[0]?.id

  const cluster = async () => {
    setGrouping(true)
    setError(null)
    try {
      await thoughts.cluster()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGrouping(false)
    }
  }

  return (
    <>
      <div className="panel-head">
        Thinking <em>· {frags.length} fragments</em>
        {frags.length > 0 && <span className="count">{covered.length} used</span>}
      </div>
      {frags.length >= 3 && (
        <div className="mat-tools">
          <button className="link" disabled={grouping} onClick={cluster} title="Group the fragments into themes. Nothing is rewritten.">
            {grouping ? 'Grouping…' : clusters.length ? 'Regroup' : 'Group into themes'}
          </button>
          {clusters.length > 0 && !grouping && (
            <button className="link muted" onClick={thoughts.ungroup}>
              Ungroup
            </button>
          )}
          {error && <span className="voice-error">{error}</span>}
        </div>
      )}
      {!frags.length && <p className="empty">No thinking yet. Jot a thought below, or open the Thinking Space{binding('thinking') ? ` (${formatKey(binding('thinking'))})` : ''} to lay them out.</p>}
      {groups.map((g) => {
        const isOpen = open === g.id
        return (
          <div key={g.id} className={`mat-group${isOpen ? ' is-open' : ''}`}>
            <div className="mat-head">
              <button className="mat-toggle" onClick={() => setOpen(isOpen ? undefined : g.id)} aria-expanded={isOpen}>
                <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3.5 4.75 6 7.25l2.5-2.5" />
                </svg>
              </button>
              {editing === g.id ? (
                <input
                  className="mat-edit label-edit"
                  defaultValue={g.label}
                  autoFocus
                  aria-label="Theme name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    else if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={(e) => {
                    setEditing(null)
                    if (e.target.value.trim() && e.target.value.trim() !== g.label) thoughts.renameGroup(g.id, e.target.value.trim())
                  }}
                />
              ) : (
                <span
                  className={g.mine ? 'mine' : 'label'}
                  title={g.id === '_rest' ? undefined : 'Double-click to rename'}
                  onClick={() => setOpen(isOpen ? undefined : g.id)}
                  onDoubleClick={() => g.id !== '_rest' && setEditing(g.id)}
                >
                  {g.label}
                </span>
              )}
              <span className="muted">
                {g.ids.filter((id) => covered.includes(id)).length}/{g.ids.length}
              </span>
              {g.id === focusGroup && nearest && g.ids.includes(nearest) && <span className="here">this paragraph</span>}
            </div>
            {isOpen &&
              g.ids.map((id) => {
                const n = byId.get(id)!
                const done = covered.includes(id)
                const hit = recall[id]?.text === n.text ? recall[id]?.hit : null
                return (
                  <div
                    key={id}
                    className={`mat-frag${done ? ' is-done' : ''}${id === nearest ? ' is-near' : ''}`}
                    draggable={editing !== id}
                    title={editing === id ? undefined : 'Drag into the page to use it · double-click to edit'}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', n.text!.trim())
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <button
                      className="tick"
                      role="checkbox"
                      aria-checked={done}
                      aria-label={done ? 'Used in the draft' : 'Not used yet'}
                      title={done ? 'Mark as not used yet' : 'Mark as used'}
                      onClick={() => thoughts.check(id, !done)}
                    />
                    <div className="mat-text">
                      {editing === id ? (
                        <textarea
                          className="mat-edit"
                          defaultValue={n.text}
                          autoFocus
                          rows={Math.max(1, Math.ceil(n.text!.length / 34))}
                          aria-label="Edit thought"
                          onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              e.currentTarget.blur()
                            } else if (e.key === 'Escape') setEditing(null)
                          }}
                          onBlur={(e) => {
                            setEditing(null)
                            if (e.target.value.trim() !== n.text!.trim()) thoughts.edit(id, e.target.value.trim())
                          }}
                        />
                      ) : (
                        <span onDoubleClick={() => setEditing(id)}>{n.text}</span>
                      )}
                      {hit && editing !== id && (
                        <button className="mat-recall" title="One of your notes on this. Click to open it." onClick={() => onOpenDoc(hit.doc)}>
                          ↳ {hit.title}
                        </button>
                      )}
                    </div>
                    {editing !== id && (
                      <span className="mat-actions">
                        <button title="Edit" aria-label="Edit thought" onClick={() => setEditing(id)}>
                          ✎
                        </button>
                        <button title="Remove" aria-label="Remove thought" onClick={() => thoughts.remove(id)}>
                          ×
                        </button>
                      </span>
                    )}
                  </div>
                )
              })}
          </div>
        )
      })}
      <form
        className="mat-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (!thought.trim()) return
          thoughts.add(thought.trim())
          setThought('')
          if (addTo) setOpen(addTo)
        }}
      >
        <input value={thought} onChange={(e) => setThought(e.target.value)} placeholder="Add a thought…" aria-label="Add a thought" />
      </form>
      <button className="btn mat-open" onClick={onOpen}>
        Open Thinking Space {binding('thinking') && <kbd>{formatKey(binding('thinking'))}</kbd>}
      </button>
    </>
  )
}

function HistoryLog({ history, onClear }: { history: HistoryItem[]; onClear: () => void }) {
  const items = [...history].reverse()
  const [asking, setAsking] = useState(false)
  return (
    <>
      <div className="panel-head">
        Help log <em>· this document</em>
        <span className="count">{history.length} items</span>
      </div>
      {!items.length && <p className="empty">Nothing yet. Press 1–5 with ⌘ (or ⌥) while writing; every request and what you did with it shows up here.</p>}
      {items.map((h, i) => (
        <div key={i} className="help-item">
          <div className="help-item-head">
            <span className="level">
              {h.level <= 5 ? helpMod : ''}
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
      {items.length > 0 && (
        <p className="history-clear">
          {asking ? (
            <>
              Clear this document’s help log? It can’t be undone.{' '}
              <button
                className="link-btn is-danger"
                onClick={() => {
                  setAsking(false)
                  onClear()
                }}
              >
                Clear
              </button>{' '}
              ·{' '}
              <button className="link-btn" onClick={() => setAsking(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="link-btn" onClick={() => setAsking(true)}>
              Clear help log
            </button>
          )}
        </p>
      )}
    </>
  )
}

/** Subject or Excerpt: the writer's own text field, with suggestions drawn from the draft when help allows level 3. */
function EdgeField({ field, suggest }: { field: NonNullable<Props['field']>; suggest: boolean }) {
  const [draft, setDraft] = useState(field.value)
  useEffect(() => setDraft(field.value), [field.value])
  const commit = () => {
    const v = draft.replace(/\s+/g, ' ').trim()
    if (v !== field.value) field.onChange(v)
  }
  const name = EDGE_NAMES[field.slot]
  const over = draft.length > EDGE_LIMITS[field.slot]
  return (
    <div className="col edge-field">
      <dt>
        <span>{name}</span>
        {suggest && (
          <button className="link edge-suggest" onClick={() => window.dispatchEvent(new CustomEvent('ekdanta:edge', { detail: { slot: field.slot } }))}>
            Suggest from my draft
          </button>
        )}
      </dt>
      <dd>
        <textarea
          className="edge-input"
          aria-label={name}
          rows={field.slot === 'excerpt' ? 3 : 1}
          value={draft}
          placeholder={field.slot === 'subject' ? 'No subject yet' : 'No excerpt yet'}
          onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(field.value)
            }
          }}
        />
        {over && (
          <span className="muted edge-count">
            {draft.length} characters · often cut off after {EDGE_LIMITS[field.slot]}
          </span>
        )}
      </dd>
    </div>
  )
}

function Piece(p: Props) {
  const typical = findKind(kinds(), p.platform)?.words ?? 1000
  const s = p.status
  return (
    <>
      {!p.source && <BriefCard key={p.path ?? ''} text={p.brief} platform={p.platform} editing={p.briefEditing} onEditing={p.onBriefEditing} onSave={p.onBriefSave} onUnpin={p.onBriefUnpin} />}
      {/* Read as… is level-2 help (questions only), so it goes with the help ceiling. */}
      {p.ceiling >= 2 && p.path && !p.source && (
        <ReaderList editor={p.editor} doc={p.path} platform={p.platform} open={p.readerOpen} onOpen={p.onReaderOpen} focusTick={p.readerFocus} reading={p.reading} onReading={p.onReading} />
      )}
      <div className="panel-head">
        {p.source ? 'Source' : 'Piece'} <em>· facts</em>
      </div>
      <dl className="facts">
        {p.source ? (
          <div>
            <dt>Kind</dt>
            <dd>{p.source} in the Brain</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Kind</dt>
              <dd>{kindName(kinds(), p.platform)}</dd>
            </div>
            {p.field && <EdgeField field={p.field} suggest={p.field.canSuggest && showSuggestLink(p.ceiling)} />}
            <div className="col">
              <dt>Length</dt>
              <dd>
                <b>{p.words.toLocaleString()}</b> <span className="muted">/ ~{typical.toLocaleString()} typical</span>
              </dd>
              <div className="bar">
                <i style={{ width: `${Math.min(100, (p.words / typical) * 100)}%` }} />
              </div>
            </div>
          </>
        )}
        <div className="col">
          <dt>Help ceiling</dt>
          <dd>
            <div className="seg" role="radiogroup" aria-label="Help ceiling">
              {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={p.ceiling === n}
                  className={p.ceiling === n ? 'is-on' : ''}
                  title={n === 6 ? 'Whole drafts: the assistant may write a whole draft in your voice when you ask. Off unless you pick 6.' : undefined}
                  onClick={() => p.onCeiling(n)}
                >
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
        {p.voice && !p.source && (
          <div>
            <dt>Voice</dt>
            <dd>
              <button className="link" onClick={p.onVoice}>
                {!p.voice.exists ? 'Not built yet' : p.voice.upToDate ? 'Up to date' : 'Out of date'} · view
              </button>
            </dd>
          </div>
        )}
        {p.canStar !== false && (
          <div>
            <dt>Exemplar</dt>
            <dd>
              <button className={`star-toggle${p.exemplar ? ' is-on' : ''}`} onClick={p.onExemplar} title={`${p.exemplar ? 'Un-star' : 'Star'} (⌥⇧8)`}>
                <Icon name="star" />
                {p.exemplar ? 'Sounds like you' : 'Mark as sounding like you'}
              </button>
            </dd>
          </div>
        )}
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
