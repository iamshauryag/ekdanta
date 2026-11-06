import { useEffect, useRef, useState } from 'react'
import { diffLines } from 'diff'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { api, type VoiceSummary } from '../lib/api.ts'
import { joinFrontMatter, splitFrontMatter } from '../lib/frontmatter.ts'
import { helpMod } from '../editor/help.ts'
import { Markdown } from '../lib/markdown.tsx'

interface Props {
  platform: string
  summary: VoiceSummary | undefined
  onOpenDoc: (path: string) => void
  onChanged: () => void
}

export const platformLabel = (p: string) => (p === 'linkedin' ? 'LinkedIn' : p[0].toUpperCase() + p.slice(1))

/** One platform's voice profile: read it, edit it, rebuild it from the exemplars. */
export function VoicePage({ platform, summary, onOpenDoc, onChanged }: Props) {
  const [profile, setProfile] = useState<{ raw: string; meta: Record<string, string>; body: string } | null | undefined>(undefined)
  const [proposal, setProposal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('') // the profile as last typed, for the preview
  const saveTimer = useRef<number | undefined>(undefined)

  const load = () =>
    api.voiceProfile(platform).then((content) => {
      if (content === null) return setProfile(null)
      const { meta, body, raw } = splitFrontMatter(content)
      setProfile({ meta, body, raw })
      setDraft(body)
    })
  useEffect(() => {
    setProposal(null)
    setError(null)
    setProfile(undefined)
    setEditing(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform])

  const write = async (content: string) => {
    await api.saveVoiceProfile(platform, content)
    await load()
    onChanged()
  }

  const build = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.buildVoice(platform)
      // The first profile has nothing to compare with; later ones are reviewed as a diff.
      if (profile) setProposal(next)
      else await write(next)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onEdit = (body: string) => {
    if (!profile) return
    setDraft(body)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => api.saveVoiceProfile(platform, joinFrontMatter(profile.raw, profile.meta, body)), 600)
  }

  const sources = summary?.sources ?? []
  // A quote's [[link]] names the piece it came from.
  const openLink = (target: string) => {
    const s = sources.find((x) => x.path.replace(/\.md$/, '').split('/').pop() === target || x.path.replace(/\.md$/, '') === target)
    return s ? () => onOpenDoc(s.path) : undefined
  }
  const state = !summary ? '' : !summary.exists ? 'Not built yet' : summary.upToDate ? 'Up to date' : 'Out of date'
  const builtOn = profile?.meta.built ? new Date(profile.meta.built).toLocaleDateString([], { day: 'numeric', month: 'short' }) : null

  return (
    <div className="page voice-page">
      <div className="doc-meta">
        <span>Voice profile</span>
        {state && <span className={`voice-state is-${state.split(' ')[0].toLowerCase()}`}>· {state}</span>}
        {builtOn && <span className="muted">· built {builtOn}</span>}
        <span className="muted path">.ekdanta/voice/{platform}.md</span>
      </div>
      <h1 className="doc-title static">{platformLabel(platform)} voice</h1>

      <div className="voice-sources">
        <span className="muted">{sources.length ? 'Learned from' : 'Nothing to learn from yet.'}</span>
        {sources.map((s) => (
          <button key={s.path} className={`chip${s.exemplar ? ' is-exemplar' : ''}`} title={s.exemplar ? 'Exemplar' : 'Recent piece, not starred'} onClick={() => onOpenDoc(s.path)}>
            {s.exemplar ? '★ ' : ''}
            {s.title}
          </button>
        ))}
      </div>
      {summary && summary.exemplars < 3 && (
        <p className="voice-hint">
          {summary.exemplars === 0 ? 'No exemplars yet, so this uses your most recent pieces.' : `Only ${summary.exemplars} exemplar${summary.exemplars === 1 ? '' : 's'}, so recent pieces fill in.`} Star the
          pieces that sound most like you for a better profile.
        </p>
      )}

      <div className="voice-actions">
        {sources.length > 0 && !proposal && (
          <button className="btn" disabled={busy} onClick={build}>
            {busy ? `Reading ${sources.length} piece${sources.length === 1 ? '' : 's'}…` : profile ? 'Rebuild' : `Build from ${sources.length} piece${sources.length === 1 ? '' : 's'}`}
          </button>
        )}
        {error && <span className="voice-error">{error}</span>}
        <span className="spacer" />
        {profile && !proposal && (
          <div className="seg" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={!editing} className={!editing ? 'is-on' : ''} onClick={() => setEditing(false)}>
              Preview
            </button>
            <button role="radio" aria-checked={editing} className={editing ? 'is-on' : ''} onClick={() => setEditing(true)}>
              Markdown
            </button>
          </div>
        )}
      </div>

      {proposal && profile && (
        <Proposal
          current={profile.body}
          next={splitFrontMatter(proposal).body}
          onAccept={() => write(proposal).then(() => setProposal(null))}
          onReject={() => setProposal(null)}
        />
      )}

      {profile === null && !busy && sources.length > 0 && (
        <p className="empty">
          A profile is a short list of traits: how your {platformLabel(platform)} pieces open, their rhythm, the words you reach for. Each trait quotes your own
          writing. You can edit it, add rules of your own, and {helpMod}3–{helpMod}5 follow it.
        </p>
      )}
      {profile && !proposal && editing && <ProfileEditor key={platform + (profile.meta.built ?? '')} initial={draft} onChange={onEdit} />}
      {profile && !proposal && !editing && (
        <div onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          <Markdown className="md profile-preview" text={draft} onLink={openLink} />
        </div>
      )}
    </div>
  )
}

/** A rebuild, as a line diff against the current profile. Nothing changes until it's accepted. */
function Proposal({ current, next, onAccept, onReject }: { current: string; next: string; onAccept: () => void; onReject: () => void }) {
  const parts = diffLines(current.trim() + '\n', next.trim() + '\n')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onAccept()
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') onReject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAccept, onReject])
  return (
    <div className="proposal">
      <div className="proposal-head">
        <span>Rebuilt profile</span>
        <span className="muted">Your rules are kept as they are.</span>
        <span className="spacer" />
        <button className="btn" onClick={onReject}>
          Keep current <kbd>⌘⌫</kbd>
        </button>
        <button className="btn primary" onClick={onAccept}>
          Use new <kbd>⌘↵</kbd>
        </button>
      </div>
      <div className="proposal-body">
        {parts.map((p, i) =>
          p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line, j) => (
              <div key={`${i}-${j}`} className={p.added ? 'vd-ins' : p.removed ? 'vd-del' : 'vd-same'}>
                {line || ' '}
              </div>
            )),
        )}
      </div>
    </div>
  )
}

/** The profile text, edited as Markdown. No help levels here: it's a note to the app. */
function ProfileEditor({ initial, onChange }: { initial: string; onChange: (body: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Voice profile' }),
          EditorView.updateListener.of((u) => u.docChanged && changeRef.current(u.state.doc.toString())),
        ],
      }),
    })
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="editor profile-editor" ref={host} />
}
