import { useEffect, useRef, useState } from 'react'
import { api, type Settings as S, type Status } from '../lib/api.ts'
import { helpMod } from '../editor/help.ts'
import { KeyMap } from './KeyMap.tsx'

interface Props {
  settings: S
  status: Status | null
  onChange: (patch: Partial<S>) => void
  onClose: () => void
}

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']

export function Settings({ settings: s, status, onChange, onClose }: Props) {
  const sheet = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState<string | null>(null)
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
  const providers: { id: S['provider']; name: string; note: string; ok: boolean }[] = st
    ? [
        { id: 'auto', name: 'Automatic', note: `The best one available${st.strong ? `: now ${providerName(st.strong)}` : ''}`, ok: true },
        { id: 'claude-cli', name: 'Claude CLI', note: st.claudeCli ? 'Signed in. Uses your Claude plan' : 'Not found. Install Claude Code and sign in', ok: st.claudeCli },
        { id: 'anthropic-api', name: 'Anthropic API', note: st.anthropicApi ? 'ANTHROPIC_API_KEY is set. Billed per request' : 'Set ANTHROPIC_API_KEY to use', ok: st.anthropicApi },
        { id: 'ollama', name: 'Local model', note: st.ollama ? `Ollama · ${s.ollamaModel}` : 'Ollama isn’t running', ok: st.ollama && generators.length > 0 },
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

        <section>
          <h3>Writing</h3>
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
        </section>

        <section>
          <h3>Models</h3>
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

        <section>
          <h3>Vault</h3>
          <Row label="Folder" hint="Start Ekdanta with EKDANTA_VAULT set to use another folder.">
            <span className="path">{st?.vault ?? '…'}</span>
          </Row>
          <Row label="Recall index" hint={index ?? 'Kept up to date as you write. Rebuild if Recall seems stale.'}>
            <button className="btn" onClick={rebuild}>
              Rebuild
            </button>
          </Row>
        </section>

        <section>
          <h3>Keyboard shortcuts</h3>
          <p className="sheet-note">Click a shortcut and press the keys you want. Changes apply at once.</p>
          <KeyMap overrides={s.keys ?? {}} onChange={(keys) => onChange({ keys })} />
        </section>
      </div>
    </div>
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
