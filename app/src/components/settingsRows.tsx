// Every row of Settings, declared as data: which tab it's on, what it's called, the words it can be
// found by, and whether it's an advanced option. Search and the "Show advanced settings" switch work
// on this list, so a new setting is one entry here.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Settings as S, type Status } from '../lib/api.ts'
import { AUTOSAVE, TEXT_SIZE, kindsInExcluded } from '../lib/appearance.ts'
import { helpMod } from '../editor/help.ts'
import { SPECIAL_FOLDERS, isSpecialPath } from '../lib/special.ts'
import { KeyMap } from './KeyMap.tsx'
import { Kinds } from './Kinds.tsx'
import { RATES, listedVoices, readPrefs, sample, saveReadPrefs, useSpeechVoices } from './ReadAloudBar.tsx'
import { isOnlineVoice, pickVoice, voiceLabel } from '../lib/speak.ts'
import { STYLES } from '../lib/docstyle.ts'

export const TABS = [
  { id: 'writing', label: 'Writing' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'kinds', label: 'Kinds' },
  { id: 'models', label: 'Models' },
  { id: 'vault', label: 'Vault' },
  { id: 'keys', label: 'Shortcuts' },
] as const
export type Tab = (typeof TABS)[number]['id']
export const tabLabel = (id: string) => TABS.find((t) => t.id === id)?.label ?? id

/** What a row can read and change. */
export interface RowCtx {
  s: S
  status: Status | null
  onChange: (patch: Partial<S>) => void
  /** Every folder in the vault, for folder pickers. */
  folders: string[]
  /** The vault's .css files, once listed. */
  snippets: string[] | null
  /** Why the chosen CSS snippet isn't applied, if it isn't. */
  snippetNote: string | null
  /** The Recall index's last rebuild, or null. */
  index: string | null
  rebuild: () => void
  /** Rename a kind's doubled folder (from the kind-and-name fixes). */
  onRenameFolder?: (id: string) => Promise<void>
}

export interface SettingRow {
  tab: Tab
  id: string
  label: string
  /** More words the row is found by in search. */
  keywords?: string
  /** Hidden unless "Show advanced settings" is on, or a search finds it. */
  advanced?: boolean
  /** An advanced row with something to say right now (a snippet that won't load), shown even while advanced is off. */
  showAnyway?: (c: RowCtx) => boolean
  /** Only offered when this holds (a local model is installed, say). */
  when?: (c: RowCtx) => boolean
  hint?: (c: RowCtx) => ReactNode
  /** A row that is a whole section (the kinds list, the shortcut map): no label column. */
  full?: boolean
  render: (c: RowCtx) => ReactNode
}

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']
const generators = (c: RowCtx) => c.status?.ollamaModels.filter((m) => !/embed/.test(m)) ?? []

export const ROWS: SettingRow[] = [
  // ---- Writing
  {
    tab: 'writing',
    id: 'ceiling',
    label: 'Help ceiling',
    keywords: 'levels press twice limit',
    hint: () => 'The highest help level that works with one press. Above it, press twice.',
    render: ({ s, onChange }) => <Seg value={s.ceiling} options={[0, 1, 2, 3, 4, 5]} onPick={(ceiling) => onChange({ ceiling })} />,
  },
  {
    tab: 'writing',
    id: 'recallDot',
    label: 'Recall dot',
    keywords: 'margin notes dot',
    hint: () => 'A faint dot in the margin when your notes have something for this paragraph.',
    render: ({ s, onChange }) => <Switch on={s.recallDot} onFlip={(recallDot) => onChange({ recallDot })} />,
  },
  {
    tab: 'writing',
    id: 'paragraphFocus',
    label: 'Paragraph focus',
    keywords: 'focus mode dim',
    hint: () => 'In Focus mode, dim every paragraph but the one you’re in.',
    render: ({ s, onChange }) => <Switch on={s.paragraphFocus} onFlip={(paragraphFocus) => onChange({ paragraphFocus })} />,
  },
  {
    tab: 'writing',
    id: 'newDocView',
    label: 'New documents open in',
    keywords: 'default view page markdown source live preview',
    hint: () => 'The page, or the Markdown as written.',
    render: ({ s, onChange }) => <Seg value={s.newDocView} options={['page', 'markdown']} label={(v) => (v === 'page' ? 'Page' : 'Markdown')} onPick={(newDocView) => onChange({ newDocView })} />,
  },
  {
    tab: 'writing',
    id: 'readAloud',
    label: 'Read aloud',
    keywords: 'voice speak speech speed rate listen tts',
    full: true,
    render: () => <ReadAloudRows />,
  },
  {
    tab: 'writing',
    id: 'autosaveMs',
    label: 'Autosave delay',
    keywords: 'save timing wait',
    advanced: true,
    hint: () => 'How long after you stop typing the document saves.',
    render: ({ s, onChange }) => (
      <Range value={s.autosaveMs} {...AUTOSAVE} format={(v) => (v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`)} label="Autosave delay" onPick={(autosaveMs) => onChange({ autosaveMs })} />
    ),
  },
  {
    tab: 'writing',
    id: 'openLast',
    label: 'Open last document on start',
    keywords: 'startup launch resume reopen new draft',
    advanced: true,
    hint: ({ s }) => (s.openLast ? 'Ekdanta opens where you left off.' : 'Ekdanta starts on a fresh draft.'),
    render: ({ s, onChange }) => <Switch on={s.openLast} onFlip={(openLast) => onChange({ openLast })} />,
  },

  {
    tab: 'writing',
    id: 'profile',
    label: 'You',
    keywords: 'name author institution school university profile page view document style mla apa chicago heading title page',
    full: true,
    render: ({ s, onChange }) => (
      <details className="you">
        <summary>You</summary>
        <p className="sheet-note">For the heading or title page of a piece in page view. A piece’s own author and institution come first.</p>
        <Row label="Name">
          <TextSetting value={s.profileName ?? ''} placeholder="Your name" maxLength={120} onCommit={(profileName) => onChange({ profileName })} />
        </Row>
        <Row label="Institution" hint="For APA title pages.">
          <TextSetting value={s.profileInstitution ?? ''} placeholder="School or university" maxLength={160} onCommit={(profileInstitution) => onChange({ profileInstitution })} />
        </Row>
        <Row label="Default style" hint="When you turn on page view for a piece that has none.">
          <Seg value={s.defaultStyle ?? 'mla'} options={STYLES.map((x) => x.id)} label={(v) => STYLES.find((x) => x.id === v)?.label ?? v} onPick={(defaultStyle) => onChange({ defaultStyle })} />
        </Row>
      </details>
    ),
  },

  // ---- Appearance
  {
    tab: 'appearance',
    id: 'theme',
    label: 'Theme',
    keywords: 'dark light mode system colour color appearance',
    render: ({ s, onChange }) => <Seg value={s.theme} options={['system', 'light', 'dark']} label={cap} onPick={(theme) => onChange({ theme })} />,
  },
  {
    tab: 'appearance',
    id: 'font',
    label: 'Font',
    keywords: 'typeface serif sans mono system family',
    hint: ({ s }) => (s.font === 'custom' ? s.fontFamily : 'For the page. Menus keep theirs.'),
    render: ({ s, onChange }) => (
      <Seg value={s.font} options={s.fontFamily ? ['serif', 'sans', 'mono', 'system', 'custom'] : ['serif', 'sans', 'mono', 'system']} label={cap} onPick={(font) => onChange({ font })} />
    ),
  },
  {
    tab: 'appearance',
    id: 'textSize',
    label: 'Text size',
    keywords: 'font size zoom bigger smaller larger',
    hint: ({ s }) => (
      <span className="size-preview" aria-hidden="true" style={{ fontSize: `${s.textSize}px` }}>
        The page, as you’ll write it.
      </span>
    ),
    render: ({ s, onChange }) => <Range value={s.textSize} {...TEXT_SIZE} format={(v) => `${v} px`} label="Text size" onPick={(textSize) => onChange({ textSize })} />,
  },
  {
    tab: 'appearance',
    id: 'lineWidth',
    label: 'Line width',
    keywords: 'column measure wide narrow full page width',
    hint: ({ s }) => (s.lineWidth === 'full' ? 'The page fills the space between the side panels.' : undefined),
    render: ({ s, onChange }) => <Seg value={s.lineWidth} options={['narrow', 'comfortable', 'wide', 'full']} label={cap} onPick={(lineWidth) => onChange({ lineWidth })} />,
  },
  {
    tab: 'appearance',
    id: 'lineHeight',
    label: 'Line height',
    keywords: 'leading spacing lines',
    advanced: true,
    render: ({ s, onChange }) => <Seg value={s.lineHeight} options={['compact', 'normal', 'airy']} label={cap} onPick={(lineHeight) => onChange({ lineHeight })} />,
  },
  {
    tab: 'appearance',
    id: 'paragraphSpacing',
    label: 'Paragraph spacing',
    keywords: 'gap space between paragraphs',
    advanced: true,
    hint: () => 'Space between one paragraph and the next.',
    render: ({ s, onChange }) => (
      <Seg
        value={s.paragraphSpacing}
        options={['none', 'half', 'line']}
        label={(v) => (v === 'none' ? 'None' : v === 'half' ? 'Half a line' : 'A line')}
        onPick={(paragraphSpacing) => onChange({ paragraphSpacing })}
      />
    ),
  },
  {
    tab: 'appearance',
    id: 'wordCount',
    label: 'Word count in the status bar',
    keywords: 'words reading time minutes status bar length limit target',
    advanced: true,
    hint: () => 'Off also hides the reading time and the length limit. A limit you have already set stays, so you can still see when you are over it.',
    render: ({ s, onChange }) => <Switch on={s.wordCount} onFlip={(wordCount) => onChange({ wordCount })} />,
  },
  {
    tab: 'appearance',
    id: 'spellcheck',
    label: 'Spellcheck',
    keywords: 'spelling typos red underline',
    advanced: true,
    hint: () => 'Your browser’s own spelling check, in the page and the Markdown view.',
    render: ({ s, onChange }) => <Switch on={s.spellcheck} onFlip={(spellcheck) => onChange({ spellcheck })} />,
  },
  {
    tab: 'appearance',
    id: 'fontFamily',
    label: 'Custom font',
    keywords: 'family installed typeface',
    advanced: true,
    hint: ({ s }) => (s.fontFamily && !fontInstalled(s.fontFamily) ? `“${s.fontFamily}” isn’t installed here, so the page uses the serif font.` : 'Any font installed on this computer, by name.'),
    render: ({ s, onChange }) => <FamilyInput s={s} onChange={onChange} />,
  },
  {
    tab: 'appearance',
    id: 'cssSnippet',
    label: 'CSS snippet',
    keywords: 'style styles theme custom css stylesheet obsidian',
    advanced: true,
    // A snippet that can't be used is worth knowing about, so the row comes out of hiding to say so.
    showAnyway: (c) => !!c.snippetNote,
    hint: (c) => (c.snippetNote ? <span className="row-warn">{c.snippetNote}</span> : 'A .css file in your vault, added to the app’s styles. Changes to it apply when you come back to the window.'),
    render: ({ s, snippets, onChange }) => {
      const list = snippets ?? []
      return (
        <select className="select" aria-label="CSS snippet" value={s.cssSnippet} onChange={(e) => onChange({ cssSnippet: e.target.value })}>
          <option value="">{snippets && !list.length ? 'No .css files in the vault' : 'None'}</option>
          {(s.cssSnippet && !list.includes(s.cssSnippet) ? [s.cssSnippet, ...list] : list).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )
    },
  },

  // ---- Kinds
  {
    tab: 'kinds',
    id: 'kinds',
    label: 'Kinds of writing',
    keywords: 'kind folder voice guidance length template platform',
    full: true,
    render: ({ s, onChange, onRenameFolder }) => (
      <>
        <p className="sheet-note">What you write. Each kind files its pieces in its own folder, learns its own voice profile, and tells the help levels how the piece should read.</p>
        <Kinds kinds={s.kinds} onChange={(kinds) => onChange({ kinds })} onRenameFolder={onRenameFolder} />
      </>
    ),
  },

  // ---- Models
  {
    tab: 'models',
    id: 'provider',
    label: 'Help answered by',
    keywords: 'provider model claude anthropic api ollama local',
    full: true,
    render: (c) => <Providers {...c} />,
  },
  {
    tab: 'models',
    id: 'ollamaModel',
    label: 'Local model',
    keywords: 'ollama',
    when: (c) => generators(c).length > 0,
    render: (c) => (
      <select className="select" aria-label="Local model" value={c.s.ollamaModel} onChange={(e) => c.onChange({ ollamaModel: e.target.value })}>
        {[...new Set([c.s.ollamaModel, ...generators(c)])].map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    ),
  },
  {
    tab: 'models',
    id: 'claudeFastModel',
    label: `${helpMod}3 Word`,
    keywords: 'claude model routing word haiku sonnet opus',
    advanced: true,
    when: (c) => !!c.status?.claudeCli,
    hint: () => 'A small model keeps word options quick.',
    render: ({ s, onChange }) => <Seg value={s.claudeFastModel} options={CLAUDE_MODELS} label={cap} onPick={(claudeFastModel) => onChange({ claudeFastModel })} />,
  },
  {
    tab: 'models',
    id: 'claudeModel',
    label: `${helpMod}2 ${helpMod}4 ${helpMod}5`,
    keywords: 'claude model routing nudge sentence passage haiku sonnet opus',
    advanced: true,
    when: (c) => !!c.status?.claudeCli,
    hint: () => 'Nudge, Sentence and Passage.',
    render: ({ s, onChange }) => <Seg value={s.claudeModel} options={CLAUDE_MODELS} label={cap} onPick={(claudeModel) => onChange({ claudeModel })} />,
  },
  {
    tab: 'models',
    id: 'wordLocal',
    label: `Local ${helpMod}3`,
    keywords: 'ollama word routing local model',
    advanced: true,
    when: (c) => generators(c).length > 0,
    hint: () => 'Answer Word with the local model, even when another one answers the rest.',
    render: ({ s, onChange }) => <Switch on={s.wordLocal} onFlip={(wordLocal) => onChange({ wordLocal })} />,
  },
  {
    tab: 'models',
    id: 'embedder',
    label: `${helpMod}1 Recall`,
    keywords: 'embedding embedder index recall',
    advanced: true,
    hint: () => 'Switching rebuilds the index of your writing.',
    render: ({ s, status, onChange }) => (
      <Seg
        value={s.embedder}
        options={status?.ollamaModels.some((m) => /embed/.test(m)) ? ['builtin', 'ollama'] : ['builtin']}
        label={(v) => (v === 'builtin' ? 'Built in' : 'Ollama')}
        onPick={(embedder) => onChange({ embedder })}
      />
    ),
  },

  // ---- Vault
  {
    tab: 'vault',
    id: 'vaultFolder',
    label: 'Folder',
    keywords: 'vault location path',
    hint: () => 'Start Ekdanta with EKDANTA_VAULT set to use another folder.',
    render: ({ status }) => <span className="path">{status?.vault ?? '…'}</span>,
  },
  {
    tab: 'vault',
    id: 'newNotesIn',
    label: 'New notes go in',
    keywords: 'new draft note folder location create',
    hint: ({ s }) =>
      s.newNotesIn === 'kind'
        ? 'The folder of the kind you’re writing now.'
        : s.newNotesIn === 'current'
          ? 'The folder of the document you have open.'
          : `Always ${s.newNotesFolder ? s.newNotesFolder + '/' : 'the top of the vault'}.`,
    render: (c) => <NewNotes {...c} />,
  },
  {
    tab: 'vault',
    id: 'index',
    label: 'Recall index',
    keywords: 'rebuild reindex search',
    hint: ({ index }) => index ?? 'Kept up to date as you write. Rebuild if Recall seems stale.',
    render: ({ rebuild }) => (
      <button className="btn" onClick={rebuild}>
        Rebuild
      </button>
    ),
  },
  {
    tab: 'vault',
    id: 'special',
    label: 'Always left out',
    keywords: 'special folders templates journal sources exports inbox left out excluded',
    hint: () => 'Top-level folders of material, not your own finished writing. Recall and voice skip them.',
    render: () => (
      <span className="path folders">
        {SPECIAL_FOLDERS.map((f) => (
          <span key={f}>{f}/</span>
        ))}
      </span>
    ),
  },
  {
    tab: 'vault',
    id: 'excludedFolders',
    label: 'Also left out',
    keywords: 'exclude excluded ignore skip hide folders recall voice index left out',
    advanced: true,
    full: true,
    render: (c) => <Excluded {...c} />,
  },
  {
    tab: 'vault',
    id: 'brainFolder',
    label: 'Brain folder',
    keywords: 'brain books podcasts videos articles highlights sources kindle readwise',
    hint: () => 'Where notes on books, podcasts, videos and articles go. Their highlights are the only part Recall reads. Notes already there aren’t moved.',
    render: ({ s, onChange }) => <FolderField value={s.brainFolder ?? 'brain'} label="Brain folder" onCommit={(brainFolder) => onChange({ brainFolder })} />,
  },

  // ---- Shortcuts
  {
    tab: 'keys',
    id: 'keys',
    label: 'Shortcuts',
    keywords: 'keyboard keys hotkeys bindings remap',
    full: true,
    render: ({ s, onChange }) => (
      <>
        <p className="sheet-note">Click a shortcut and press the keys you want. Changes apply at once.</p>
        <KeyMap overrides={s.keys ?? {}} onChange={(keys) => onChange({ keys })} />
      </>
    ),
  },
]

// ---- Controls --------------------------------------------------------------------------------

/** The label of the row a control sits in, so switches and option groups say what they are to a screen reader. */
export const RowName = createContext<string | undefined>(undefined)

export const cap = (v: string | number) => {
  const t = String(v)
  return t[0].toUpperCase() + t.slice(1)
}

export function Seg<T extends string | number>({ value, options, label = String, name, onPick }: { value: T; options: T[]; label?: (v: T) => string; name?: string; onPick: (v: T) => void }) {
  const rowName = useContext(RowName)
  return (
    <div className="seg seg-text" role="radiogroup" aria-label={name ?? rowName}>
      {options.map((o) => (
        <button key={String(o)} role="radio" aria-checked={o === value} className={o === value ? 'is-on' : ''} onClick={() => onPick(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  )
}

export function Switch({ on, onFlip, label }: { on: boolean; onFlip: (v: boolean) => void; label?: string }) {
  const rowName = useContext(RowName)
  return <button role="switch" aria-checked={on} aria-label={label ?? rowName} className={`switch${on ? ' is-on' : ''}`} onClick={() => onFlip(!on)} />
}

function Range({ value, min, max, step, format, label, onPick }: { value: number; min: number; max: number; step: number; format: (v: number) => string; label: string; onPick: (v: number) => void }) {
  return (
    <span className="range">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onPick(Number(e.target.value))} />
      <output>{format(value)}</output>
    </span>
  )
}

/** The family is typed, then applied on Return or when the field is left, so the page doesn't flicker through half-typed names. */
function FamilyInput({ s, onChange }: { s: S; onChange: (patch: Partial<S>) => void }) {
  const [draft, setDraft] = useState(s.fontFamily)
  useEffect(() => setDraft(s.fontFamily), [s.fontFamily])
  const commit = () => {
    const fontFamily = draft.trim()
    if (fontFamily === s.fontFamily) return
    onChange(fontFamily ? { fontFamily, font: 'custom' } : { fontFamily, font: s.font === 'custom' ? 'serif' : s.font })
  }
  return (
    <input
      className="input"
      aria-label="Custom font"
      placeholder="e.g. Iowan Old Style"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      // Esc closes Settings, so what was typed is kept first rather than thrown away.
      onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && commit()}
    />
  )
}

/** Is a font installed? Text set in it measures differently from text in each generic fallback. */
function fontInstalled(family: string) {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return true
    const sample = 'mmmmmmmmmmlli1WQ@#'
    return ['monospace', 'serif', 'sans-serif'].some((generic) => {
      ctx.font = `32px ${generic}`
      const base = ctx.measureText(sample).width
      ctx.font = `32px "${family.replace(/"/g, '')}", ${generic}`
      return ctx.measureText(sample).width !== base
    })
  } catch {
    return true
  }
}

function Providers({ s, status: st, onChange }: RowCtx) {
  const gens = st?.ollamaModels.filter((m) => !/embed/.test(m)) ?? []
  const providers: { id: S['provider']; name: string; note: string; ok: boolean }[] = st
    ? [
        { id: 'auto', name: 'Automatic', note: `The best one available${st.strong ? `: now ${providerName(st.strong)}` : ''}`, ok: true },
        { id: 'claude-cli', name: 'Claude CLI', note: st.claudeCli ? 'Signed in. Uses your Claude plan' : 'Not found. Install Claude Code and sign in', ok: st.claudeCli },
        { id: 'anthropic-api', name: 'Anthropic API', note: st.anthropicApi ? 'ANTHROPIC_API_KEY is set. Billed per request' : 'Set ANTHROPIC_API_KEY to use', ok: st.anthropicApi },
        { id: 'ollama', name: 'Local model', note: st.ollama ? `Ollama · ${s.ollamaModel}` : 'Ollama isn’t running', ok: st.ollama && gens.length > 0 },
      ]
    : []
  return (
    <>
      <p className="sheet-note">Recall runs on this machine. The other levels use whichever model you already have.</p>
      <div className="choices" role="radiogroup" aria-label="Help answered by">
        {providers.map((p) => (
          <button key={p.id} role="radio" aria-checked={s.provider === p.id} disabled={!p.ok} className={`choice${s.provider === p.id ? ' is-on' : ''}`} onClick={() => onChange({ provider: p.id })}>
            <span className="dot" />
            <span>
              <b>{p.name}</b>
              <small>{p.note}</small>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

function providerName(p: string) {
  return p === 'claude-cli' ? 'Claude CLI' : p === 'anthropic-api' ? 'Anthropic API' : 'Local model'
}

function NewNotes({ s, folders, onChange }: RowCtx) {
  return (
    <span className="row-stack">
      <Seg
        value={s.newNotesIn}
        options={['kind', 'current', 'fixed']}
        label={(v) => (v === 'kind' ? 'Kind folder' : v === 'current' ? 'Current folder' : 'One folder')}
        onPick={(newNotesIn) => onChange({ newNotesIn })}
      />
      {s.newNotesIn === 'fixed' && (
        <select className="select" aria-label="Folder for new notes" value={s.newNotesFolder} onChange={(e) => onChange({ newNotesFolder: e.target.value })}>
          <option value="">Top of the vault</option>
          {[...new Set([s.newNotesFolder, ...folders].filter(Boolean))].map((f) => (
            <option key={f} value={f}>
              {f}/
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

/** A folder name, saved when the field loses focus or on Return; Esc puts it back. */
function FolderField({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim().replace(/^\/+|\/+$/g, '')
    if (v && v !== value) onCommit(v)
    else setDraft(value)
  }
  return (
    <span className="folder-field">
      <input
        aria-label={label}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(value)
          }
        }}
      />
      /
    </span>
  )
}

/** The writer's own excluded folders: a list to add to and remove from, with what the change means. */
function Excluded({ s, folders, onChange }: RowCtx) {
  const [draft, setDraft] = useState('')
  const [changed, setChanged] = useState(false)
  const [index, setIndex] = useState<string | null>(null)
  const list = s.excludedFolders ?? []
  const set = (excludedFolders: string[]) => {
    onChange({ excludedFolders })
    setChanged(true)
    setIndex(null)
  }
  const add = () => {
    const f = draft.trim().replace(/^\/+|\/+$/g, '')
    if (!f) return
    if (!list.some((x) => x.toLowerCase() === f.toLowerCase())) set([...list, f])
    setDraft('')
  }
  const reindex = async () => {
    setIndex('Rebuilding…')
    const r = await api.reindex()
    setIndex(`Rebuilt: ${r.paragraphs} paragraphs from ${r.files} documents.`)
    setChanged(false)
  }
  const emptied = kindsInExcluded(s.kinds, list)
  return (
    <div className="excluded">
      <div className="row-label">
        <span>Also left out</span>
        <small>Folders of your own you’d rather Recall didn’t quote and voice profiles didn’t learn from, such as old drafts or an archive.</small>
      </div>
      {list.length > 0 && (
        <ul className="excluded-list" aria-label="Excluded folders">
          {list.map((f) => (
            <li key={f}>
              <span>{f}/</span>
              {isSpecialPath(f) && <small>always left out</small>}
              <button aria-label={`Stop excluding ${f}`} title="Stop excluding" onClick={() => set(list.filter((x) => x !== f))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="excluded-add">
        <input
          className="input"
          list="excluded-folders"
          aria-label="Folder to exclude"
          placeholder="Folder, e.g. archive"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <datalist id="excluded-folders">
          {folders
            .filter((f) => !list.includes(f))
            .map((f) => (
              <option key={f} value={f} />
            ))}
        </datalist>
        <button className="btn" onClick={add} disabled={!draft.trim()}>
          Exclude
        </button>
      </div>
      {emptied.length > 0 && (
        <p className="row-warn">
          {emptied.map((k) => k.name).join(', ')} {emptied.length === 1 ? 'is' : 'are'} filed in an excluded folder, so {emptied.length === 1 ? 'its voice profile' : 'their voice profiles'} will be
          empty.
        </p>
      )}
      {(changed || index) && (
        <p className="sheet-note excluded-reindex">
          {index ?? 'Recall still knows what was in these folders until the index is rebuilt.'}{' '}
          {changed && index !== 'Rebuilding…' && (
            <button className="link-btn" onClick={reindex}>
              Rebuild now
            </button>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * A line of text that saves when you leave it, press Return, or close Settings while typing.
 * Escape puts back what was saved.
 */
function TextSetting({ value, placeholder, maxLength, onCommit }: { value: string; placeholder: string; maxLength: number; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const latest = useRef({ draft, value, onCommit })
  latest.current = { draft, value, onCommit }
  const commit = () => {
    const { draft, value, onCommit } = latest.current
    if (draft.trim() !== value) onCommit(draft.trim())
  }
  // Closing Settings can take the field away before it blurs: what was typed is still kept.
  useEffect(() => commit, [])
  return (
    <input
      className="kind-input"
      value={draft}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setDraft((latest.current.draft = value))
      }}
    />
  )
}

/** A labelled row inside a full-width row, for a group of settings that belong together. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="row-control">
        <RowName.Provider value={label}>{children}</RowName.Provider>
      </div>
    </div>
  )
}

/** Read aloud's voice and speed. Kept on this computer: each computer has its own voices. */
function ReadAloudRows() {
  const voices = useSpeechVoices()
  const [prefs, setPrefs] = useState(readPrefs)
  const change = (patch: Partial<typeof prefs>) => {
    saveReadPrefs(patch)
    setPrefs(readPrefs())
  }
  if (!('speechSynthesis' in window) || !voices.length)
    return (
      <Row
        label="Read aloud"
        hint={
          'speechSynthesis' in window
            ? 'This browser has no voices installed, so Read aloud is hidden. Add a voice in your computer’s speech or accessibility settings, then reload.'
            : 'This browser can’t speak, so Read aloud is hidden. Chrome, Edge and Safari can.'
        }
      >
        <span className="muted">Unavailable</span>
      </Row>
    )
  const listed = listedVoices(voices)
  const chosen = listed.find((v) => v.voiceURI === prefs.voice)
  const used = chosen ?? pickVoice(voices, { systemLang: navigator.language })
  return (
    <>
      <Row
        label="Read aloud voice"
        hint={
          isOnlineVoice(used)
            ? chosen
              ? 'This voice sends the text it reads to an online service.'
              : 'This computer has no voices of its own, so Automatic uses an online one: it sends the text it reads to an online service.'
            : 'Voices on this computer work offline. A document with a lang property is read in that language when this computer has a voice for it.'
        }
      >
        <select className="select read-voice" aria-label="Read aloud voice" value={chosen ? prefs.voice : ''} onChange={(e) => change({ voice: e.target.value })}>
          <option value="">Automatic</option>
          {listed.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {voiceLabel(v)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Read aloud speed">
        <div className="read-speed">
          <Seg value={prefs.rate as (typeof RATES)[number]} options={[...RATES]} label={(r) => (r === 1 ? 'Normal' : `${r}×`)} onPick={(rate) => change({ rate })} />
          <button className="btn" title="Hear a sample" onClick={() => sample(used, prefs.rate)}>
            Try
          </button>
        </div>
      </Row>
    </>
  )
}
