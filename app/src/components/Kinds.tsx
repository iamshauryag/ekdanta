import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { doubledFolder, folderForName, kindTaken, nameTakenBy, newKind, notesMove, suggestedKinds, type Kind, type KindDoc } from '../lib/kinds.ts'
import type { TemplateInfo } from '../lib/templates.ts'
import { PAPER, STYLES, type DocStyle, type Paper } from '../lib/docstyle.ts'
import { parseTarget } from '../lib/targets.ts'

/** Offered, not built in: an essay handed in for a class, in MLA on the page. */
const ACADEMIC = {
  name: 'Academic essay',
  guidance: 'formal and argued: a clear thesis, evidence from sources, cited as you go',
  words: 1500,
  doc: { layout: 'page', style: 'mla', target: '1500' } as KindDoc,
}

interface Props {
  kinds: Kind[]
  onChange: (kinds: Kind[]) => void
  /** Move a kind's pieces out of a doubled-plural folder (yt-scriptses/) into its proper one. */
  onRenameFolder?: (id: string) => Promise<void>
  /** Rename a kind, and so its folder (its notes move with it). */
  onRename?: (id: string, name: string) => Promise<void>
  /** Remove a kind, and so its folder: refused unless the folder is empty. */
  onRemove?: (id: string) => Promise<void>
  /** How many notes a folder holds, for saying what a rename moves. */
  countIn?: (folder: string) => number
}

/** Settings · Kinds: the kinds of writing, each with its folder, typical length and how it should read. */
export function Kinds({ kinds, onChange, onRenameFolder, onRename, onRemove, countIn }: Props) {
  const [draft, setDraft] = useState('')
  // The singular the writer chose themselves, when the one worked out from the name isn't right.
  const [named, setNamed] = useState<string | null>(null)
  const [removed, setRemoved] = useState<{ kind: Kind; at: number } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [docFor, setDocFor] = useState<string | null>(null)
  // A rename that would collide with another kind: the old name stays, and this says why.
  const [renameClash, setRenameClash] = useState<{ id: string; name: string; error?: string } | null>(null)
  // A rename waiting for the writer's yes: it moves the kind's folder, and every note in it.
  const [asking, setAsking] = useState<{ kind: Kind; name: string; folder: string } | null>(null)
  const [removeRefused, setRemoveRefused] = useState<{ id: string; message: string } | null>(null)
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
  const missing = suggestedKinds(kinds)

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
    if (!onRename) return edit(kind.id, { name: next })
    // A kind is its folder, so the folder is renamed too, notes and all: the box keeps the saved name, and the writer is asked first.
    box.value = kind.name
    const folder = folderForName(next, kind.folder)
    if (folder === kind.folder) return void onRename(kind.id, next).catch((e: Error) => setRenameClash({ id: kind.id, name: '', error: e.message }))
    setAsking({ kind, name: next, folder })
  }
  const confirmRename = () => {
    if (!asking || !onRename) return
    const { kind, name } = asking
    setAsking(null)
    onRename(kind.id, name).catch((e: Error) => setRenameClash({ id: kind.id, name: '', error: e.message }))
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
    setRemoveRefused(null)
    const at = kinds.indexOf(kind)
    if (!onRemove) {
      setRemoved({ kind, at })
      return onChange(kinds.filter((k) => k !== kind))
    }
    onRemove(kind.id).then(
      () => setRemoved({ kind, at }),
      (e: Error) => setRemoveRefused({ id: kind.id, message: e.message }),
    )
  }
  const undo = () => {
    if (!removed) return
    onChange([...kinds.slice(0, removed.at), removed.kind, ...kinds.slice(removed.at)])
    setRemoved(null)
  }
  const addAcademic = () => {
    const kind = newKind(ACADEMIC.name, kinds)
    if (!kind) return
    onChange([...kinds, { ...kind, guidance: ACADEMIC.guidance, words: ACADEMIC.words, doc: ACADEMIC.doc }])
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
                · makes the folder <code>{made.folder}/</code>
              </>
            )
          )}
        </p>
      )}
      {removed && !kinds.some((k) => k.id === removed.kind.id) && (
        <p className="sheet-note kind-removed">
          Removed {removed.kind.name} and its empty folder, <code>{removed.kind.folder}/</code>. Its settings are kept, for if you add it again.{' '}
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
                <KindMenu
                  open={menuFor === k.id}
                  name={k.name}
                  onToggle={() => setMenuFor(menuFor === k.id ? null : k.id)}
                  onClose={() => setMenuFor(null)}
                  onDoc={() => setDocFor(docFor === k.id ? null : k.id)}
                />
                <button className="icon-btn small" title="Move up" aria-label={`Move ${k.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon-btn small" title="Move down" aria-label={`Move ${k.name} down`} disabled={i === kinds.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="icon-btn small" title="Remove (only when its folder is empty)" aria-label={`Remove ${k.name}`} onClick={() => remove(k)}>
                  ✕
                </button>
              </span>
            </div>
            {asking?.kind.id === k.id && (
              <p className="sheet-note kind-rename-ask" role="alertdialog" aria-label={`Rename ${k.name}`}>
                Rename the <code>{k.folder}/</code> folder to <code>{asking.folder}/</code>? {notesMove(countIn?.(k.folder))}{' '}
                <button className="link-btn" onClick={confirmRename}>
                  Rename
                </button>{' '}
                ·{' '}
                <button className="link-btn" onClick={() => setAsking(null)}>
                  Keep {k.name}
                </button>
              </p>
            )}
            {removeRefused?.id === k.id && (
              <p className="sheet-note kind-name-taken" role="status">
                {removeRefused.message}
              </p>
            )}
            {renameClash?.id === k.id && (
              <p className="sheet-note kind-name-taken" id={`kind-taken-${k.id}`} role="status">
                {renameClash.error ?? `You already have ${renameClash.name}, so this kept its name.`}
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
              Its folder: <code>{k.folder}/</code>
              {!!templates?.length && <TemplateSelect kind={k} templates={templates} onChange={(template) => edit(k.id, { template })} />}
            </small>
            {docFor === k.id ? (
              <KindDocEditor kind={k} onChange={(doc) => edit(k.id, { doc })} onDone={() => setDocFor(null)} />
            ) : (
              k.doc && (
                <small className="kind-folder kind-doc">
                  New pieces start with {docSummary(k.doc)}.{' '}
                  <button className="link-btn" onClick={() => setDocFor(k.id)}>
                    Change
                  </button>
                </small>
              )
            )}
            {onRenameFolder && <FolderFix kind={k} onRename={onRenameFolder} />}
          </li>
        ))}
      </ul>

      {!kinds.some((k) => k.id === 'academic-essay') && (
        <button className="btn kind-academic" onClick={addAcademic} title="A kind for essays handed in for a class: MLA, page view, 1,500 words">
          Add Academic essay kind
        </button>
      )}
      {missing.length > 0 && (
        <p className="sheet-note kind-suggestions">
          Add:{' '}
          {missing.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ' · '}
              <button className="link-btn" title={`Makes the folder ${m.folder}/`} onClick={() => onChange([...kinds, m])}>
                {m.name}
              </button>
            </span>
          ))}
        </p>
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

const styleName = (s: DocStyle) => STYLES.find((x) => x.id === s)?.label ?? s

/** "MLA · page view · target 1500 · A4". */
const docSummary = (d: KindDoc) => [d.style && styleName(d.style), d.layout === 'page' && 'page view', d.target && `target ${d.target}`, d.paper === 'a4' && 'A4'].filter(Boolean).join(' · ')

/** A kind's ⋯ menu. */
function KindMenu({ open, name, onToggle, onClose, onDoc }: { open: boolean; name: string; onToggle: () => void; onClose: () => void; onDoc: () => void }) {
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open, onClose])
  return (
    <span className="kind-more" ref={box}>
      <button className="icon-btn small" title="More" aria-label={`More for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              onClose()
              onDoc()
            }}
          >
            Document defaults…
          </button>
        </div>
      )}
    </span>
  )
}

/** How new pieces of a kind are laid out: page view, style, paper and a length target. Existing pieces keep their own. */
function KindDocEditor({ kind, onChange, onDone }: { kind: Kind; onChange: (doc: KindDoc | undefined) => void; onDone: () => void }) {
  const d = kind.doc ?? {}
  const set = (patch: Partial<KindDoc>) => {
    const next: KindDoc = { ...d, ...patch }
    for (const k of Object.keys(next) as (keyof KindDoc)[]) if (next[k] === undefined) delete next[k]
    onChange(Object.keys(next).length ? next : undefined)
  }
  const [target, setTarget] = useState(d.target ?? '')
  const bad = parseTarget(target) === 'invalid'
  return (
    <div className="kind-doc-editor" role="group" aria-label={`Document defaults for ${kind.name}`}>
      <div className="dm-row">
        <span className="dm-label">Page view</span>
        <button
          role="switch"
          aria-checked={d.layout === 'page'}
          aria-label="Page view"
          className={`switch${d.layout === 'page' ? ' is-on' : ''}`}
          onClick={() => set({ layout: d.layout === 'page' ? undefined : 'page' })}
        />
      </div>
      <div className="dm-row">
        <span className="dm-label">Style</span>
        <div className="seg seg-text" role="radiogroup" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} role="radio" aria-checked={d.style === s.id} className={d.style === s.id ? 'is-on' : ''} onClick={() => set({ style: d.style === s.id ? undefined : s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dm-row">
        <span className="dm-label">Paper</span>
        <div className="seg seg-text" role="radiogroup" aria-label="Paper">
          {(Object.keys(PAPER) as Paper[]).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={(d.paper ?? 'letter') === p}
              className={(d.paper ?? 'letter') === p ? 'is-on' : ''}
              onClick={() => set({ paper: p === 'letter' ? undefined : p })}
            >
              {PAPER[p].label}
            </button>
          ))}
        </div>
      </div>
      <label className="dm-field">
        <span>Target</span>
        <input
          className="dm-input"
          value={target}
          placeholder="1500, 1500–2000, ≤750, 5 pages"
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() => target.trim() !== (d.target ?? '') && set({ target: target.trim() || undefined })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {bad && <small className="dm-bad">Not understood. Try 1500, 1500-2000, &lt;=750 or 5 pages</small>}
      </label>
      <div className="kind-doc-foot">
        <small className="kind-folder">New {kind.name} pieces start with these; pieces you already have keep their own.</small>
        <button className="btn" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
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
