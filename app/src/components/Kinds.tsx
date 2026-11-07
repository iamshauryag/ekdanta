import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { DEFAULT_KINDS, doubledFolder, kindTaken, nameTakenBy, newKind, type Kind } from '../lib/kinds.ts'
import { isSpecialPath } from '../lib/special.ts'
import type { TemplateInfo } from '../lib/templates.ts'

interface Props {
  kinds: Kind[]
  onChange: (kinds: Kind[]) => void
  /** Move a kind's pieces out of a doubled-plural folder (yt-scriptses/) into its proper one. */
  onRenameFolder?: (id: string) => Promise<void>
}

/** Settings · Kinds: the kinds of writing, each with its folder, typical length and how it should read. */
export function Kinds({ kinds, onChange, onRenameFolder }: Props) {
  const [draft, setDraft] = useState('')
  // The singular the writer chose themselves, when the one worked out from the name isn't right.
  const [named, setNamed] = useState<string | null>(null)
  const [removed, setRemoved] = useState<{ kind: Kind; at: number } | null>(null)
  // A rename that would collide with another kind: the old name stays, and this says why.
  const [renameClash, setRenameClash] = useState<{ id: string; name: string } | null>(null)
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null)
  const [seeded, setSeeded] = useState<string | null>(null)
  useEffect(() => {
    api
      .templates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])
  const seed = async () => {
    const { added } = await api.seedTemplates()
    setSeeded(added.length ? `Added ${added.length} template${added.length === 1 ? '' : 's'} to templates/.` : 'The starter templates are already in templates/.')
    setTemplates(await api.templates())
    window.dispatchEvent(new Event('ekdanta:templates'))
  }
  const missing = DEFAULT_KINDS.filter((d) => !kinds.some((k) => k.id === d.id))

  // What Add would make, or why it can't: the same rules as newKind, shown before the writer commits.
  const typed = draft.trim()
  const clash = typed ? kinds.find((k) => kindTaken([k], typed)) : undefined
  const made = typed && !clash ? newKind(typed, kinds) : null
  const name = named?.trim() || made?.name || ''
  const nameClash = made && named?.trim() ? kinds.find((k) => kindTaken([k], named)) : undefined
  const kind = made && !nameClash ? { ...made, name } : null
  const why = !typed ? '' : clash ? `You already have ${clash.name}` : nameClash ? `You already have ${nameClash.name}` : !made ? 'Give it a name with at least one letter' : ''

  const edit = (id: string, patch: Partial<Kind>) => onChange(kinds.map((k) => (k.id === id ? { ...k, ...patch } : k)))
  /**
   * Rename a kind, unless another kind already answers to that name (singular or plural): two kinds
   * with one name would read the same everywhere and make "taken" checks lie. The box goes back to
   * the saved name and the row says which kind has it.
   */
  const rename = (kind: Kind, box: HTMLInputElement) => {
    const next = box.value.trim()
    if (!next || next === kind.name) return
    const other = nameTakenBy(kinds, kind.id, next)
    if (other) {
      box.value = kind.name
      setRenameClash({ id: kind.id, name: other.name })
      return
    }
    setRenameClash(null)
    edit(kind.id, { name: next })
  }
  const type = (value: string) => {
    setDraft(value)
    setNamed(null)
  }
  const commit = () => {
    if (!kind) return
    onChange([...kinds, kind])
    type('')
    setRemoved(null)
  }
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    commit()
  }
  const remove = (kind: Kind) => {
    setRemoved({ kind, at: kinds.indexOf(kind) })
    onChange(kinds.filter((k) => k !== kind))
  }
  const undo = () => {
    if (!removed) return
    onChange([...kinds.slice(0, removed.at), removed.kind, ...kinds.slice(removed.at)])
    setRemoved(null)
  }
  const move = (i: number, by: number) => {
    const next = [...kinds]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onChange(next)
  }

  return (
    <>
      <form className="kind-add" onSubmit={add}>
        <input className="kind-input" value={draft} onChange={(e) => type(e.target.value)} placeholder="Add a kind: YT script, Letter, Speech…" aria-label="New kind of writing" maxLength={40} />
        <button className="btn" disabled={!kind} title={why || undefined}>
          Add
        </button>
      </form>
      {typed && (
        <p className="kind-preview" aria-live="polite">
          {why ? (
            <span className="muted">{why}</span>
          ) : (
            made && (
              <>
                Kind:{' '}
                {named === null ? (
                  <button type="button" className="kind-singular" title="Not quite right? Change how one piece is called" onClick={() => setNamed(name)}>
                    {name}
                  </button>
                ) : (
                  <input
                    className="kind-input kind-singular-input"
                    value={named}
                    autoFocus
                    maxLength={40}
                    aria-label="One piece of this kind is called"
                    onChange={(e) => setNamed(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setNamed(null)
                      }
                      // The box sits outside the Add form, so Enter has to add the kind itself.
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commit()
                      }
                    }}
                  />
                )}{' '}
                · new pieces go in <code>{made.folder}/</code>
              </>
            )
          )}
        </p>
      )}
      {removed && (
        <p className="sheet-note kind-removed">
          Removed {removed.kind.name}. Its pieces keep their kind, and come back with it if you add it again.{' '}
          <button className="link-btn" onClick={undo}>
            Undo
          </button>
        </p>
      )}

      <ul className="kinds">
        {kinds.map((k, i) => (
          <li key={k.id} className="kind">
            <div className="kind-head">
              <input
                // Keyed by the name too, so a name the app tidied ("YT Scripts" → "YT script") shows as saved.
                key={k.name}
                className="kind-input kind-name"
                defaultValue={k.name}
                aria-label="Name"
                maxLength={40}
                onBlur={(e) => rename(k, e.target)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onInput={renameClash?.id === k.id ? () => setRenameClash(null) : undefined}
                aria-describedby={renameClash?.id === k.id ? `kind-taken-${k.id}` : undefined}
              />
              <label className="kind-words" title="A typical length, shown beside the word count">
                ~
                <input
                  className="kind-input"
                  type="number"
                  min={1}
                  max={50000}
                  defaultValue={k.words}
                  aria-label="Typical length in words"
                  onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== k.words && edit(k.id, { words: Math.round(Number(e.target.value)) })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                words
              </label>
              <span className="kind-tools">
                <button className="icon-btn small" title="Move up" aria-label={`Move ${k.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon-btn small" title="Move down" aria-label={`Move ${k.name} down`} disabled={i === kinds.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="icon-btn small" title="Remove" aria-label={`Remove ${k.name}`} disabled={kinds.length === 1} onClick={() => remove(k)}>
                  ✕
                </button>
              </span>
            </div>
            {renameClash?.id === k.id && (
              <p className="sheet-note kind-name-taken" id={`kind-taken-${k.id}`} role="status">
                You already have {renameClash.name}, so this kept its name.
              </p>
            )}
            <textarea
              className="kind-input kind-guidance"
              defaultValue={k.guidance}
              rows={2}
              maxLength={400}
              placeholder="How it should read, for the help levels: a hook in the first ten seconds, spoken rhythm, short lines…"
              aria-label={`How a ${k.name} should read`}
              onBlur={(e) => e.target.value.trim() !== k.guidance && edit(k.id, { guidance: e.target.value.trim() })}
            />
            <small className="kind-folder">
              New pieces go in <code>{k.folder}/</code>
              {isSpecialPath(k.folder) && <>, a folder Recall and voice leave out (pieces you star still shape your voice)</>}
              {!!templates?.length && <TemplateSelect kind={k} templates={templates} onChange={(template) => edit(k.id, { template })} />}
            </small>
            {onRenameFolder && <FolderFix kind={k} onRename={onRenameFolder} />}
          </li>
        ))}
      </ul>

      {missing.length > 0 && (
        <button className="link-btn" onClick={() => onChange([...kinds, ...missing])}>
          Bring back {missing.map((m) => m.name).join(', ')}
        </button>
      )}

      <h3>Templates</h3>
      <p className="sheet-note">
        Templates are Markdown files in <code>templates/</code>, with prompts that give a new piece its structure. Edit them like any page.{' '}
        {templates && (templates.length ? `You have ${templates.length}.` : 'You have none yet.')}
      </p>
      <div className="kind-templates">
        <button className="btn" onClick={seed}>
          Add starter templates
        </button>
        <span className="muted">Academic essay, research paper, lab report, LinkedIn post, YouTube script and more. Files already there are kept.</span>
      </div>
      {seeded && <p className="sheet-note kind-seeded">{seeded}</p>}
    </>
  )
}

/**
 * A kind saved before the word rules may file into a doubled plural (yt-scriptses/). When that folder
 * already holds pieces, nothing moves until the writer says so: one button renames it, pieces,
 * history and links included.
 */
function FolderFix({ kind, onRename }: { kind: Kind; onRename: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const to = doubledFolder(kind)
  if (!to) return null
  const rename = () => {
    setBusy(true)
    setError('')
    onRename(kind.id)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <small className="kind-folder kind-folder-fix">
      Folder <code>{kind.folder}/</code> →{' '}
      <button className="link-btn" disabled={busy} onClick={rename} title={`Move its pieces, with their history and links, into ${to}/`}>
        {busy ? 'Renaming…' : `Rename to ${to}/`}
      </button>
      {error && <span className="kind-folder-error"> {error}</span>}
    </small>
  )
}

/** A kind's default template: highlighted on its new drafts, so ↵ starts from it. */
function TemplateSelect({ kind, templates, onChange }: { kind: Kind; templates: TemplateInfo[]; onChange: (template: string | undefined) => void }) {
  const mine = templates.filter((t) => t.kind === kind.id)
  const others = templates.filter((t) => t.kind !== kind.id)
  const gone = kind.template && !templates.some((t) => t.path === kind.template)
  return (
    <label className="kind-template" title="Highlighted under a new draft of this kind, so ↵ starts from it">
      · start from
      <select value={kind.template ?? ''} onChange={(e) => onChange(e.target.value || undefined)} aria-label={`Default template for ${kind.name}`}>
        <option value="">None (start blank)</option>
        {gone && <option value={kind.template}>{kind.template} (not found)</option>}
        {mine.map((t) => (
          <option key={t.path} value={t.path}>
            {t.name}
          </option>
        ))}
        {others.length > 0 && (
          <optgroup label="Other templates">
            {others.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}
