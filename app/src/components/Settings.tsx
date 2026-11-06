import { useEffect, useRef, useState } from 'react'
import { api, type Settings as S, type Status } from '../lib/api.ts'
import { helpMod } from '../editor/help.ts'
import { SPECIAL_FOLDERS } from '../lib/special.ts'
import { KeyMap } from './KeyMap.tsx'
import { Kinds } from './Kinds.tsx'
import { RATES, listedVoices, readPrefs, sample, saveReadPrefs, useSpeechVoices } from './ReadAloudBar.tsx'
import { pickVoice, voiceLabel } from '../lib/speak.ts'

interface Props {
  settings: S
  status: Status | null
  onChange: (patch: Partial<S>) => void
  onClose: () => void
}

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']

const TABS = [
  { id: 'writing', label: 'Writing' },
  { id: 'kinds', label: 'Kinds' },
  { id: 'models', label: 'Models' },
  { id: 'vault', label: 'Vault' },
  { id: 'keys', label: 'Shortcuts' },
] as const
type Tab = (typeof TABS)[number]['id']
// Reopening Settings returns to the tab you left.
let lastTab: Tab = 'writing'

export function Settings({ settings: s, status, onChange, onClose }: Props) {
  const sheet = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState<string | null>(null)
  const [tab, setTabState] = useState<Tab>(lastTab)
  const setTab = (t: Tab) => {
    lastTab = t
    setTabState(t)
  }
  const tabsRef = useRef<HTMLDivElement>(null)
  // Arrow keys move between tabs, as in any tab list.
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = TABS[(to + TABS.length) % TABS.length].id
    setTab(next)
    tabsRef.current?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus()
  }
  useEffect(() => {
    sheet.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rebuild = async () => {
    setIndex('Rebuilding…')
    const r = await api.reindex()
    setIndex(`${r.paragraphs} paragraphs from ${r.files} documents`)
  }

  const st = status
  const generators = st?.ollamaModels.filter((m) => !/embed/.test(m)) ?? []
  const providers: {
    id: S['provider']
    name: string
    note: string
    ok: boolean
  }[] = st
    ? [
        {
          id: 'auto',
          name: 'Automatic',
          note: `The best one available${st.strong ? `: now ${providerName(st.strong)}` : ''}`,
          ok: true,
        },
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          note: st.claudeCli ? 'Signed in. Uses your Claude plan' : 'Not found. Install Claude Code and sign in',
          ok: st.claudeCli,
        },
        {
          id: 'anthropic-api',
          name: 'Anthropic API',
          note: st.anthropicApi ? 'ANTHROPIC_API_KEY is set. Billed per request' : 'Set ANTHROPIC_API_KEY to use',
          ok: st.anthropicApi,
        },
        {
          id: 'ollama',
          name: 'Local model',
          note: st.ollama ? `Ollama · ${s.ollamaModel}` : 'Ollama isn’t running',
          ok: st.ollama && generators.length > 0,
        },
      ]
    : []

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="Settings" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="sheet-tabs" role="tablist" aria-label="Settings sections" ref={tabsRef} onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`settings-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="settings-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`sheet-tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="sheet-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'writing' && (
            <section>
              <Row label="Help ceiling" hint="The highest help level that works with one press. Above it, press twice.">
                <Seg value={s.ceiling} options={[0, 1, 2, 3, 4, 5]} onPick={(ceiling) => onChange({ ceiling })} />
              </Row>
              <Row label="Recall dot" hint="A faint dot in the margin when your notes have something for this paragraph.">
                <Switch on={s.recallDot} onFlip={(recallDot) => onChange({ recallDot })} />
              </Row>
              <Row label="Paragraph focus" hint="In Focus mode, dim every paragraph but the one you’re in.">
                <Switch on={s.paragraphFocus} onFlip={(paragraphFocus) => onChange({ paragraphFocus })} />
              </Row>
              <Row label="Appearance">
                <Seg value={s.theme} options={['system', 'light', 'dark']} label={cap} onPick={(theme) => onChange({ theme })} />
              </Row>
              <ReadAloudRows />
            </section>
          )}

          {tab === 'kinds' && (
            <section>
              <p className="sheet-note">What you write. Each kind files its pieces in its own folder, learns its own voice profile, and tells the help levels how the piece should read.</p>
              <Kinds kinds={s.kinds} onChange={(kinds) => onChange({ kinds })} />
            </section>
          )}

          {tab === 'models' && (
            <section>
              <p className="sheet-note">Recall runs on this machine. The other levels use whichever model you already have.</p>
              <div className="choices" role="radiogroup" aria-label="Help answered by">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    role="radio"
                    aria-checked={s.provider === p.id}
                    disabled={!p.ok}
                    className={`choice${s.provider === p.id ? ' is-on' : ''}`}
                    onClick={() => onChange({ provider: p.id })}
                  >
                    <span className="dot" />
                    <span>
                      <b>{p.name}</b>
                      <small>{p.note}</small>
                    </span>
                  </button>
                ))}
              </div>
              {st?.claudeCli && (
                <>
                  <Row label={`${helpMod}3 Word`} hint="A small model keeps word options quick.">
                    <Seg value={s.claudeFastModel} options={CLAUDE_MODELS} label={cap} onPick={(claudeFastModel) => onChange({ claudeFastModel })} />
                  </Row>
                  <Row label={`${helpMod}2 ${helpMod}4 ${helpMod}5`} hint="Nudge, Sentence and Passage.">
                    <Seg value={s.claudeModel} options={CLAUDE_MODELS} label={cap} onPick={(claudeModel) => onChange({ claudeModel })} />
                  </Row>
                </>
              )}
              {generators.length > 0 && (
                <>
                  <Row label="Local model">
                    <select className="select" value={s.ollamaModel} onChange={(e) => onChange({ ollamaModel: e.target.value })}>
                      {[...new Set([s.ollamaModel, ...generators])].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label={`Local ${helpMod}3`} hint="Answer Word with the local model, even when another one answers the rest.">
                    <Switch on={s.wordLocal} onFlip={(wordLocal) => onChange({ wordLocal })} />
                  </Row>
                </>
              )}
              <Row label={`${helpMod}1 Recall`} hint="Switching rebuilds the index of your writing.">
                <Seg
                  value={s.embedder}
                  options={st?.ollamaModels.some((m) => /embed/.test(m)) ? ['builtin', 'ollama'] : ['builtin']}
                  label={(v) => (v === 'builtin' ? 'Built in' : 'Ollama')}
                  onPick={(embedder) => onChange({ embedder })}
                />
              </Row>
            </section>
          )}

          {tab === 'vault' && (
            <section>
              <Row label="Folder" hint="Start Ekdanta with EKDANTA_VAULT set to use another folder.">
                <span className="path">{st?.vault ?? '…'}</span>
              </Row>
              <Row label="Recall index" hint={index ?? 'Kept up to date as you write. Rebuild if Recall seems stale.'}>
                <button className="btn" onClick={rebuild}>
                  Rebuild
                </button>
              </Row>
              <Row label="Left out" hint="Top-level folders of material, not your own finished writing. Recall and voice skip them.">
                <span className="path folders">
                  {SPECIAL_FOLDERS.map((f) => (
                    <span key={f}>{f}/</span>
                  ))}
                </span>
              </Row>
            </section>
          )}

          {tab === 'keys' && (
            <section>
              <p className="sheet-note">Click a shortcut and press the keys you want. Changes apply at once.</p>
              <KeyMap overrides={s.keys ?? {}} onChange={(keys) => onChange({ keys })} />
            </section>
          )}
        </div>
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
  return (
    <>
      <Row
        label="Read aloud voice"
        hint={
          chosen && !chosen.localService
            ? 'This voice sends the text it reads to an online service.'
            : 'Voices on this computer come first; they work offline. A document with a lang property is read in that language.'
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
          <button className="btn" title="Hear a sample" onClick={() => sample(chosen ?? pickVoice(voices, { systemLang: navigator.language }), prefs.rate)}>
            Try
          </button>
        </div>
      </Row>
    </>
  )
}

const cap = (v: string | number) => {
  const t = String(v)
  return t[0].toUpperCase() + t.slice(1)
}

function providerName(p: string) {
  return p === 'claude-cli' ? 'Claude CLI' : p === 'anthropic-api' ? 'Anthropic API' : 'Local model'
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

function Seg<T extends string | number>({ value, options, label = String, onPick }: { value: T; options: T[]; label?: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <div className="seg seg-text" role="radiogroup">
      {options.map((o) => (
        <button key={String(o)} role="radio" aria-checked={o === value} className={o === value ? 'is-on' : ''} onClick={() => onPick(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  )
}

function Switch({ on, onFlip }: { on: boolean; onFlip: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} className={`switch${on ? ' is-on' : ''}`} onClick={() => onFlip(!on)} />
}
